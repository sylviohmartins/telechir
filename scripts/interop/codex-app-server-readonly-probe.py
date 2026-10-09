#!/usr/bin/env python3
"""Phase 16: official Codex app-server -> authenticated Telechir MCP read-only call.

Real Codex CLI process, no Codex account, OpenAI API key, or LLM inference.
Protocol follows the Codex upstream MCP conformance app-server approach:
  initialize, initialized, thread/start (ephemeral), mcpServer/tool/call.
The private bearer token never enters command-line arguments or logs.
"""
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

VERSION = "0.162.0"
SERVER = "telechir_fixture"


class AppServerError(RuntimeError):
    pass


class CodexToolCallRejected(AppServerError):
    """Private raw error retained only for matching auth/scope fail-closed."""

    def __init__(self, code, raw, category):
        super().__init__(
            f"Codex MCP tool rejected: code={code}, category={category}"
        )
        self.raw = raw
        self.code = code


def check(condition, message):
    if not condition:
        raise AppServerError(message)


def main():
    if len(sys.argv) not in (5, 6):
        raise AppServerError(
            "expected ephemeral dir, MCP URL, CA cert, device-id and optional scenario"
        )
    root = Path(sys.argv[1]).resolve()
    url, certificate, device_file = sys.argv[2:5]
    scenario = sys.argv[5] if len(sys.argv) == 6 else "read"
    allowed_scenarios = {
        "read", "no-token", "wrong-audience", "malformed", "write-denied",
    }
    check(scenario in allowed_scenarios, "unsupported Codex test scenario")
    check(url == "https://127.0.0.1:8988/mcp", "unexpected non-isolated MCP URL")
    cert = Path(certificate).resolve()
    check(cert.is_file() and cert.is_relative_to(root), "ephemeral TLS cert missing")
    check(Path(device_file).resolve().is_relative_to(root), "invalid device file")
    expected_device = Path(device_file).read_text().strip()
    token_file = (
        "wrong-audience.token" if scenario == "wrong-audience" else "valid.token"
    )
    token = (root / token_file).read_text().strip()
    check(bool(re.fullmatch(r"eyJ[A-Za-z0-9._-]+", token)), "invalid ephemeral JWT fixture")
    if scenario == "malformed":
        token = "malformed.jwt.not-signed"
    if scenario == "no-token":
        token = ""

    # A new isolated client profile for each scenario avoids any cached
    # session/auth state leaking from successful reads to negative probes.
    codex_home = root / f"codex-home-{scenario}"
    codex_home.mkdir(mode=0o700, exist_ok=True)
    codex_config = (
        f"[mcp_servers.{SERVER}]\n"
        f"url = \"{url}\"\n"
        "bearer_token_env_var = \"PHASE16_CODEX_BEARER\"\n"
        "startup_timeout_sec = 20\n"
        "tool_timeout_sec = 20\n"
    )
    config = codex_home / "config.toml"
    config.write_text(codex_config, encoding="utf8")
    config.chmod(0o600)

    env = dict(os.environ)
    for key in (
        "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN",
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
        "http_proxy", "https_proxy", "all_proxy",
    ):
        env.pop(key, None)
    env.update({
        "CODEX_HOME": str(codex_home),
        "HOME": str(root / "codex-user"),
        "SSL_CERT_FILE": str(cert),
        "CODEX_CA_CERTIFICATE": str(cert),
        "CURL_CA_BUNDLE": str(cert),
        "NODE_EXTRA_CA_CERTS": str(cert),
        "NO_PROXY": "127.0.0.1,localhost",
        "no_proxy": "127.0.0.1,localhost",
        "CODEX_DISABLE_TELEMETRY": "1",
    })
    if scenario == "no-token":
        env.pop("PHASE16_CODEX_BEARER", None)
    else:
        env["PHASE16_CODEX_BEARER"] = token
    Path(env["HOME"]).mkdir(mode=0o700, exist_ok=True)
    messages = queue.Queue()
    stopped = threading.Event()

    def stdout_reader(stream):
        try:
            for line in stream:
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(value, dict):
                    messages.put(value)
        finally:
            stopped.set()

    # Installation and all app-server stderr are private, never forwarded:
    # either could include sensitive third-party diagnostics.
    with open(root / f"codex-app-server-{scenario}.stderr", "w", encoding="utf8") as err:
        process = subprocess.Popen(
            ["npx", "--yes", f"@openai/codex@{VERSION}", "app-server"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=err,
            text=True,
            bufsize=1,
            env=env,
            cwd=root,
        )
        check(process.stdin is not None and process.stdout is not None, "missing stdio")
        reader = threading.Thread(target=stdout_reader, args=(process.stdout,), daemon=True)
        reader.start()
        next_id = 0

        def send(message):
            if process.poll() is not None:
                raise AppServerError("Codex app-server stopped unexpectedly")
            process.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
            process.stdin.flush()

        def request(method, params, seconds=65):
            nonlocal next_id
            next_id += 1
            rid = next_id
            send({"id": rid, "method": method, "params": params})
            limit = time.monotonic() + seconds
            while time.monotonic() < limit:
                try:
                    message = messages.get(timeout=min(0.4, max(0.01, limit - time.monotonic())))
                except queue.Empty:
                    if stopped.is_set() or process.poll() is not None:
                        raise AppServerError(f"Codex app-server exited during {method}")
                    continue
                if message.get("id") != rid:
                    # Ignore unrelated notifications; never leak their payloads.
                    continue
                if "error" in message:
                    error = message["error"]
                    code = error.get("code") if isinstance(error, dict) else "unknown"
                    raw = str(error.get("message", "")) if isinstance(error, dict) else ""
                    lowered = raw.lower()
                    # Classification only: raw vendor diagnostics can contain
                    # config paths, Authorization details or ephemeral tokens.
                    categories = {
                        "unknown_server": ("unknown mcp server", "server not found", "no such server"),
                        "unknown_tool": ("unknown tool", "tool not found", "not available"),
                        "tls": ("certificate", "tls", "ssl", "unknown issuer"),
                        "authorization": ("unauthorized", "authentication", "auth required", "permission", "401", "403"),
                        "connection": ("connect", "dns", "transport", "network"),
                        "initialization": ("initialize", "handshake", "start up", "startup"),
                    }
                    category = next(
                        (name for name, needles in categories.items()
                         if any(needle in lowered for needle in needles)),
                        "unclassified",
                    )
                    # The Codex process has no real user credentials. Even so,
                    # scrub the synthetic JWT, bearer headers, private paths,
                    # and very long opaque strings before diagnostic output.
                    detail = (
                        raw.replace(token, "[SYNTHETIC_JWT_REDACTED]")
                        if token else raw
                    )
                    detail = detail.replace(str(root), "[EPHEMERAL_DIR]")
                    detail = detail.replace(
                        "Bearer " + token, "Bearer [REDACTED]"
                    )
                    detail = re.sub(
                        r"[A-Za-z0-9_-]{110,}", "[OPAQUE_REDACTED]", detail
                    )
                    detail = " ".join(detail.split())
                    if len(detail) > 900:
                        detail = detail[:160] + " [TRUNCATED] " + detail[-720:]
                    print(f"DIAG: Codex sanitized MCP error: {detail}", flush=True)
                    if method == "mcpServer/tool/call" and scenario != "read":
                        # The negative assertion below must verify this is an
                        # authorization or scope rejection, not TLS or unknown tool.
                        raise CodexToolCallRejected(code, raw, category)
                    raise AppServerError(
                        f"Codex {method} returned protocol error {code}, category={category}"
                    )
                result = message.get("result")
                check(isinstance(result, dict), f"Codex {method} missing result object")
                return result
            raise AppServerError(f"Codex {method} timed out")

        try:
            initialized = request("initialize", {
                "clientInfo": {
                    "name": "telechir-phase16-ci",
                    "title": "Telechir CI only",
                    "version": "1.0.0",
                },
                "capabilities": {
                    "experimentalApi": True,
                    "requestAttestation": False,
                },
            })
            check(bool(initialized), "Codex initialize empty")
            send({"method": "initialized"})
            print(f"PASS: official Codex CLI {VERSION} app-server initialized without model credentials")

            thread = request("thread/start", {
                "cwd": str(root),
                "ephemeral": True,
            })
            thread_id = thread.get("thread", {}).get("id")
            check(isinstance(thread_id, str) and thread_id, "Codex ephemeral thread missing")
            print("PASS: Codex app-server ephemeral thread created")

            # Runtime status (not CLI configuration listing) can expose
            # server initialization failures before direct tool dispatch.
            try:
                inventory = request("mcpServerStatus/list", {
                    "threadId": thread_id,
                }, seconds=40)
                records = inventory.get("data", [])
                if isinstance(records, list):
                    configured = any(
                        isinstance(row, dict)
                        and (row.get("name") == SERVER or row.get("serverName") == SERVER)
                        for row in records
                    )
                    print(
                        "DIAG: Codex runtime MCP status list count="
                        f"{len(records)}, fixture_present={str(configured).lower()}"
                    )
            except AppServerError as exc:
                print(f"DIAG: Codex runtime MCP status query failed: {exc}")

            tool = "write_file" if scenario == "write-denied" else "list_devices"
            arguments = {} if scenario == "write-denied" else {"status": "all"}
            try:
                result = request("mcpServer/tool/call", {
                    "threadId": thread_id,
                    "server": SERVER,
                    "tool": tool,
                    "arguments": arguments,
                }, seconds=80)
            except CodexToolCallRejected as rejected:
                if scenario == "read":
                    raise
                lowered = rejected.raw.lower()
                if scenario == "write-denied":
                    # Insufficient scope must be distinguishable from malformed
                    # tool args, missing tool or transport failure.
                    auth_markers = ("403", "forbidden", "insufficient_scope",
                                    "insufficient scope", "telechir:files:write")
                elif scenario == "no-token":
                    # Absence may fail in Codex itself before HTTP dispatch.
                    auth_markers = (
                        "environment variable", "missing bearer", "auth required",
                        "authorization required", "401", "unauthorized",
                    )
                else:
                    # An invalid *provided* token must elicit explicit auth
                    # rejection; generic config/token text is insufficient.
                    auth_markers = (
                        "401", "unauthorized", "unauthenticated",
                        "invalid_token", "auth required",
                        "authorization required",
                    )
                check(
                    any(marker in lowered for marker in auth_markers),
                    f"Codex {scenario} rejected for an unclassified reason",
                )
                print(
                    f"PASS: Codex {scenario} tool call denied as expected; "
                    "no successful MCP tool result"
                )
                print(f"RESULT: CODEX_AUTH_BOUNDARY_{scenario.upper().replace('-', '_')}_PASS")
                return

            if scenario != "read":
                # Some MCP clients encapsulate HTTP permission denial as a
                # tool-level isError result instead of JSON-RPC protocol error.
                check(
                    result.get("isError") is True,
                    f"Codex {scenario} unexpectedly succeeded (fail-open)",
                )
                encoded = json.dumps(result, ensure_ascii=False).lower()
                markers = (
                    ("403", "forbidden", "insufficient_scope",
                     "insufficient scope", "telechir:files:write")
                    if scenario == "write-denied"
                    else (
                        ("environment variable", "401", "unauthorized",
                         "auth required", "missing bearer")
                        if scenario == "no-token"
                        else ("401", "unauthorized", "invalid_token",
                              "auth required", "unauthenticated")
                    )
                )
                check(
                    any(marker in encoded for marker in markers),
                    f"Codex {scenario} tool error lacks auth/scope evidence",
                )
                print(f"PASS: Codex {scenario} denied via MCP tool isError")
                print(f"RESULT: CODEX_AUTH_BOUNDARY_{scenario.upper().replace('-', '_')}_PASS")
                return

            check(result.get("isError") is not True, "Codex MCP tool returned isError")
            structured = result.get("structuredContent")
            check(isinstance(structured, dict), "missing MCP structuredContent")
            devices = structured.get("devices")
            check(isinstance(devices, list), "MCP read did not contain a device list")
            check(
                len(devices) == 1
                and isinstance(devices[0], dict)
                and devices[0].get("device_id") == expected_device,
                "Codex MCP read did not return exactly the seeded synthetic device",
            )
            print("PASS: real Codex app-server called Telechir list_devices over authenticated HTTPS")
            print("RESULT: CODEX_APP_SERVER_AUTHENTICATED_READONLY_TOOL_PASS")
            print("NOTE: direct Codex app-server tool dispatch, no model inference, real IdP or PKCE login")
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=4)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)


if __name__ == "__main__":
    try:
        main()
    except (AppServerError, OSError, subprocess.SubprocessError) as exc:
        # Messages are intentionally constant/class-only; no bearer or raw stderr.
        print(f"FAIL: Codex app-server integration: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
