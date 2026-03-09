from __future__ import annotations

import argparse
import sys
import json
import asyncio
from datetime import datetime
from pathlib import Path

from notebooklm_chunker import __version__
from notebooklm_chunker.chunker import chunk_document
from notebooklm_chunker.config import AppConfig, load_config
from notebooklm_chunker.doctor import format_doctor_report, run_doctor
from notebooklm_chunker.exporters import export_markdown_chunks
from notebooklm_chunker.models import ChunkingSettings
from notebooklm_chunker.parsers import ChunkerError, parse_document
from notebooklm_chunker.uploaders.notebooklm_py import (
    NotebookLMPyUploader,
    run_notebooklm_login,
    run_notebooklm_logout,
)

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="nblm")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("login")
    subparsers.add_parser("logout")
    subparsers.add_parser("list-notebooks")
    subparsers.add_parser("doctor").add_argument("--config")
    
    inspect_parser = subparsers.add_parser("inspect")
    inspect_parser.add_argument("input", type=Path)
    
    prepare_parser = subparsers.add_parser("prepare")
    prepare_parser.add_argument("input", type=Path, nargs="?")
    prepare_parser.add_argument("-o", "--output-dir")
    prepare_parser.add_argument("--target-pages", type=float)
    prepare_parser.add_argument("--min-pages", type=float)
    prepare_parser.add_argument("--max-pages", type=float)
    prepare_parser.add_argument("--words-per-page", type=int)
    prepare_parser.add_argument("-y", "--yes", action="store_true")
    prepare_parser.add_argument("--config")

    upload_parser = subparsers.add_parser("upload")
    upload_parser.add_argument("directory", type=Path, nargs="?")
    upload_parser.add_argument("--notebook-id")
    upload_parser.add_argument("--notebook-title")
    upload_parser.add_argument("--max-parallel-chunks", type=int)
    upload_parser.add_argument("--rename-remote-titles", action="store_true")
    upload_parser.add_argument("--only-changed", action="store_true")
    upload_parser.add_argument("--config")

    return parser

def _progress(message: str) -> None:
    print(f"{datetime.now().strftime('%H:%M:%S')} [nblm] {message}", flush=True)

def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "login":
            asyncio.run(run_notebooklm_login())
            return 0
        if args.command == "logout":
            asyncio.run(run_notebooklm_logout())
            return 0
        if args.command == "inspect":
            blocks = parse_document(args.input)
            print(json.dumps({"pages": len({b.page for b in blocks if b.page is not None})}))
            return 0
        if args.command == "doctor":
            report = run_doctor(Path(args.config) if args.config else None)
            print(format_doctor_report(report))
            return 0
        if args.command == "prepare":
            config = load_config(Path(args.config) if args.config else None)
            # Input prioritizaton: Arg > Config (but skip 'your-document.pdf')
            input_path = args.input
            if not input_path and config.source.path and "your-document.pdf" not in config.source.path:
                input_path = Path(config.source.path)
            if not input_path: raise ChunkerError("No input PDF specified.")
            
            output_dir = Path(args.output_dir) if args.output_dir else input_path.with_name(f"{input_path.stem}-chunks")
            settings = ChunkingSettings(
                target_pages=args.target_pages or config.chunking.target_pages or 3.0,
                min_pages=args.min_pages or config.chunking.min_pages or 0.1,
                max_pages=args.max_pages or config.chunking.max_pages or 50.0,
                words_per_page=args.words_per_page or config.chunking.words_per_page or 500
            )
            blocks = parse_document(input_path)
            chunks = chunk_document(blocks, input_path, settings=settings)
            export_markdown_chunks(chunks, output_dir, reporter=_progress)
            print(f"Chunks generated: {len(chunks)}")
            return 0
        if args.command == "upload":
            config = load_config(Path(args.config) if args.config else None)
            dir_path = args.directory or Path(config.chunking.output_dir)
            file_titles, source_map, include_only = {}, {}, None
            manifest_path = dir_path / "manifest.json"
            if manifest_path.exists():
                with open(manifest_path, "r") as f:
                    m_data = json.load(f)
                    for item in m_data:
                        file_titles[item["file"]] = item.get("primary_heading")
                        if item.get("source_id"): source_map[item["file"]] = item["source_id"]
                    if args.only_changed:
                        include_only = {i["file"] for i in m_data if i.get("synced") is not True}
            
            uploader = NotebookLMPyUploader()
            nb_id, results = uploader.upload_directory(
                dir_path, notebook_id=args.notebook_id or config.notebook.id,
                notebook_title=args.notebook_title or config.notebook.title or dir_path.name,
                max_parallel_chunks=args.max_parallel_chunks or 5,
                rename_remote_titles=True, include_files=include_only,
                file_titles=file_titles, source_map=source_map, reporter=_progress
            )
            print(f"Notebook ID: {nb_id}")
            print(f"Uploaded sources: {len(results)}")
            return 0
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
