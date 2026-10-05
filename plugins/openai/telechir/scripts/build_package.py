#!/usr/bin/env python3
"""Build a fail-closed Telechir public plugin submission ZIP.

The release config intentionally contains no reviewer credentials. Those belong in
OpenAI's secure submission portal, not in the public ZIP or source repository.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import math
import re
import shutil
import struct
import tempfile
import zipfile
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from xml.etree import ElementTree

MAX_ASSET_BYTES = 5 * 1024 * 1024
MIN_ASSET_DIMENSION = 48
MAX_ASSET_DIMENSION = 4096
PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"

REQUIRED_CONFIG_KEYS = {
    "developer_name",
    "author_email",
    "author_url",
    "homepage",
    "website_url",
    "support_url",
    "privacy_policy_url",
    "terms_of_service_url",
    "mcp_url",
    "demo_recording_url",
    "logo_path",
    "composer_icon_path",
}
OPTIONAL_CONFIG_KEYS = {"brand_color", "brand_color_dark", "countries"}
ALLOWED_CONFIG_KEYS = REQUIRED_CONFIG_KEYS | OPTIONAL_CONFIG_KEYS
FORBIDDEN_CONFIG_KEY_PARTS = {
    "password",
    "passwd",
    "secret",
    "token",
    "credential",
    "api_key",
    "apikey",
    "reviewer_instruction",
    "test_credential",
}
RESERVED_HOSTS = {
    "localhost",
    "example.com",
    "example.org",
    "example.net",
}
RESERVED_SUFFIXES = (
    ".localhost",
    ".local",
    ".test",
    ".invalid",
    ".example",
)
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$")
PACKAGE_NAME = re.compile(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$")
EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
HEX_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")
NUMBER = re.compile(r"^[0-9]+(?:\.[0-9]+)?$")


class ValidationError(ValueError):
    pass


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValidationError(f"cannot read valid JSON from {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValidationError(f"{path} must contain a JSON object")
    return value


def validate_release_config(config: dict[str, Any]) -> None:
    keys = set(config)
    missing = sorted(REQUIRED_CONFIG_KEYS - keys)
    unknown = sorted(keys - ALLOWED_CONFIG_KEYS)
    if missing:
        raise ValidationError(f"missing release config fields: {', '.join(missing)}")
    if unknown:
        lowered = {key.lower() for key in unknown}
        if any(
            forbidden in key
            for key in lowered
            for forbidden in FORBIDDEN_CONFIG_KEY_PARTS
        ):
            raise ValidationError(
                "release config must not contain credentials, tokens, or secrets"
            )
        raise ValidationError(f"unknown release config fields: {', '.join(unknown)}")

    for key in REQUIRED_CONFIG_KEYS:
        value = config[key]
        if not isinstance(value, str) or not value.strip():
            raise ValidationError(f"{key} must be a non-empty string")

    if len(config["developer_name"]) > 80:
        raise ValidationError("developer_name must be at most 80 characters")
    if not EMAIL.fullmatch(config["author_email"]):
        raise ValidationError("author_email is invalid")

    for key in (
        "author_url",
        "homepage",
        "website_url",
        "support_url",
        "privacy_policy_url",
        "terms_of_service_url",
        "demo_recording_url",
    ):
        validate_public_https_url(key, config[key])
    validate_public_https_url("mcp_url", config["mcp_url"], require_mcp_path=True)

    for key in ("brand_color", "brand_color_dark"):
        if key in config and (
            not isinstance(config[key], str) or not HEX_COLOR.fullmatch(config[key])
        ):
            raise ValidationError(f"{key} must use #RRGGBB format")

    if "brand_color" in config and contrast_ratio(config["brand_color"], "#FFFFFF") < 2:
        raise ValidationError("brand_color must have at least 2:1 contrast against white")
    if (
        "brand_color_dark" in config
        and contrast_ratio(config["brand_color_dark"], "#212121") < 2
    ):
        raise ValidationError(
            "brand_color_dark must have at least 2:1 contrast against #212121"
        )

    if "countries" in config:
        countries = config["countries"]
        if (
            not isinstance(countries, list)
            or not countries
            or not all(
                isinstance(country, str)
                and re.fullmatch(r"[A-Z]{2}", country)
                for country in countries
            )
            or len(set(countries)) != len(countries)
        ):
            raise ValidationError(
                "countries must be a non-empty unique list of uppercase ISO-like codes"
            )


def relative_luminance(color: str) -> float:
    channels = [int(color[index : index + 2], 16) / 255 for index in (1, 3, 5)]
    linear = [
        channel / 12.92
        if channel <= 0.04045
        else ((channel + 0.055) / 1.055) ** 2.4
        for channel in channels
    ]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def contrast_ratio(first: str, second: str) -> float:
    first_luminance = relative_luminance(first)
    second_luminance = relative_luminance(second)
    lighter = max(first_luminance, second_luminance)
    darker = min(first_luminance, second_luminance)
    return (lighter + 0.05) / (darker + 0.05)


def validate_public_https_url(
    field: str, value: str, *, require_mcp_path: bool = False
) -> None:
    if len(value) > 1024:
        raise ValidationError(f"{field} must be at most 1024 characters")
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValidationError(f"{field} must be an absolute HTTPS URL")
    if parsed.username or parsed.password:
        raise ValidationError(f"{field} must not embed credentials")
    if parsed.query or parsed.fragment:
        raise ValidationError(f"{field} must not contain query or fragment")

    host = parsed.hostname.rstrip(".").lower()
    if (
        host in RESERVED_HOSTS
        or any(host.endswith(suffix) for suffix in RESERVED_SUFFIXES)
    ):
        raise ValidationError(f"{field} uses a reserved or non-production hostname")

    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address and (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_reserved
        or address.is_unspecified
        or address.is_multicast
    ):
        raise ValidationError(f"{field} must use a publicly routable host")

    if require_mcp_path:
        if parsed.path != "/mcp" or parsed.params:
            raise ValidationError("mcp_url must use the canonical /mcp path")


def validate_base(base: dict[str, Any]) -> None:
    name = base.get("name")
    version = base.get("version")
    interface = base.get("interface")
    review = base.get("review")
    publication = base.get("publication")

    if not isinstance(name, str) or len(name) > 64 or not PACKAGE_NAME.fullmatch(name):
        raise ValidationError("package name must be stable lowercase kebab-case")
    if not isinstance(version, str) or len(version) > 64 or not SEMVER.fullmatch(version):
        raise ValidationError("version must be semantic")
    if not isinstance(base.get("description"), str) or not base["description"].strip():
        raise ValidationError("description is required")
    if not isinstance(interface, dict):
        raise ValidationError("interface is required")

    required_interface = {
        "displayName": 30,
        "shortDescription": 30,
        "longDescription": 4000,
        "category": 80,
    }
    for key, maximum in required_interface.items():
        value = interface.get(key)
        if not isinstance(value, str) or not value.strip() or len(value) > maximum:
            raise ValidationError(f"interface.{key} is invalid")

    allowed_categories = {
        "Productivity",
        "Creativity",
        "Developer Tools",
        "Business & Operations",
        "Data & Analytics",
        "Communication",
        "Education & Research",
        "Security",
        "Finance",
        "Healthcare",
        "Travel",
        "Entertainment",
        "Other",
    }
    if interface["category"] not in allowed_categories:
        raise ValidationError("interface.category is not supported")

    capabilities = interface.get("capabilities")
    if (
        not isinstance(capabilities, list)
        or len(capabilities) > 20
        or not capabilities
        or not all(
            isinstance(value, str) and 0 < len(value.strip()) <= 120
            for value in capabilities
        )
    ):
        raise ValidationError("interface.capabilities is invalid")

    prompts = interface.get("defaultPrompt")
    if (
        not isinstance(prompts, list)
        or not 1 <= len(prompts) <= 3
        or not all(
            isinstance(value, str)
            and 0 < len(value.strip()) <= 128
            and "\n" not in value
            and "@" not in value
            for value in prompts
        )
        or len(set(prompts)) != len(prompts)
    ):
        raise ValidationError("interface.defaultPrompt is invalid")

    if not isinstance(review, dict):
        raise ValidationError("review is required")
    cases = review.get("test_cases")
    if not isinstance(cases, dict):
        raise ValidationError("review.test_cases is required")
    positive = cases.get("positive")
    negative = cases.get("negative")
    if not isinstance(positive, list) or len(positive) != 5:
        raise ValidationError("exactly five positive review cases are required")
    if not isinstance(negative, list) or len(negative) != 3:
        raise ValidationError("exactly three negative review cases are required")

    for index, case in enumerate(positive, start=1):
        if not isinstance(case, dict):
            raise ValidationError(f"positive review case {index} must be an object")
        for key in ("description", "prompt", "tools_triggered", "expected_behavior"):
            if not isinstance(case.get(key), str) or not case[key].strip():
                raise ValidationError(
                    f"positive review case {index} requires {key}"
                )
    for index, case in enumerate(negative, start=1):
        if not isinstance(case, dict):
            raise ValidationError(f"negative review case {index} must be an object")
        for key in ("description", "prompt"):
            if not isinstance(case.get(key), str) or not case[key].strip():
                raise ValidationError(
                    f"negative review case {index} requires {key}"
                )

    if (
        not isinstance(publication, dict)
        or not isinstance(publication.get("release_notes"), str)
        or not publication["release_notes"].strip()
    ):
        raise ValidationError("publication.release_notes is required")


def parse_svg_dimensions(path: Path) -> tuple[float, float]:
    try:
        root = ElementTree.parse(path).getroot()
    except (ElementTree.ParseError, OSError) as exc:
        raise ValidationError(f"{path} is not a valid SVG") from exc
    if root.tag.split("}")[-1] != "svg":
        raise ValidationError(f"{path} root element must be svg")

    for element in root.iter():
        local_name = element.tag.split("}")[-1].lower()
        if local_name in {"script", "foreignobject"}:
            raise ValidationError(f"{path} contains active SVG content")
        for attr, value in element.attrib.items():
            attr_name = attr.split("}")[-1].lower()
            if attr_name.startswith("on"):
                raise ValidationError(f"{path} contains SVG event handlers")
            if attr_name in {"href", "xlink:href"} and re.match(
                r"(?i)\s*(?:https?:|data:|javascript:)", value
            ):
                raise ValidationError(f"{path} contains external or active SVG references")

    view_box = root.attrib.get("viewBox")
    if view_box:
        parts = re.split(r"[\s,]+", view_box.strip())
        if len(parts) != 4:
            raise ValidationError(f"{path} has an invalid SVG viewBox")
        try:
            _, _, width, height = map(float, parts)
        except ValueError as exc:
            raise ValidationError(f"{path} has a non-numeric SVG viewBox") from exc
        return width, height

    width = root.attrib.get("width")
    height = root.attrib.get("height")
    if not width or not height or not NUMBER.fullmatch(width) or not NUMBER.fullmatch(height):
        raise ValidationError(f"{path} must define numeric square SVG dimensions")
    return float(width), float(height)


def parse_png_dimensions(path: Path) -> tuple[int, int]:
    try:
        data = path.read_bytes()[:24]
    except OSError as exc:
        raise ValidationError(f"cannot read asset {path}") from exc
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise ValidationError(f"{path} is not a valid PNG")
    return struct.unpack(">II", data[16:24])


def validate_asset(path_value: str, field: str) -> Path:
    path = Path(path_value).expanduser().resolve()
    if not path.is_file() or path.is_symlink():
        raise ValidationError(f"{field} must point to a regular non-symlink file")
    size = path.stat().st_size
    if size <= 0 or size > MAX_ASSET_BYTES:
        raise ValidationError(f"{field} must be between 1 byte and 5 MiB")

    suffix = path.suffix.lower()
    if suffix == ".svg":
        width, height = parse_svg_dimensions(path)
    elif suffix == ".png":
        width, height = parse_png_dimensions(path)
    else:
        raise ValidationError(
            f"{field} must be SVG or PNG so dimensions can be validated deterministically"
        )

    if (
        not math.isfinite(float(width))
        or not math.isfinite(float(height))
        or width != height
        or width < MIN_ASSET_DIMENSION
        or width > MAX_ASSET_DIMENSION
    ):
        raise ValidationError(
            f"{field} must be square and between 48x48 and 4096x4096"
        )
    return path


def build_manifest(
    base: dict[str, Any],
    config: dict[str, Any],
    logo_name: str,
    composer_name: str,
) -> dict[str, Any]:
    interface = dict(base["interface"])
    interface.update(
        {
            "developerName": config["developer_name"],
            "websiteURL": config["website_url"],
            "supportURL": config["support_url"],
            "privacyPolicyURL": config["privacy_policy_url"],
            "termsOfServiceURL": config["terms_of_service_url"],
            "logo": f"./assets/{logo_name}",
            "composerIcon": f"./assets/{composer_name}",
        }
    )
    if "brand_color" in config:
        interface["brandColor"] = config["brand_color"]
    if "brand_color_dark" in config:
        interface["brandColorDark"] = config["brand_color_dark"]

    review = json.loads(json.dumps(base["review"]))
    review["demo_recording_url"] = config["demo_recording_url"]
    publication = json.loads(json.dumps(base["publication"]))
    if "countries" in config:
        publication["countries"] = config["countries"]

    return {
        "$schema": PLUGIN_SCHEMA,
        "name": base["name"],
        "version": base["version"],
        "description": base["description"],
        "author": {
            "name": config["developer_name"],
            "email": config["author_email"],
            "url": config["author_url"],
        },
        "homepage": config["homepage"],
        "repository": base["repository"],
        "license": base["license"],
        "keywords": base["keywords"],
        "extensions": {
            "com.openai": {
                "interface": interface,
                "review": review,
                "publication": publication,
            }
        },
    }


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, indent=2, ensure_ascii=False, sort_keys=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def create_deterministic_zip(source_dir: Path, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(p for p in source_dir.rglob("*") if p.is_file()):
            relative = path.relative_to(source_dir).as_posix()
            info = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())


def build_package(base_path: Path, config_path: Path, output: Path) -> Path:
    base = load_json(base_path)
    config = load_json(config_path)
    validate_base(base)
    validate_release_config(config)

    logo = validate_asset(config["logo_path"], "logo_path")
    composer = validate_asset(config["composer_icon_path"], "composer_icon_path")
    logo_name = f"logo{logo.suffix.lower()}"
    composer_name = f"composer-icon{composer.suffix.lower()}"

    with tempfile.TemporaryDirectory(prefix="telechir-plugin-") as temp:
        package_root = Path(temp)
        assets = package_root / "assets"
        assets.mkdir()
        shutil.copyfile(logo, assets / logo_name)
        shutil.copyfile(composer, assets / composer_name)

        manifest = build_manifest(base, config, logo_name, composer_name)
        mcp = {
            "$schema": MCP_SCHEMA,
            "mcpServers": {
                "telechir": {
                    "type": "streamable-http",
                    "url": config["mcp_url"],
                }
            },
        }
        write_json(package_root / "plugin.json", manifest)
        write_json(package_root / "mcp.json", mcp)

        forbidden = [
            package_root / ".app.json",
            package_root / "hooks",
            package_root / ".env",
        ]
        if any(path.exists() for path in forbidden):
            raise ValidationError("public submission package contains forbidden runtime files")

        create_deterministic_zip(package_root, output)

    return output


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build the Telechir OpenAI public plugin submission ZIP."
    )
    root = Path(__file__).resolve().parent.parent
    parser.add_argument(
        "--base",
        type=Path,
        default=root / "package-base.json",
        help="Package base metadata JSON.",
    )
    parser.add_argument(
        "--release-config",
        type=Path,
        required=True,
        help="Unversioned release config with final public URLs and asset paths.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=root / "dist" / "telechir-plugin.zip",
        help="Output ZIP path.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        output = build_package(
            args.base.resolve(),
            args.release_config.resolve(),
            args.output.resolve(),
        )
    except ValidationError as exc:
        print(f"ERROR: {exc}")
        return 2
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
