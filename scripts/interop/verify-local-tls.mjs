#!/usr/bin/env node
/**
 * Local-only certificate preflight for external MCP client smoke tests.
 *
 * The first TLS handshake reads only the presented certificate and sends no
 * HTTP/application data. A second handshake uses the explicitly expected
 * certificate as its trust anchor, but ONLY when SHA-256 pinning matched.
 * Do not use this script for public hosts or bearer-token transmission.
 */
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import tls from "node:tls";
import { pathToFileURL } from "node:url";

export const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
]);

export function parseArgs(argv) {
  const options = { host: "localhost", port: 8787, timeoutMs: 5000 };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (
      !value ||
      !["--host", "--port", "--cert", "--timeout-ms"].includes(flag)
    ) {
      throw new Error(
        "Usage: verify-local-tls.mjs --cert <public.pem> [--host localhost] [--port 8787]",
      );
    }
    if (flag === "--host") options.host = value;
    if (flag === "--cert") options.certPath = value;
    if (flag === "--port") options.port = Number(value);
    if (flag === "--timeout-ms") options.timeoutMs = Number(value);
  }
  if (!LOOPBACK_HOSTS.has(options.host)) {
    throw new Error("Only loopback hosts are allowed");
  }
  if (!options.certPath) {
    throw new Error("Expected public TLS certificate (--cert) is required");
  }
  if (
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535
  ) {
    throw new Error("Invalid TCP port");
  }
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 100 ||
    options.timeoutMs > 10000
  ) {
    throw new Error("Timeout must be between 100 and 10000 ms");
  }
  return options;
}

export function fingerprintsMatch(presented, expected) {
  return (
    typeof presented === "string" &&
    typeof expected === "string" &&
    presented.toUpperCase() === expected.toUpperCase()
  );
}

function readPeerCertificate({ host, port, timeoutMs }, expectedCert) {
  return new Promise((resolvePeer, rejectPeer) => {
    const socket = tls.connect({
      host: host === "[::1]" ? "::1" : host,
      port,
      servername: "localhost",
      rejectUnauthorized: expectedCert !== undefined,
      ...(expectedCert ? { ca: expectedCert } : {}),
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy(new Error("TLS_TIMEOUT"));
    });
    socket.once("secureConnect", () => {
      try {
        const presented = socket.getPeerCertificate(true);
        if (!presented?.raw) {
          throw new Error("TLS_NO_PEER_CERTIFICATE");
        }
        resolvePeer({
          fingerprint256: new X509Certificate(presented.raw).fingerprint256,
          issuer: presented.issuer?.O ?? "unknown",
        });
      } catch (error) {
        rejectPeer(error);
      } finally {
        socket.end();
      }
    });
    socket.once("error", rejectPeer);
  });
}

export async function verifyLocalTls(options) {
  const expectedCert = readFileSync(options.certPath);
  const expected = new X509Certificate(expectedCert).fingerprint256;
  // A diagnostic-only TLS handshake: inspect certificate, send NO HTTP data.
  const presented = await readPeerCertificate(options);
  if (!fingerprintsMatch(presented.fingerprint256, expected)) {
    return {
      status: "FAIL",
      code: "TLS_CERTIFICATE_SUBSTITUTED",
      expectedFingerprintSha256: expected,
      actualFingerprintSha256: presented.fingerprint256,
      peerIssuerOrganization: presented.issuer,
    };
  }
  // Only validate trust after the certificate has matched the pinned value.
  const validated = await readPeerCertificate(options, expectedCert);
  if (!fingerprintsMatch(validated.fingerprint256, expected)) {
    return { status: "FAIL", code: "TLS_CERTIFICATE_CHANGED_AFTER_PIN_CHECK" };
  }
  return { status: "PASS", code: "TLS_PIN_AND_CHAIN_VALIDATED" };
}

async function main() {
  try {
    const result = await verifyLocalTls(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result));
    if (result.status !== "PASS") process.exitCode = 2;
  } catch (error) {
    console.error(
      JSON.stringify({
        status: "FAIL",
        code: "TLS_PREFLIGHT_ERROR",
        message: error instanceof Error ? error.message : "Unexpected error",
      }),
    );
    process.exitCode = 3;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
