#!/usr/bin/env bash
# Phase 16 official Codex app-server direct MCP list_devices test.
# Called by authenticated inspector smoke with pinned TLS and synthetic D1.
set -euo pipefail
command -v python3 >/dev/null || {
  echo "FAIL: Python 3 unavailable for Codex app-server JSONL" >&2
  exit 1
}
# Codex uses its own custom CA bundle parameter, rather than Node trust.
# The subprocess sets CODEX_CA_CERTIFICATE only for its own lifetime.
# No global Linux CA installation and no TLS verification bypass.
# A successful read first proves transport, identity and TLS work before
# evaluating negative outcomes (otherwise an outage could masquerade as denial).
# Each scenario has a new process, ephemeral thread and separate CODEX_HOME.
for scenario in read no-token wrong-audience malformed write-denied expired; do
  timeout 180s python3 "$repo_root/scripts/interop/codex-app-server-readonly-probe.py" \
    "$work_dir" "$url" "$ca_cert" "$work_dir/device-id" "$scenario"
done

# A single genuine Codex process reads the device successfully, then waits.
# Disable the synthetic linked user in persistent D1 while the same MCP
# client/thread remains alive. A second tool call must be denied. No token
# mutation, model inference, real customer or production database involved.
timeout 180s python3 "$repo_root/scripts/interop/codex-app-server-readonly-probe.py" \
  "$work_dir" "$url" "$ca_cert" "$work_dir/device-id" "live-user-disable" \
  >"$work_dir/codex-live.out" 2>"$work_dir/codex-live.err" &
live_pid=$!
ready_file="$work_dir/codex-live-before-disable.ready"
for _ in $(seq 1 250); do
  [[ -f "$ready_file" ]] && break
  if ! kill -0 "$live_pid" 2>/dev/null; then
    echo "FAIL: Codex exited before positive read in live suspension probe" >&2
    exit 1
  fi
  sleep 0.2
done
[[ -f "$ready_file" ]] || {
  echo "FAIL: Codex did not complete live pre-disable read" >&2
  exit 1
}

user_id="$(cat "$work_dir/user-id")"
[[ "$user_id" =~ ^[0-9a-f-]{36}$ ]] || {
  echo "FAIL: synthetic fixture user ID invalid" >&2
  exit 1
}
printf "UPDATE users SET disabled_at = CURRENT_TIMESTAMP WHERE id = '%s' AND disabled_at IS NULL;\n" \
  "$user_id" >"$work_dir/disable-user.sql"

# Wrangler must use the exact D1 persisted by the already-running HTTPS
# Worker. A separate database or status-only mock cannot pass the live probe.
(
  cd "$repo_root/apps/control-plane"
  ./node_modules/.bin/wrangler d1 execute DB --local \
    --persist-to "$work_dir/state" --file "$work_dir/disable-user.sql" \
    >"$work_dir/disable-user-d1.log" 2>&1
) || {
  echo "FAIL: isolated synthetic D1 user could not be disabled" >&2
  exit 1
}
: >"$work_dir/codex-live-after-disable.go"
set +e
wait "$live_pid"
live_exit=$?
set -e
if [[ "$live_exit" -ne 0 ]]; then
  echo "FAIL: in-session Codex credential reuse was not denied" >&2
  # Script-emitted diagnostics are bounded and token-redacted.
  tail -n 8 "$work_dir/codex-live.out" >&2
  exit 1
fi
grep -Fxq "RESULT: CODEX_IN_SESSION_USER_DISABLED_PASS" \
  "$work_dir/codex-live.out" || {
  echo "FAIL: missing Codex live user-disable evidence" >&2
  exit 1
}
echo "RESULT: CODEX_IN_SESSION_USER_DISABLED_PASS"

# A NEW vendor client using exactly the SAME still-unexpired RS256 JWT must
# also fail, preventing session/cache reconnect from restoring access.
timeout 180s python3 "$repo_root/scripts/interop/codex-app-server-readonly-probe.py" \
  "$work_dir" "$url" "$ca_cert" "$work_dir/device-id" "disabled-user"
echo "RESULT: CODEX_DISABLED_USER_NEW_SESSION_PASS"
