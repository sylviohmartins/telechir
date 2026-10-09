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


def check(condition, message):
    if not condition:
        raise AppServerError(message)


def main():
    if len(sys.argv) != 5:
        raise AppServerError("expected ephemeral dir, MCP URL, cert and device-id file")
    root = Path(sys.argv[1]).resolve()
    url, certificate, device_file = sys.argv[2:]
    check(url == "https://127.0.0.1:8988/mcp", "unexpected non-isolated MCP URL")
    cert = Path(certificate).resolve()
    check(cert.is_file() and cert.is_relative_to(root), "ephemeral TLS cert missing")
    check(Path(device_file).resolve().is_relative_to(root), "invalid device file")
    expected_device = Path(device_file).read_text().strip()
    token = (root / "valid.token").read_text().strip()
    check(bool(re.fullmatch(r"eyJ[A-Za-z0-9._-]+", token)), "invalid ephemeral JWT fixture")

    codex_home = root / "codex-home"
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
    for key in ("OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"):
        env.pop(key, None)
    env.update({
        "CODEX_HOME": str(codex_home),
        "HOME": str(root / "codex-user"),
        "PHASE16_CODEX_BEARER": token,
        "SSL_CERT_FILE": str(cert),
        "CODEX_CA_CERTIFICATE": str(cert),
        "CURL_CA_BUNDLE": str(cert),
        "NODE_EXTRA_CA_CERTS": str(cert),
        "NO_PROXY": "127.0.0.1,localhost",
        "no_proxy": "127.0.0.1,localhost",
        "CODEX_DISABLE_TELEMETRY": "1",
    })
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
    with open(root / "codex-app-server.stderr", "w", encoding="utf8") as err:
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
                        "authorization": ("unauthorized", "authentication", "permission", "401", "403"),
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
                    detail = raw.replace(token, "[SYNTHETIC_JWT_REDACTED]")
                    detail = detail.replace(str(root), "[EPHEMERAL_DIR]")
                    detail = detail.replace(
                        "Bearer " + token, "Bearer [REDACTED]"
                    )
                    detail = re.sub(
                        r"[A-Za-z0-9_-]{110,}", "[OPAQUE_REDACTED]", detail
                    )
                    detail = " ".join(detail.split())[:450]
                    print(f"DIAG: Codex sanitized MCP error: {detail}", flush=True)
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

            result = request("mcpServer/tool/call", {
                "threadId": thread_id,
                "server": SERVER,
                "tool": "list_devices",
                "arguments": {"status": "all"},
            }, seconds=80)

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
