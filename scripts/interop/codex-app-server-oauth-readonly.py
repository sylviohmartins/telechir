#!/usr/bin/env python3
"""Call Telechir MCP via an official Codex app-server using its OWN stored
OAuth credential from 'codex mcp login' (no bearer token injection).

Two executions: positive for one prelinked device; then disabled user denied.
No AI API, ChatGPT login, model inference, real user or production state.
"""
import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

VERSION = "0.162.0"
ALIAS = "telechir_ci"

def expect(condition, label):
    if not condition:
        raise RuntimeError(label)

def main():
    expect(len(sys.argv) == 4, "expected private temp root, linked device file, scenario")
    root = Path(sys.argv[1]).resolve()
    device_path = Path(sys.argv[2]).resolve()
    scenario = sys.argv[3]
    expect(scenario in {"read", "disabled"}, "unrecognized scenario")
    expect(device_path.is_file() and device_path.is_relative_to(root),
           "device fixture outside private CI temp root")
    expected_device = device_path.read_text().strip()
    oauth_home = root / "codex-interactive"
    expect((oauth_home / "config.toml").exists(), "missing official Codex MCP config")
    dual_ca = root / "codex-oauth-dual-ca.crt"
    expect(dual_ca.exists(), "missing pinned ephemeral CA bundle")
    env = dict(os.environ)
    for key in ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN",
                "PHASE16_CODEX_BEARER", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
                "http_proxy", "https_proxy", "all_proxy"]:
        env.pop(key, None)
    env.update({
        "CODEX_HOME": str(oauth_home),
        "HOME": str(oauth_home),
        "CODEX_CA_CERTIFICATE": str(dual_ca),
        "SSL_CERT_FILE": str(dual_ca),
        "CURL_CA_BUNDLE": str(dual_ca),
        "NODE_EXTRA_CA_CERTS": str(dual_ca),
        "CODEX_DISABLE_TELEMETRY": "1",
        "NO_PROXY": "127.0.0.1,localhost",
        "no_proxy": "127.0.0.1,localhost",
    })
    received = queue.Queue()
    with open(root / ("codex-oauth-" + scenario + ".stderr"),
              "w", encoding="utf8") as diagnostic:
        proc = subprocess.Popen(
            ["npx", "--yes", f"@openai/codex@{VERSION}", "app-server"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=diagnostic, text=True, bufsize=1, env=env, cwd=root)
        expect(proc.stdin is not None and proc.stdout is not None, "Codex missing stdio")
        def read_stdout():
            for line in proc.stdout:
                try:
                    item = json.loads(line)
                    if isinstance(item, dict):
                        received.put(item)
                except json.JSONDecodeError:
                    pass
        thread = threading.Thread(target=read_stdout, daemon=True)
        thread.start()
        counter = 0
        def send(data):
            expect(proc.poll() is None, "Codex exited unexpectedly")
            proc.stdin.write(json.dumps(data, separators=(",", ":")) + "\n")
            proc.stdin.flush()
        def request(method, params, timeout=65):
            nonlocal counter
            counter += 1
            current = counter
            send({"id": current, "method": method, "params": params})
            limit = time.monotonic() + timeout
            while time.monotonic() < limit:
                try:
                    item = received.get(timeout=0.3)
                except queue.Empty:
                    expect(proc.poll() is None, "Codex exited during MCP request")
                    continue
                if item.get("id") != current:
                    continue
                if "error" in item:
                    # Raw error can contain secrets. Keep only booleans.
                    error = str(item["error"].get("message", "")) if isinstance(item["error"], dict) else ""
                    lowered = error.lower()
                    return {"_rejected": True,
                            "_auth": any(m in lowered for m in
                                         ("401", "unauthorized", "authentication",
                                          "invalid_token", "auth required", "disabled")),
                            "_other": any(m in lowered for m in
                                          ("unknown tool", "no such server",
                                           "certificate", "unknown issuer"))}
                expect(isinstance(item.get("result"), dict), "Codex MCP result missing")
                return item["result"]
            raise RuntimeError("Codex MCP request timeout")
        try:
            started = request("initialize", {
                "clientInfo": {"name": "telechir-oauth-codex-ci",
                               "title": "Codex CI OAuth", "version": "1.0"},
                "capabilities": {"experimentalApi": True, "requestAttestation": False}})
            expect(not started.get("_rejected"), "Codex app-server init rejected")
            send({"method": "initialized"})
            thread_result = request("thread/start", {
                "cwd": str(root), "ephemeral": True})
            thread_id = thread_result.get("thread", {}).get("id")
            expect(bool(thread_id), "Codex thread ID absent")
            result = request("mcpServer/tool/call", {
                "threadId": thread_id, "server": ALIAS,
                "tool": "list_devices", "arguments": {"status": "all"},
            }, timeout=90)
            if scenario == "read":
                expect(not result.get("_rejected"), "stored OAuth token rejected at MCP")
                expect(result.get("isError") is not True, "MCP returned tool failure")
                values = result.get("structuredContent", {}).get("devices")
                expect(isinstance(values, list) and len(values) == 1 and
                       values[0].get("device_id") == expected_device,
                       "Codex OAuth MCP exposed wrong device set")
                print("RESULT: KEYCLOAK_CODEX_OAUTH_APP_SERVER_DEVICE_READ_PASS", flush=True)
            else:
                if result.get("_rejected"):
                    expect(result.get("_auth") and not result.get("_other"),
                           "Codex disabled-user error was not auth rejection")
                else:
                    expect(result.get("isError") is True, "disabled user tool unexpectedly succeeded")
                    serialized = json.dumps(result).lower()
                    expect(any(x in serialized for x in
                               ("401", "unauthorized", "invalid_token", "auth required")),
                           "disabled user tool missing authorization failure")
                print("RESULT: KEYCLOAK_CODEX_OAUTH_APP_SERVER_DISABLED_USER_PASS", flush=True)
        finally:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=6)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=4)

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # The error message comes only from this runner's static assertions.
        print(f"FAIL: official Codex stored OAuth MCP proof: {type(e).__name__} - {e}",
              file=sys.stderr, flush=True)
        raise SystemExit(1)
