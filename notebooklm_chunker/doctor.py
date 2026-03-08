from __future__ import annotations

import importlib.util
import os
import shutil
from dataclasses import dataclass
from importlib import metadata
from pathlib import Path

from notebooklm_chunker.config import AppConfig, ConfigError, load_config, resolve_config_path


@dataclass(frozen=True, slots=True)
class DoctorCheck:
    name: str
    status: str
    summary: str
    hint: str | None = None


@dataclass(frozen=True, slots=True)
class DoctorReport:
    checks: tuple[DoctorCheck, ...]
    local_chunking_ready: bool
    live_run_ready: bool

    @property
    def exit_code(self) -> int:
        return 1 if any(check.status == "fail" for check in self.checks) else 0


def run_doctor(
    explicit_config: Path | None = None,
    *,
    start_dir: Path | None = None,
) -> DoctorReport:
    checks: list[DoctorCheck] = []
    config: AppConfig | None = None
    source_path: Path | None = None

    resolved_config_path = resolve_config_path(explicit_config, start_dir=start_dir)
    if resolved_config_path is None:
        checks.append(
            DoctorCheck(
                name="config",
                status="warn",
                summary="No config file found.",
                hint="Run `nblm init` or pass `--config`.",
            )
        )
    else:
        try:
            config = load_config(resolved_config_path, start_dir=start_dir)
        except ConfigError as exc:
            checks.append(
                DoctorCheck(
                    name="config",
                    status="fail",
                    summary=str(exc),
                )
            )
        else:
            checks.append(
                DoctorCheck(
                    name="config",
                    status="ok",
                    summary=str(Path(config.config_path or str(resolved_config_path)).resolve()),
                )
            )
            if config.source.path:
                source_path = Path(config.source.path)

    if source_path is None:
        checks.append(
            DoctorCheck(
                name="source",
                status="warn",
                summary="`source.path` is not configured.",
                hint="Set `source.path` in your workflow file.",
            )
        )
    elif not source_path.exists():
        checks.append(
            DoctorCheck(
                name="source",
                status="fail",
                summary=f"Source file not found: {source_path}",
            )
        )
    elif not source_path.is_file():
        checks.append(
            DoctorCheck(
                name="source",
                status="fail",
                summary=f"Source path is not a file: {source_path}",
            )
        )
    else:
        checks.append(
            DoctorCheck(
                name="source",
                status="ok",
                summary=str(source_path.resolve()),
            )
        )

    notebooklm_cli = shutil.which("notebooklm")
    if notebooklm_cli:
        checks.append(
            DoctorCheck(
                name="notebooklm-cli",
                status="ok",
                summary=notebooklm_cli,
            )
        )
    else:
        checks.append(
            DoctorCheck(
                name="notebooklm-cli",
                status="warn",
                summary="`notebooklm` CLI was not found in PATH.",
                hint="Install `notebooklm-chunker` and run `python -m playwright install chromium`.",
            )
        )

    auth_check = _auth_check()
    checks.append(auth_check)

    playwright_check = _playwright_check()
    checks.append(playwright_check)

    pdf_parser_check = _pdf_parser_check(source_path)
    checks.append(pdf_parser_check)

    local_chunking_ready = not any(
        check.status == "fail" and check.name in {"config", "source", "pdf-parser"}
        for check in checks
    )
    live_run_ready = local_chunking_ready and all(
        check.status == "ok"
        for check in checks
        if check.name in {"notebooklm-cli", "auth"}
    )
    return DoctorReport(
        checks=tuple(checks),
        local_chunking_ready=local_chunking_ready,
        live_run_ready=live_run_ready,
    )


def format_doctor_report(report: DoctorReport) -> str:
    lines = ["Doctor"]
    for check in report.checks:
        status = check.status.upper().ljust(4)
        lines.append(f"{status} {check.name:<14} {check.summary}")
        if check.hint:
            lines.append(f"     {'':14} {check.hint}")

    lines.append("")
    lines.append(
        "Ready"
        f"  local-chunking={'yes' if report.local_chunking_ready else 'no'}"
        f"  live-run={'yes' if report.live_run_ready else 'no'}"
    )
    return "\n".join(lines)


def _auth_check() -> DoctorCheck:
    auth_json = os.getenv("NOTEBOOKLM_AUTH_JSON")
    if auth_json:
        return DoctorCheck(
            name="auth",
            status="ok",
            summary="Configured through `NOTEBOOKLM_AUTH_JSON`.",
        )

    notebooklm_home = _resolve_notebooklm_home()
    storage_state = notebooklm_home / "storage_state.json"
    context_json = notebooklm_home / "context.json"
    browser_profile = notebooklm_home / "browser_profile"
    if storage_state.exists() or context_json.exists() or browser_profile.exists():
        return DoctorCheck(
            name="auth",
            status="ok",
            summary=f"Local auth state found under {notebooklm_home.expanduser()}",
        )

    return DoctorCheck(
        name="auth",
        status="warn",
        summary="No NotebookLM auth state found.",
        hint="Run `nblm login` before live uploads.",
    )


def _playwright_check() -> DoctorCheck:
    spec = importlib.util.find_spec("playwright")
    if spec is None:
        return DoctorCheck(
            name="playwright",
            status="warn",
            summary="Python Playwright package is not installed.",
            hint="Install `notebooklm-chunker` and run `python -m playwright install chromium`.",
        )

    version = _package_version("playwright")
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as playwright:
            executable_path = Path(playwright.chromium.executable_path)
    except Exception:
        return DoctorCheck(
            name="playwright",
            status="warn",
            summary=f"Playwright{_version_suffix(version)} is installed but Chromium is missing.",
            hint="Run `python -m playwright install chromium`.",
        )

    if executable_path.exists():
        return DoctorCheck(
            name="playwright",
            status="ok",
            summary=f"Chromium ready at {executable_path}{_version_suffix(version)}",
        )

    return DoctorCheck(
        name="playwright",
        status="warn",
        summary=f"Playwright{_version_suffix(version)} is installed but Chromium is missing.",
        hint="Run `python -m playwright install chromium`.",
    )


def _pdf_parser_check(source_path: Path | None) -> DoctorCheck:
    available: list[str] = []
    if importlib.util.find_spec("fitz") is not None:
        available.append("PyMuPDF")
    if importlib.util.find_spec("pypdf") is not None:
        available.append("pypdf")

    if available:
        return DoctorCheck(
            name="pdf-parser",
            status="ok",
            summary=", ".join(available) + " available.",
        )

    if source_path is not None and source_path.suffix.lower() == ".pdf":
        return DoctorCheck(
            name="pdf-parser",
            status="fail",
            summary="No PDF parser is installed for the configured PDF source.",
            hint="Install `notebooklm-chunker` or add `pymupdf` manually.",
        )

    return DoctorCheck(
        name="pdf-parser",
        status="warn",
        summary="No PDF parser is installed.",
        hint="Install `notebooklm-chunker` or add `pymupdf` manually if you want PDF support.",
    )


def _package_version(package_name: str) -> str | None:
    try:
        return metadata.version(package_name)
    except metadata.PackageNotFoundError:
        return None


def _version_suffix(version: str | None) -> str:
    if version is None:
        return ""
    return f" {version}"


def _resolve_notebooklm_home() -> Path:
    configured = os.getenv("NOTEBOOKLM_HOME")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".notebooklm"
