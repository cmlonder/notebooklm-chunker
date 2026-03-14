from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

from notebooklm_chunker import __version__
from notebooklm_chunker.chunker import chunk_document
from notebooklm_chunker.config import AppConfig, load_config, write_config_template
from notebooklm_chunker.doctor import format_doctor_report, run_doctor
from notebooklm_chunker.exporters import export_markdown_chunks
from notebooklm_chunker.models import ChunkingSettings, ExportResult
from notebooklm_chunker.parsers import ChunkerError, inspect_pdf_page_selection, parse_document
from notebooklm_chunker.run_state import RunStateStore
from notebooklm_chunker.uploaders.notebooklm_py import (
    RUN_STATE_BASENAME,
    NotebookLMPyUploader,
    StudioResult,
    run_notebooklm_login,
    run_notebooklm_logout,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="nblm",
        description="Split long documents into NotebookLM-ready chunks and optionally generate Studio outputs.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    subparsers = parser.add_subparsers(dest="command", required=True)

    login_parser = subparsers.add_parser(
        "login", help="Run `notebooklm login` for notebooklm-py authentication."
    )
    login_parser.set_defaults(handler=_handle_login)

    logout_parser = subparsers.add_parser(
        "logout",
        help="Clear notebooklm-py local authentication state from disk.",
    )
    logout_parser.set_defaults(handler=_handle_logout)

    doctor_parser = subparsers.add_parser(
        "doctor",
        help="Check config discovery, auth, Playwright, PDF parser, and notebooklm CLI readiness.",
    )
    _add_config_argument(doctor_parser)
    doctor_parser.set_defaults(handler=_handle_doctor)

    list_notebooks_parser = subparsers.add_parser(
        "list-notebooks",
        help="List available NotebookLM notebooks as JSON for desktop integrations.",
    )
    list_notebooks_parser.set_defaults(handler=_handle_list_notebooks)

    list_artifacts_parser = subparsers.add_parser(
        "list-artifacts",
        help="List NotebookLM Studio artifacts as JSON for desktop integrations.",
    )
    list_artifacts_parser.add_argument("--notebook-id", required=True, help="Notebook ID to inspect.")
    list_artifacts_parser.set_defaults(handler=_handle_list_artifacts)

    delete_artifacts_parser = subparsers.add_parser(
        "delete-artifacts",
        help="Delete NotebookLM Studio artifacts for desktop integrations.",
    )
    delete_artifacts_parser.add_argument("--notebook-id", required=True, help="Notebook ID that owns the artifacts.")
    delete_artifacts_parser.add_argument(
        "--artifact-id",
        action="append",
        default=None,
        help="Artifact ID to delete. Repeat as needed.",
    )
    delete_artifacts_parser.set_defaults(handler=_handle_delete_artifacts)

    inspect_parser = subparsers.add_parser(
        "inspect",
        help="Inspect a document and print lightweight JSON metadata for desktop integrations.",
    )
    inspect_parser.add_argument("input", help="Source document path to inspect.")
    inspect_parser.set_defaults(handler=_handle_inspect)

    init_parser = subparsers.add_parser(
        "init", help="Write a workflow config file with chunking and Studio settings."
    )
    init_parser.add_argument(
        "-o", "--output", default="nblm.toml", help="Where to write the config file."
    )
    init_parser.add_argument(
        "--target-pages", type=float, default=3.0, help="Default target estimated pages per chunk."
    )
    init_parser.add_argument(
        "--min-pages", type=float, default=2.5, help="Default minimum estimated pages per chunk."
    )
    init_parser.add_argument(
        "--max-pages", type=float, default=4.0, help="Default maximum estimated pages per chunk."
    )
    init_parser.add_argument(
        "--words-per-page", type=int, default=500, help="Default word heuristic for one page."
    )
    init_parser.add_argument(
        "--force", action="store_true", help="Overwrite an existing config file."
    )
    init_parser.set_defaults(handler=_handle_init)

    prepare_parser = subparsers.add_parser(
        "prepare", help="Parse a document and export Markdown chunks."
    )
    _add_config_argument(prepare_parser)
    _add_prepare_arguments(prepare_parser)
    prepare_parser.set_defaults(handler=_handle_prepare)

    upload_parser = subparsers.add_parser("upload", help="Upload existing chunks to NotebookLM.")
    _add_config_argument(upload_parser)
    upload_parser.add_argument(
        "directory", nargs="?", help="Directory that contains exported Markdown chunks."
    )
    upload_parser.add_argument("--notebook-id", help="Existing notebook ID to upload into.")
    upload_parser.add_argument(
        "--notebook-title", help="Notebook title to create when notebook ID is not provided."
    )
    upload_parser.add_argument(
        "--max-parallel-chunks",
        type=int,
        default=None,
        help="How many chunk uploads to process at once. Defaults to `runtime.max_parallel_chunks` or 1.",
    )
    upload_parser.add_argument(
        "--rename-remote-titles",
        action="store_true",
        help="Rename uploaded NotebookLM sources to match local chunk titles for this upload.",
    )
    upload_parser.add_argument(
        "--only-changed",
        action="store_true",
        help="Reuse saved run state and upload only chunks whose content changed since the last upload.",
    )
    upload_parser.set_defaults(handler=_handle_upload)

    studios_parser = subparsers.add_parser(
        "studios",
        help="Generate enabled Studio outputs for an existing notebook or a saved run state.",
    )
    _add_config_argument(studios_parser)
    studios_parser.add_argument(
        "--notebook-id", help="Notebook ID to run Studio generation against."
    )
    studios_parser.add_argument(
        "-o",
        "--output-dir",
        help="Directory for Studio downloads when `output_path` is not set in config.",
    )
    studios_parser.add_argument(
        "--source-id",
        action="append",
        default=None,
        help="Restrict Studio generation to the given NotebookLM source ID. Repeat as needed.",
    )
    studios_parser.set_defaults(handler=_handle_studios)

    run_parser = subparsers.add_parser(
        "run",
        help="Prepare a document, create a fresh notebook run, then generate enabled Studio outputs.",
    )
    _add_config_argument(run_parser)
    _add_prepare_arguments(run_parser)
    run_parser.add_argument("--notebook-id", help="Existing notebook ID to upload into.")
    run_parser.add_argument(
        "--notebook-title", help="Notebook title to create when notebook ID is not provided."
    )
    run_parser.add_argument(
        "--max-parallel-chunks",
        type=int,
        default=None,
        help="How many chunk upload + per-chunk Studio pipelines to process at once.",
    )
    run_parser.set_defaults(handler=_handle_run)

    resume_parser = subparsers.add_parser(
        "resume",
        help="Continue a previous run from `.nblm-run-state.json` and finish pending uploads or Studio jobs.",
    )
    _add_config_argument(resume_parser)
    _add_prepare_arguments(resume_parser)
    resume_parser.add_argument(
        "--notebook-id", help="Resume against an explicit notebook ID from the saved run state."
    )
    resume_parser.add_argument(
        "--max-parallel-chunks",
        type=int,
        default=None,
        help="How many chunk upload + per-chunk Studio pipelines to process at once.",
    )
    resume_parser.set_defaults(handler=_handle_resume)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.handler(args))
    except ChunkerError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


def _add_prepare_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "input", nargs="?", help="Source document path. Falls back to `source.path` in config."
    )
    parser.add_argument(
        "-o",
        "--output-dir",
        help="Chunk output directory. Defaults to `chunking.output_dir` or <input-stem>-chunks.",
    )
    parser.add_argument(
        "--target-pages", type=float, default=None, help="Target estimated pages per chunk."
    )
    parser.add_argument(
        "--min-pages", type=float, default=None, help="Minimum estimated pages per chunk."
    )
    parser.add_argument(
        "--max-pages", type=float, default=None, help="Maximum estimated pages per chunk."
    )
    parser.add_argument(
        "--words-per-page", type=int, default=None, help="Word heuristic for one page."
    )
    parser.add_argument(
        "-y",
        "--yes",
        action="store_true",
        help="Overwrite an existing non-empty chunk output directory without prompting.",
    )
    parser.add_argument(
        "--skip-range",
        action="append",
        default=None,
        help="Skip an inclusive PDF page range like `1-8` or a single page like `12`. Repeat as needed.",
    )


def _add_config_argument(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--config", help="Path to nblm.toml, .nblm.toml, or pyproject.toml.")


def _handle_login(args: argparse.Namespace) -> int:
    run_notebooklm_login()
    print("NotebookLM login completed.")
    return 0


def _handle_logout(args: argparse.Namespace) -> int:
    removed_paths, auth_json_note = run_notebooklm_logout()
    if removed_paths:
        print("Removed local NotebookLM auth state:")
        for path in removed_paths:
            print(path)
    else:
        print("No local NotebookLM auth state was found.")
    if auth_json_note:
        print(auth_json_note)
    return 0


def _handle_doctor(args: argparse.Namespace) -> int:
    report = run_doctor(_path_or_none(args.config))
    print(format_doctor_report(report))
    return report.exit_code


def _handle_list_notebooks(args: argparse.Namespace) -> int:
    uploader = NotebookLMPyUploader()
    print(json.dumps(uploader.list_notebooks(), ensure_ascii=False))
    return 0


def _handle_list_artifacts(args: argparse.Namespace) -> int:
    uploader = NotebookLMPyUploader()
    print(json.dumps(uploader.list_artifacts(args.notebook_id), ensure_ascii=False))
    return 0


def _handle_delete_artifacts(args: argparse.Namespace) -> int:
    artifact_ids = list(args.artifact_id or [])
    if not artifact_ids:
        raise ChunkerError("At least one `--artifact-id` is required for `delete-artifacts`.")
    uploader = NotebookLMPyUploader()
    uploader.delete_artifacts(args.notebook_id, artifact_ids)
    print(json.dumps({"deleted": artifact_ids}, ensure_ascii=False))
    return 0


def _handle_inspect(args: argparse.Namespace) -> int:
    input_path = Path(args.input)
    _require_file(input_path, label="Input file")
    blocks = parse_document(input_path)
    pages = sorted({block.page for block in blocks if block.page is not None})
    print(
        json.dumps(
            {
                "pages": len(pages),
                "first_page": pages[0] if pages else None,
                "last_page": pages[-1] if pages else None,
                "headings": sum(1 for block in blocks if block.kind == "heading"),
                "paragraphs": sum(1 for block in blocks if block.kind == "paragraph"),
            },
            ensure_ascii=False,
        )
    )
    return 0


def _handle_init(args: argparse.Namespace) -> int:
    config_path = write_config_template(
        Path(args.output),
        target_pages=args.target_pages,
        min_pages=args.min_pages,
        max_pages=args.max_pages,
        words_per_page=args.words_per_page,
        force=args.force,
    )
    print(f"Config file: {config_path}")
    print(
        "Next: edit the workflow file, run `nblm login`, then run `nblm run --config <file>` "
        "for a fresh notebook or `nblm resume --config <file>` to continue an unfinished run."
    )
    return 0


def _handle_prepare(args: argparse.Namespace) -> int:
    config = load_config(_path_or_none(args.config))
    input_path = _resolve_input_path(args.input, config)
    _require_file(input_path, label="Input file")
    output_dir = _resolve_chunk_output_dir(args.output_dir, input_path, config)
    _confirm_chunk_output_overwrite(output_dir, assume_yes=args.yes, action_label="prepare")
    settings = _resolve_chunking_settings(args, config)
    blocks, export_result = _prepare_document(
        input_path,
        output_dir,
        settings,
        pdf_skip_ranges=_resolve_skip_ranges(args, config),
        reporter=_progress,
    )
    headings = sum(1 for block in blocks if block.kind == "heading")
    print(f"Detected headings: {headings}")
    print(f"Chunks generated: {len(export_result.files)}")
    print(f"Output folder: {export_result.output_dir}")
    return 0


def _handle_upload(args: argparse.Namespace) -> int:
    config = load_config(_path_or_none(args.config))
    directory = _resolve_chunks_directory(args.directory, config)
    _require_directory(directory, label="Chunks directory")
    uploader = NotebookLMPyUploader()
    notebook_id, uploaded = uploader.upload_directory(
        directory,
        notebook_id=args.notebook_id or config.notebook.id,
        notebook_title=args.notebook_title or config.notebook.title or directory.name,
        max_parallel_chunks=_resolve_max_parallel_chunks(args, config),
        studio_wait_timeout_seconds=_resolve_studio_wait_timeout_seconds(config),
        studio_rate_limit_cooldown_seconds=_resolve_studio_rate_limit_cooldown_seconds(config),
        rename_remote_titles=args.rename_remote_titles or config.runtime.rename_remote_titles,
        resume=args.only_changed,
        reporter=_progress,
    )
    print(f"Notebook ID: {notebook_id}")
    print(f"Uploaded sources: {len(uploaded)}")
    return 0


def _handle_studios(args: argparse.Namespace) -> int:
    config = load_config(_path_or_none(args.config))
    notebook_id = args.notebook_id or config.notebook.id
    run_state_path = _resolve_run_state_path(config)
    if notebook_id is None and run_state_path is None:
        raise ChunkerError(
            "Notebook ID is required for `studios` unless a previous `.nblm-run-state.json` is available. "
            "Set `notebook.id`, pass `--notebook-id`, or run `nblm run` first."
        )
    _confirm_quota_block_if_needed(
        run_state_path,
        assume_yes=False,
        action_label="studios",
        studio_names=tuple(studio_name for studio_name, _ in config.studios.enabled_items()),
    )

    uploader = NotebookLMPyUploader()
    studio_output_dir = _resolve_studio_output_dir(
        args.output_dir,
        config=config,
        chunk_output_dir=None,
    )
    results = uploader.run_studios(
        notebook_id=notebook_id,
        studios=config.studios,
        studio_output_dir=studio_output_dir,
        run_state_path=run_state_path,
        source_ids=list(args.source_id or []),
        max_parallel_heavy_studios=_resolve_max_parallel_heavy_studios(config),
        studio_wait_timeout_seconds=_resolve_studio_wait_timeout_seconds(config),
        studio_create_retries=_resolve_studio_create_retries(config),
        studio_create_backoff_seconds=_resolve_studio_create_backoff_seconds(config),
        studio_rate_limit_cooldown_seconds=_resolve_studio_rate_limit_cooldown_seconds(config),
        rename_remote_titles=config.runtime.rename_remote_titles,
        download_outputs=_resolve_download_outputs(config),
        reporter=_progress,
    )
    display_notebook_id = notebook_id
    if display_notebook_id is None and run_state_path is not None:
        display_notebook_id = RunStateStore.load(run_state_path).notebook_id
    print(f"Notebook ID: {display_notebook_id}")
    _print_studio_results(results)
    return 0


def _handle_run(args: argparse.Namespace) -> int:
    return _run_pipeline(args, resume=False)


def _handle_resume(args: argparse.Namespace) -> int:
    return _run_pipeline(args, resume=True)


def _run_pipeline(args: argparse.Namespace, *, resume: bool) -> int:
    config = load_config(_path_or_none(args.config))
    input_path = _resolve_input_path(args.input, config)
    _require_file(input_path, label="Input file")
    output_dir = _resolve_chunk_output_dir(args.output_dir, input_path, config)
    if not resume:
        _confirm_chunk_output_overwrite(
            output_dir, assume_yes=getattr(args, "yes", False), action_label="run"
        )
    else:
        _confirm_quota_block_if_needed(
            output_dir / RUN_STATE_BASENAME,
            assume_yes=getattr(args, "yes", False),
            action_label="resume",
            studio_names=tuple(studio_name for studio_name, _ in config.studios.enabled_items()),
        )
    settings = _resolve_chunking_settings(args, config)
    _, export_result = _prepare_document(
        input_path,
        output_dir,
        settings,
        pdf_skip_ranges=_resolve_skip_ranges(args, config),
        reporter=_progress,
    )

    uploader = NotebookLMPyUploader()
    notebook_id, uploaded, studios = uploader.ingest_directory(
        output_dir,
        notebook_id=args.notebook_id or config.notebook.id,
        notebook_title=getattr(args, "notebook_title", None)
        or config.notebook.title
        or input_path.stem,
        studios=config.studios,
        studio_output_dir=_resolve_studio_output_dir(
            None, config=config, chunk_output_dir=output_dir
        ),
        max_parallel_chunks=_resolve_max_parallel_chunks(args, config),
        max_parallel_heavy_studios=_resolve_max_parallel_heavy_studios(config),
        studio_wait_timeout_seconds=_resolve_studio_wait_timeout_seconds(config),
        studio_create_retries=_resolve_studio_create_retries(config),
        studio_create_backoff_seconds=_resolve_studio_create_backoff_seconds(config),
        studio_rate_limit_cooldown_seconds=_resolve_studio_rate_limit_cooldown_seconds(config),
        rename_remote_titles=config.runtime.rename_remote_titles,
        download_outputs=_resolve_download_outputs(config),
        resume=resume,
        reporter=_progress,
    )
    print(f"Notebook ID: {notebook_id}")
    print(f"Uploaded sources: {len(uploaded)}")
    _print_studio_results(studios)
    print(f"Output folder: {export_result.output_dir}")
    return 0


def _prepare_document(
    input_path: Path,
    output_dir: Path,
    settings: ChunkingSettings,
    *,
    pdf_skip_ranges: tuple[str, ...] = (),
    reporter=None,
) -> tuple[list, ExportResult]:
    _emit_prepare_log(reporter, f"parse: {input_path}")
    if pdf_skip_ranges:
        _emit_prepare_log(reporter, f"parse: skip_ranges={_format_skip_ranges(pdf_skip_ranges)}")
    if input_path.suffix.lower() == ".pdf":
        page_selection = inspect_pdf_page_selection(input_path, skip_ranges=pdf_skip_ranges)
        if page_selection.included_pages:
            _emit_prepare_log(
                reporter,
                "parse: "
                f"PDF physical pages kept {len(page_selection.included_pages)}/{page_selection.total_pages} "
                f"(first={page_selection.included_pages[0]}, last={page_selection.included_pages[-1]}, "
                f"skipped={len(page_selection.skipped_pages)})",
            )
    blocks = parse_document(
        input_path,
        pdf_skip_ranges=pdf_skip_ranges,
    )
    page_count = len({block.page for block in blocks if block.page is not None})
    heading_count = sum(1 for block in blocks if block.kind == "heading")
    paragraph_count = sum(1 for block in blocks if block.kind == "paragraph")
    summary = (
        f"parse: {len(blocks)} block(s), {heading_count} heading(s), {paragraph_count} paragraph(s)"
    )
    if page_count:
        summary += f", {page_count} page(s)"
    _emit_prepare_log(reporter, summary)
    _emit_prepare_log(
        reporter,
        "chunk: "
        f"target={settings.target_pages:.2f} pages, "
        f"min={settings.min_pages:.2f}, "
        f"max={settings.max_pages:.2f}, "
        f"words/page={settings.words_per_page}",
    )
    chunks = chunk_document(blocks, input_path, settings=settings)
    _emit_prepare_log(reporter, f"chunk: planned {len(chunks)} chunk(s)")
    export_result = export_markdown_chunks(chunks, output_dir, reporter=reporter)
    _emit_prepare_log(reporter, f"export: manifest.json -> {export_result.manifest_path}")
    return blocks, export_result


def _print_studio_results(results: list[StudioResult]) -> None:
    print(f"Generated studios: {len(results)}")
    for result in results:
        label = result.studio.replace("_", "-")
        source_file = getattr(result, "source_file", None)
        prefix = f"{label} [{source_file}]" if source_file else label
        status = getattr(result, "status", "completed")
        if status == "pending":
            destination = result.output_path or "resume state"
            print(f"{prefix}: pending -> {destination}")
        elif result.output_path:
            print(f"{prefix}: {result.output_path}")
        else:
            print(f"{prefix}: completed")


def _resolve_chunking_settings(args: argparse.Namespace, config: AppConfig) -> ChunkingSettings:
    min_pages = args.min_pages if args.min_pages is not None else config.chunking.min_pages or 2.5
    max_pages = args.max_pages if args.max_pages is not None else config.chunking.max_pages or 4.0
    target_pages = (
        args.target_pages if args.target_pages is not None else config.chunking.target_pages
    )
    if target_pages is None:
        target_pages = round((min_pages + max_pages) / 2, 2)

    return ChunkingSettings(
        target_pages=target_pages,
        min_pages=min_pages,
        max_pages=max_pages,
        words_per_page=(
            args.words_per_page
            if args.words_per_page is not None
            else config.chunking.words_per_page or 500
        ),
    )


def _resolve_skip_ranges(args: argparse.Namespace, config: AppConfig) -> tuple[str, ...]:
    cli_ranges = getattr(args, "skip_range", None)
    if cli_ranges is not None:
        return tuple(cli_ranges)
    return config.source.skip_ranges


def _resolve_max_parallel_chunks(args: argparse.Namespace, config: AppConfig) -> int:
    value = getattr(args, "max_parallel_chunks", None)
    if value is None:
        value = config.runtime.max_parallel_chunks or 1
    if value < 1:
        raise ChunkerError("`max_parallel_chunks` must be greater than or equal to 1.")
    return value


def _resolve_studio_wait_timeout_seconds(config: AppConfig) -> float:
    return config.runtime.studio_wait_timeout_seconds or 7200.0


def _resolve_max_parallel_heavy_studios(config: AppConfig) -> int:
    value = config.runtime.max_parallel_heavy_studios
    if value is None:
        return 1
    if value < 1:
        raise ChunkerError("`max_parallel_heavy_studios` must be greater than or equal to 1.")
    return value


def _resolve_studio_create_retries(config: AppConfig) -> int:
    if config.runtime.studio_create_retries is None:
        return 3
    return config.runtime.studio_create_retries


def _resolve_studio_create_backoff_seconds(config: AppConfig) -> float:
    return config.runtime.studio_create_backoff_seconds or 2.0


def _resolve_studio_rate_limit_cooldown_seconds(config: AppConfig) -> float:
    return config.runtime.studio_rate_limit_cooldown_seconds or 30.0


def _resolve_download_outputs(config: AppConfig) -> bool:
    return config.runtime.download_outputs


def _progress(message: str) -> None:
    timestamp = datetime.now().strftime("%H:%M:%S")
    print(f"{timestamp} [nblm] {message}", flush=True)


def _emit_prepare_log(reporter, message: str) -> None:
    if reporter is not None:
        reporter(message)


def _format_skip_ranges(skip_ranges: tuple[str, ...]) -> str:
    preview = ", ".join(skip_ranges[:4])
    if len(skip_ranges) <= 4:
        return preview
    return f"{preview}, +{len(skip_ranges) - 4} more"


def _resolve_input_path(value: str | None, config: AppConfig) -> Path:
    if value:
        return Path(value)
    if config.source.path:
        return Path(config.source.path)
    raise ChunkerError("Input file is required. Pass a path or set `source.path` in your config.")


def _resolve_chunk_output_dir(value: str | None, input_path: Path, config: AppConfig) -> Path:
    if value:
        return Path(value)
    if config.chunking.output_dir:
        return Path(config.chunking.output_dir)
    return input_path.with_name(f"{input_path.stem}-chunks")


def _resolve_chunks_directory(value: str | None, config: AppConfig) -> Path:
    if value:
        return Path(value)
    if config.chunking.output_dir:
        return Path(config.chunking.output_dir)
    raise ChunkerError(
        "Chunks directory is required. Pass a directory or set `chunking.output_dir` in your config."
    )


def _resolve_studio_output_dir(
    value: str | None,
    *,
    config: AppConfig,
    chunk_output_dir: Path | None,
) -> Path:
    if value:
        return Path(value)
    if chunk_output_dir is not None:
        return chunk_output_dir / "studio"
    if config.chunking.output_dir:
        return Path(config.chunking.output_dir) / "studio"
    return Path.cwd() / "nblm-studio"


def _resolve_run_state_path(config: AppConfig) -> Path | None:
    chunk_output_dir = config.chunking.output_dir
    if chunk_output_dir:
        candidate = Path(chunk_output_dir) / RUN_STATE_BASENAME
        if candidate.is_file():
            return candidate
    if config.source.path:
        candidate = (
            _resolve_chunk_output_dir(None, Path(config.source.path), config) / RUN_STATE_BASENAME
        )
        if candidate.is_file():
            return candidate
    return None


def _confirm_chunk_output_overwrite(
    output_dir: Path, *, assume_yes: bool, action_label: str
) -> None:
    if assume_yes or not output_dir.exists() or not output_dir.is_dir():
        return
    try:
        has_contents = any(output_dir.iterdir())
    except OSError as exc:
        raise ChunkerError(f"Could not inspect output folder {output_dir}: {exc}") from exc
    if not has_contents:
        return
    prompt = (
        f"Output folder already has files: {output_dir}\n"
        f"`nblm {action_label}` will overwrite chunk files, manifest.json, and saved run state there.\n"
        "Continue? [y/N]: "
    )
    try:
        answer = input(prompt)
    except EOFError as exc:
        raise ChunkerError(
            f"Output folder is not empty: {output_dir}. Re-run with `--yes` if you want to overwrite it."
        ) from exc
    if answer.strip().lower() not in {"y", "yes"}:
        raise ChunkerError("Aborted because the chunk output folder is not empty.")


def _confirm_quota_block_if_needed(
    run_state_path: Path | None,
    *,
    assume_yes: bool,
    action_label: str,
    studio_names: tuple[str, ...] = (),
) -> None:
    if assume_yes or run_state_path is None or not run_state_path.is_file():
        return
    quota_blocks = RunStateStore.load(run_state_path).quota_blocks(
        studio_names=studio_names or None
    )
    if not quota_blocks:
        return
    active_blocks: list[tuple[str, datetime, dict[str, object]]] = []
    for studio_name, quota_block in quota_blocks.items():
        blocked_until_text = quota_block.get("blocked_until")
        blocked_until = _parse_zulu_timestamp(blocked_until_text)
        if blocked_until is None:
            continue
        active_blocks.append((studio_name, blocked_until, quota_block))
    if not active_blocks:
        return
    now = datetime.now().astimezone()
    active_blocks = [entry for entry in active_blocks if entry[1] > now]
    if not active_blocks:
        return
    lines = [
        f"- {studio_name.replace('_', '-')} until {blocked_until.astimezone().strftime('%Y-%m-%d %H:%M:%S %Z')}"
        for studio_name, blocked_until, _ in active_blocks
    ]
    prompt = (
        "Saved run state says these NotebookLM Studio quotas are likely still blocked:\n"
        + "\n".join(lines)
        + "\n"
        + f"`nblm {action_label}` may still continue other Studio types, but the blocked ones will probably fail again before then.\n"
        "Try anyway? [y/N]: "
    )
    try:
        answer = input(prompt)
    except EOFError as exc:
        raise ChunkerError(
            "NotebookLM quota is likely still blocked for one or more Studio types. "
            "Re-run later or pass `--yes` to try anyway."
        ) from exc
    if answer.strip().lower() not in {"y", "yes"}:
        raise ChunkerError(
            "Aborted because one or more NotebookLM Studio quotas are likely still blocked."
        )


def _parse_zulu_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone()
    except ValueError:
        return None


def _path_or_none(value: str | None) -> Path | None:
    return Path(value) if value else None


def _require_file(path: Path, *, label: str) -> None:
    if not path.exists():
        raise ChunkerError(f"{label} not found: {path}")
    if not path.is_file():
        raise ChunkerError(f"{label} is not a file: {path}")


def _require_directory(path: Path, *, label: str) -> None:
    if not path.exists():
        raise ChunkerError(f"{label} not found: {path}")
    if not path.is_dir():
        raise ChunkerError(f"{label} is not a directory: {path}")
