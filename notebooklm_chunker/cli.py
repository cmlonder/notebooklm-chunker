from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

from notebooklm_chunker.chunker import chunk_document
from notebooklm_chunker.config import AppConfig, load_config, write_config_template
from notebooklm_chunker.doctor import format_doctor_report, run_doctor
from notebooklm_chunker.exporters import export_markdown_chunks
from notebooklm_chunker.models import ChunkingSettings, ExportResult
from notebooklm_chunker.parsers import ChunkerError, parse_document
from notebooklm_chunker.uploaders.notebooklm_py import (
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
    subparsers = parser.add_subparsers(dest="command", required=True)

    login_parser = subparsers.add_parser("login", help="Run `notebooklm login` for notebooklm-py authentication.")
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

    init_parser = subparsers.add_parser("init", help="Write a workflow config file with chunking and Studio settings.")
    init_parser.add_argument("-o", "--output", default="nblm.toml", help="Where to write the config file.")
    init_parser.add_argument("--target-pages", type=float, default=3.0, help="Default target estimated pages per chunk.")
    init_parser.add_argument("--min-pages", type=float, default=2.5, help="Default minimum estimated pages per chunk.")
    init_parser.add_argument("--max-pages", type=float, default=4.0, help="Default maximum estimated pages per chunk.")
    init_parser.add_argument("--words-per-page", type=int, default=500, help="Default word heuristic for one page.")
    init_parser.add_argument("--force", action="store_true", help="Overwrite an existing config file.")
    init_parser.set_defaults(handler=_handle_init)

    prepare_parser = subparsers.add_parser("prepare", help="Parse a document and export Markdown chunks.")
    _add_config_argument(prepare_parser)
    _add_prepare_arguments(prepare_parser)
    prepare_parser.set_defaults(handler=_handle_prepare)

    upload_parser = subparsers.add_parser("upload", help="Upload existing chunks to NotebookLM.")
    _add_config_argument(upload_parser)
    upload_parser.add_argument("directory", nargs="?", help="Directory that contains exported Markdown chunks.")
    upload_parser.add_argument("--notebook-id", help="Existing notebook ID to upload into.")
    upload_parser.add_argument("--notebook-title", help="Notebook title to create when notebook ID is not provided.")
    upload_parser.add_argument(
        "--max-parallel-chunks",
        type=int,
        default=None,
        help="How many chunk uploads to process at once. Defaults to `runtime.max_parallel_chunks` or 1.",
    )
    upload_parser.set_defaults(handler=_handle_upload)

    studios_parser = subparsers.add_parser("studios", help="Generate enabled Studio outputs for an existing notebook.")
    _add_config_argument(studios_parser)
    studios_parser.add_argument("--notebook-id", help="Notebook ID to run Studio generation against.")
    studios_parser.add_argument(
        "-o",
        "--output-dir",
        help="Directory for Studio downloads when `output_path` is not set in config.",
    )
    studios_parser.set_defaults(handler=_handle_studios)

    run_parser = subparsers.add_parser(
        "run",
        help="Prepare a document, create a fresh notebook run, then generate enabled Studio outputs.",
    )
    _add_config_argument(run_parser)
    _add_prepare_arguments(run_parser)
    run_parser.add_argument("--notebook-id", help="Existing notebook ID to upload into.")
    run_parser.add_argument("--notebook-title", help="Notebook title to create when notebook ID is not provided.")
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
    resume_parser.add_argument("--notebook-id", help="Resume against an explicit notebook ID from the saved run state.")
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
    parser.add_argument("input", nargs="?", help="Source document path. Falls back to `source.path` in config.")
    parser.add_argument(
        "-o",
        "--output-dir",
        help="Chunk output directory. Defaults to `chunking.output_dir` or <input-stem>-chunks.",
    )
    parser.add_argument("--target-pages", type=float, default=None, help="Target estimated pages per chunk.")
    parser.add_argument("--min-pages", type=float, default=None, help="Minimum estimated pages per chunk.")
    parser.add_argument("--max-pages", type=float, default=None, help="Maximum estimated pages per chunk.")
    parser.add_argument("--words-per-page", type=int, default=None, help="Word heuristic for one page.")
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
        rename_remote_titles=config.runtime.rename_remote_titles,
        reporter=_progress,
    )
    print(f"Notebook ID: {notebook_id}")
    print(f"Uploaded sources: {len(uploaded)}")
    return 0


def _handle_studios(args: argparse.Namespace) -> int:
    config = load_config(_path_or_none(args.config))
    notebook_id = args.notebook_id or config.notebook.id
    if notebook_id is None:
        raise ChunkerError("Notebook ID is required for `studios`. Set `notebook.id` in config or pass `--notebook-id`.")

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
        max_parallel_heavy_studios=_resolve_max_parallel_heavy_studios(config),
        studio_wait_timeout_seconds=_resolve_studio_wait_timeout_seconds(config),
        studio_create_retries=_resolve_studio_create_retries(config),
        studio_create_backoff_seconds=_resolve_studio_create_backoff_seconds(config),
        studio_rate_limit_cooldown_seconds=_resolve_studio_rate_limit_cooldown_seconds(config),
        rename_remote_titles=config.runtime.rename_remote_titles,
        reporter=_progress,
    )
    print(f"Notebook ID: {notebook_id}")
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
    settings = _resolve_chunking_settings(args, config)
    _, export_result = _prepare_document(
        input_path,
        output_dir,
        settings,
        pdf_skip_ranges=_resolve_skip_ranges(args, config),
    )

    uploader = NotebookLMPyUploader()
    notebook_id, uploaded, studios = uploader.ingest_directory(
        output_dir,
        notebook_id=args.notebook_id or config.notebook.id,
        notebook_title=getattr(args, "notebook_title", None) or config.notebook.title or input_path.stem,
        studios=config.studios,
        studio_output_dir=_resolve_studio_output_dir(None, config=config, chunk_output_dir=output_dir),
        max_parallel_chunks=_resolve_max_parallel_chunks(args, config),
        max_parallel_heavy_studios=_resolve_max_parallel_heavy_studios(config),
        studio_wait_timeout_seconds=_resolve_studio_wait_timeout_seconds(config),
        studio_create_retries=_resolve_studio_create_retries(config),
        studio_create_backoff_seconds=_resolve_studio_create_backoff_seconds(config),
        studio_rate_limit_cooldown_seconds=_resolve_studio_rate_limit_cooldown_seconds(config),
        rename_remote_titles=config.runtime.rename_remote_titles,
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
    blocks = parse_document(
        input_path,
        pdf_skip_ranges=pdf_skip_ranges,
    )
    page_count = len({block.page for block in blocks if block.page is not None})
    heading_count = sum(1 for block in blocks if block.kind == "heading")
    paragraph_count = sum(1 for block in blocks if block.kind == "paragraph")
    summary = f"parse: {len(blocks)} block(s), {heading_count} heading(s), {paragraph_count} paragraph(s)"
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
        args.target_pages
        if args.target_pages is not None
        else config.chunking.target_pages
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
