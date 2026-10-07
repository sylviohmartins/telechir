import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";

const FORBIDDEN_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".localdomain",
  ".home.arpa",
];

export class NetworkPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "NetworkPolicyError";
    this.code = "POLICY_DENIED";
  }
}

export function isPublicAddress(
  address,
  { allowLoopbackForTest = false } = {},
) {
  const normalized = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const family = net.isIP(normalized);
  if (family === 4) {
    const octets = normalized.split(".").map(Number);
    const [a, b] = octets;
    if (allowLoopbackForTest && a === 127) {
      return true;
    }
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51) ||
      (a === 203 && b === 0) ||
      a >= 224
    ) {
      return false;
    }
    return true;
  }
  if (family === 6) {
    if (allowLoopbackForTest && normalized === "::1") {
      return true;
    }
    if (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("::ffff:") ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/u.test(normalized) ||
      normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8:") ||
      normalized.startsWith("2001:0:") ||
      normalized.startsWith("2002:")
    ) {
      return false;
    }
    const first = Number.parseInt(normalized.split(":")[0], 16);
    return Number.isInteger(first) && first >= 0x2000 && first <= 0x3fff;
  }
  return false;
}

export function validateUrlShape(raw, { allowLoopbackForTest = false } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new NetworkPolicyError("browser URL must be absolute");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new NetworkPolicyError("browser URL scheme is not allowed");
  }
  if (url.username || url.password) {
    throw new NetworkPolicyError("browser URLs cannot embed credentials");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (!host) {
    throw new NetworkPolicyError("browser URL host is required");
  }
  if (
    host === "localhost" ||
    FORBIDDEN_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    (!host.includes(".") && net.isIP(host) === 0)
  ) {
    throw new NetworkPolicyError("local or intranet hostnames are not allowed");
  }
  if (
    net.isIP(host) !== 0 &&
    !isPublicAddress(host, { allowLoopbackForTest })
  ) {
    throw new NetworkPolicyError("browser target address is not public");
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (
    !allowLoopbackForTest &&
    !(
      (url.protocol === "http:" && port === 80) ||
      (url.protocol === "https:" && port === 443)
    )
  ) {
    throw new NetworkPolicyError(
      "Phase 14 browser egress allows only ports 80 and 443",
    );
  }
  if (allowLoopbackForTest && (port < 1 || port > 65535)) {
    throw new NetworkPolicyError("browser URL port is invalid");
  }
  return { url, host, port };
}

export async function resolvePublicTarget(
  raw,
  { allowLoopbackForTest = false } = {},
) {
  const shaped = validateUrlShape(raw, { allowLoopbackForTest });
  const literalFamily = net.isIP(shaped.host);
  if (literalFamily) {
    if (!isPublicAddress(shaped.host, { allowLoopbackForTest })) {
      throw new NetworkPolicyError("browser target address is not public");
    }
    return { ...shaped, address: shaped.host, family: literalFamily };
  }

  let addresses;
  try {
    addresses = await dns.lookup(shaped.host, { all: true, verbatim: true });
  } catch {
    throw new NetworkPolicyError(
      "browser target hostname could not be resolved",
    );
  }
  if (!addresses.length) {
    throw new NetworkPolicyError("browser target hostname has no addresses");
  }
  if (
    addresses.some(
      ({ address }) => !isPublicAddress(address, { allowLoopbackForTest }),
    )
  ) {
    throw new NetworkPolicyError(
      "browser target hostname resolves to a non-public address",
    );
  }
  return {
    ...shaped,
    address: addresses[0].address,
    family: addresses[0].family,
  };
}

function sanitizedHeaders(headers, hostHeader) {
  const next = { ...headers, host: hostHeader };
  delete next["proxy-authorization"];
  delete next["proxy-connection"];
  return next;
}

export async function createEgressProxy({
  allowLoopbackForTest = false,
  connectTimeoutMs = 10_000,
} = {}) {
  const server = http.createServer(async (request, response) => {
    try {
      const target = await resolvePublicTarget(request.url, {
        allowLoopbackForTest,
      });
      if (target.url.protocol !== "http:") {
        throw new NetworkPolicyError("HTTPS traffic must use CONNECT");
      }
      const upstream = http.request({
        host: target.address,
        family: target.family,
        port: target.port,
        method: request.method,
        path: `${target.url.pathname}${target.url.search}`,
        headers: sanitizedHeaders(request.headers, target.url.host),
      });
      upstream.setTimeout(connectTimeoutMs, () => upstream.destroy());
      upstream.on("response", (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.headers,
        );
        upstreamResponse.pipe(response);
      });
      upstream.on("error", () => {
        if (!response.headersSent) {
          response.writeHead(502);
        }
        response.end();
      });
      request.pipe(upstream);
    } catch {
      response.writeHead(403, {
        "content-type": "text/plain; charset=utf-8",
        "x-telechir-policy-denied": "1",
      });
      response.end("blocked by Telechir browser egress policy");
    }
  });

  server.on("connect", async (request, clientSocket, head) => {
    try {
      const target = await resolvePublicTarget(`https://${request.url}`, {
        allowLoopbackForTest,
      });
      const upstream = net.connect({
        host: target.address,
        port: target.port,
        family: target.family,
      });
      const timer = setTimeout(() => upstream.destroy(), connectTimeoutMs);
      upstream.once("connect", () => {
        clearTimeout(timer);
        clientSocket.write(
          "HTTP/1.1 200 Connection Established\r\nProxy-Agent: Telechir\r\n\r\n",
        );
        if (head.length) {
          upstream.write(head);
        }
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => upstream.destroy());
    } catch {
      clientSocket.write(
        "HTTP/1.1 403 Forbidden\r\nX-Telechir-Policy-Denied: 1\r\n\r\n",
      );
      clientSocket.destroy();
    }
  });

  server.on("upgrade", (_request, socket) => {
    socket.write(
      "HTTP/1.1 403 Forbidden\r\nX-Telechir-Policy-Denied: 1\r\n\r\n",
    );
    socket.destroy();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to bind browser egress proxy");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
