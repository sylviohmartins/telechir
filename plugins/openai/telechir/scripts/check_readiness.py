#!/usr/bin/env python3
"""Check operator-supplied evidence for OpenAI external submission gates."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

REQUIRED_GATES = (
    "publisher_verified",
    "apps_permissions_ready",
    "listing_urls_public",
    "final_assets_ready",
    "production_mcp_deployed",
    "domain_verified",
    "oidc_openid_email_enabled",
    "userinfo_verified_email",
    "reviewer_demo_account_ready",
    "demo_recording_ready",
    "production_tool_scan_current",
)


class ReadinessError(ValueError):
    pass


def load(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ReadinessError(f"cannot read readiness JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise ReadinessError("readiness file must contain a JSON object")
    return value


def evaluate(value: dict[str, Any]) -> tuple[bool, list[str]]:
    missing = [gate for gate in REQUIRED_GATES if gate not in value]
    unknown = sorted(set(value) - set(REQUIRED_GATES))
    if missing:
        raise ReadinessError(f"missing readiness gates: {', '.join(missing)}")
    if unknown:
        raise ReadinessError(f"unknown readiness gates: {', '.join(unknown)}")

    pending: list[str] = []
    for gate in REQUIRED_GATES:
        entry = value[gate]
        if not isinstance(entry, dict):
            raise ReadinessError(f"{gate} must be an object")
        if set(entry) != {"complete", "evidence"}:
            raise ReadinessError(
                f"{gate} must contain exactly complete and evidence"
            )
        complete = entry["complete"]
        evidence = entry["evidence"]
        if not isinstance(complete, bool):
            raise ReadinessError(f"{gate}.complete must be boolean")
        if complete:
            if not isinstance(evidence, str) or not evidence.strip():
                raise ReadinessError(
                    f"{gate}.evidence is required when complete=true"
                )
        else:
            pending.append(gate)
    return not pending, pending


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Evaluate external OpenAI public-plugin submission gates."
    )
    parser.add_argument("readiness", type=Path)
    args = parser.parse_args()

    try:
        ready, pending = evaluate(load(args.readiness))
    except ReadinessError as exc:
        print(json.dumps({"status": "INVALID", "error": str(exc)}))
        return 2

    if not ready:
        print(
            json.dumps(
                {
                    "status": "EXTERNAL_GATES_PENDING",
                    "pending": pending,
                },
                indent=2,
            )
        )
        return 3

    print(json.dumps({"status": "SUBMISSION_READY", "pending": []}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
