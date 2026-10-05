from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "build_package.py"
SPEC = importlib.util.spec_from_file_location("telechir_plugin_builder", MODULE_PATH)
assert SPEC and SPEC.loader
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)

READINESS_PATH = Path(__file__).resolve().parents[1] / "scripts" / "check_readiness.py"
READINESS_SPEC = importlib.util.spec_from_file_location(
    "telechir_readiness_checker",
    READINESS_PATH,
)
assert READINESS_SPEC and READINESS_SPEC.loader
readiness = importlib.util.module_from_spec(READINESS_SPEC)
READINESS_SPEC.loader.exec_module(readiness)


def write_svg(path: Path, width: int = 64, height: int = 64) -> None:
    path.write_text(
        (
            f'<svg xmlns="http://www.w3.org/2000/svg" '
            f'viewBox="0 0 {width} {height}">'
            '<rect width="64" height="64" rx="12" fill="#111827"/>'
            '<path d="M18 18h28v8H36v22h-8V26H18z" fill="#ffffff"/>'
            "</svg>"
        ),
        encoding="utf-8",
    )


class PackageBuilderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.logo = self.root / "logo.svg"
        self.icon = self.root / "icon.svg"
        write_svg(self.logo)
        write_svg(self.icon)
        self.base_path = Path(__file__).resolve().parents[1] / "package-base.json"
        self.config = {
            "developer_name": "Telechir Test Publisher",
            "author_email": "publisher@telechir.dev",
            "author_url": "https://telechir.dev",
            "homepage": "https://telechir.dev/telechir",
            "website_url": "https://telechir.dev/telechir",
            "support_url": "https://telechir.dev/support",
            "privacy_policy_url": "https://telechir.dev/privacy",
            "terms_of_service_url": "https://telechir.dev/terms",
            "mcp_url": "https://mcp.telechir.dev/mcp",
            "demo_recording_url": "https://review.telechir.dev/demo",
            "logo_path": str(self.logo),
            "composer_icon_path": str(self.icon),
        }

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write_config(self, value: dict | None = None) -> Path:
        path = self.root / "release-config.json"
        path.write_text(
            json.dumps(value or self.config, indent=2),
            encoding="utf-8",
        )
        return path

    def test_base_contains_exact_review_case_counts(self) -> None:
        base = builder.load_json(self.base_path)
        builder.validate_base(base)
        cases = base["review"]["test_cases"]
        self.assertEqual(len(cases["positive"]), 5)
        self.assertEqual(len(cases["negative"]), 3)

    def test_windows_utf8_bom_release_config_is_accepted(self) -> None:
        path = self.root / "release-config-bom.json"
        path.write_text(
            json.dumps(self.config),
            encoding="utf-8-sig",
        )
        loaded = builder.load_json(path)
        builder.validate_release_config(loaded)
        self.assertEqual(loaded["mcp_url"], "https://mcp.telechir.dev/mcp")

    def test_missing_release_field_fails_closed(self) -> None:
        config = dict(self.config)
        config.pop("privacy_policy_url")
        with self.assertRaisesRegex(builder.ValidationError, "missing release config"):
            builder.validate_release_config(config)

    def test_reserved_or_non_https_mcp_url_is_rejected(self) -> None:
        for value in (
            "http://mcp.telechir.dev/mcp",
            "https://localhost/mcp",
            "https://mcp.telechir.test/mcp",
            "https://example.com/mcp",
            "https://mcp.telechir.dev/not-mcp",
        ):
            config = dict(self.config)
            config["mcp_url"] = value
            with self.subTest(value=value):
                with self.assertRaises(builder.ValidationError):
                    builder.validate_release_config(config)

    def test_embedded_credentials_are_rejected(self) -> None:
        config = dict(self.config)
        config["support_url"] = "https://user:password@telechir.dev/support"
        with self.assertRaisesRegex(builder.ValidationError, "credentials"):
            builder.validate_release_config(config)

    def test_secret_like_release_fields_are_rejected(self) -> None:
        config = dict(self.config)
        config["api_key"] = "must-never-enter-the-package"
        with self.assertRaisesRegex(
            builder.ValidationError,
            "must not contain credentials, tokens, or secrets",
        ):
            builder.validate_release_config(config)

    def test_listing_url_length_limit_is_enforced(self) -> None:
        config = dict(self.config)
        config["support_url"] = "https://telechir.dev/" + ("x" * 1100)
        with self.assertRaisesRegex(builder.ValidationError, "1024"):
            builder.validate_release_config(config)

    def test_brand_colors_enforce_documented_contrast(self) -> None:
        light = dict(self.config)
        light["brand_color"] = "#FFFFFF"
        with self.assertRaisesRegex(builder.ValidationError, "contrast"):
            builder.validate_release_config(light)

        dark = dict(self.config)
        dark["brand_color_dark"] = "#212121"
        with self.assertRaisesRegex(builder.ValidationError, "contrast"):
            builder.validate_release_config(dark)

    def test_non_square_asset_is_rejected(self) -> None:
        bad = self.root / "bad.svg"
        write_svg(bad, 64, 32)
        with self.assertRaisesRegex(builder.ValidationError, "square"):
            builder.validate_asset(str(bad), "logo_path")

    def test_active_svg_content_is_rejected(self) -> None:
        bad = self.root / "active.svg"
        bad.write_text(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
            '<script>alert("x")</script></svg>',
            encoding="utf-8",
        )
        with self.assertRaisesRegex(builder.ValidationError, "active SVG"):
            builder.validate_asset(str(bad), "logo_path")

    def test_valid_build_is_deterministic_and_minimal(self) -> None:
        config_path = self.write_config()
        first = self.root / "telechir-1.zip"
        second = self.root / "telechir-2.zip"

        builder.build_package(self.base_path, config_path, first)
        builder.build_package(self.base_path, config_path, second)

        self.assertEqual(
            hashlib.sha256(first.read_bytes()).digest(),
            hashlib.sha256(second.read_bytes()).digest(),
        )

        with zipfile.ZipFile(first) as archive:
            names = sorted(archive.namelist())
            self.assertEqual(
                names,
                [
                    "assets/composer-icon.svg",
                    "assets/logo.svg",
                    "mcp.json",
                    "plugin.json",
                ],
            )
            manifest = json.loads(archive.read("plugin.json"))
            mcp = json.loads(archive.read("mcp.json"))

        extension = manifest["extensions"]["com.openai"]
        self.assertEqual(manifest["name"], "telechir")
        self.assertEqual(
            extension["interface"]["privacyPolicyURL"],
            "https://telechir.dev/privacy",
        )
        self.assertEqual(
            len(extension["review"]["test_cases"]["positive"]),
            5,
        )
        self.assertEqual(
            len(extension["review"]["test_cases"]["negative"]),
            3,
        )
        self.assertNotIn("test_credentials", json.dumps(manifest))
        self.assertNotIn("reviewer_instructions", json.dumps(manifest))
        self.assertEqual(
            mcp["mcpServers"]["telechir"],
            {
                "type": "streamable-http",
                "url": "https://mcp.telechir.dev/mcp",
            },
        )

    def test_tool_annotation_review_covers_exact_public_surface(self) -> None:
        repo = Path(__file__).resolve().parents[4]
        review_path = (
            Path(__file__).resolve().parents[1]
            / "review"
            / "tool-annotations.json"
        )
        review = json.loads(review_path.read_text(encoding="utf-8"))
        catalog = json.loads(
            (repo / "specs" / "tools" / "tool-catalog.json").read_text(
                encoding="utf-8"
            )
        )
        expected = {
            "list_devices",
            "get_device",
            "list_files",
            "get_file_metadata",
            "read_file",
            "write_file",
            "patch_file",
            "search_files",
            "run_command",
            "start_process",
            "read_process_output",
            "write_process_input",
            "cancel_process",
            "list_managed_processes",
            "get_git_status",
            "get_git_diff",
        }
        self.assertEqual(set(review["tools"]), expected)

        catalog_by_name = {tool["name"]: tool for tool in catalog["tools"]}
        for name in expected:
            tool = catalog_by_name[name]
            annotations = tool["annotations"]
            self.assertIsInstance(annotations["readOnlyHint"], bool)
            self.assertIsInstance(annotations["destructiveHint"], bool)
            self.assertIsInstance(annotations["openWorldHint"], bool)
            self.assertTrue(review["tools"][name].strip())

    def test_external_readiness_example_remains_pending(self) -> None:
        example = (
            Path(__file__).resolve().parents[1]
            / "release-readiness.example.json"
        )
        ready, pending = readiness.evaluate(readiness.load(example))
        self.assertFalse(ready)
        self.assertIn("oidc_openid_email_enabled", pending)
        self.assertIn("userinfo_verified_email", pending)
        self.assertIn("production_tool_scan_current", pending)

    def test_external_readiness_requires_evidence_for_completed_gate(self) -> None:
        value = {
            gate: {"complete": True, "evidence": "operator evidence"}
            for gate in readiness.REQUIRED_GATES
        }
        ready, pending = readiness.evaluate(value)
        self.assertTrue(ready)
        self.assertEqual(pending, [])

        value["domain_verified"] = {"complete": True, "evidence": None}
        with self.assertRaisesRegex(readiness.ReadinessError, "evidence"):
            readiness.evaluate(value)


if __name__ == "__main__":
    unittest.main()
