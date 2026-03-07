from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

from notebooklm_chunker.chunker import chunk_filename
from notebooklm_chunker.models import Chunk, ExportResult


def export_markdown_chunks(
    chunks: list[Chunk],
    output_dir: Path,
    *,
    reporter: Callable[[str], None] | None = None,
) -> ExportResult:
    output_dir.mkdir(parents=True, exist_ok=True)
    expected_filenames = {chunk_filename(chunk) for chunk in chunks}
    removed_stale = _remove_stale_chunk_files(output_dir, expected_filenames)
    if reporter is not None and removed_stale:
        reporter(f"export: removed {removed_stale} stale chunk file(s)")

    manifest_entries: list[dict[str, object]] = []
    written_files: list[str] = []

    total_chunks = len(chunks)
    for index, chunk in enumerate(chunks, start=1):
        filename = chunk_filename(chunk)
        chunk_path = output_dir / filename
        chunk_path.write_text(chunk.markdown, encoding="utf-8")
        written_files.append(str(chunk_path))
        manifest_entries.append(
            {
                "chunk_id": chunk.chunk_id,
                "file": filename,
                "source_file": chunk.source_file,
                "primary_heading": chunk.primary_heading,
                "heading_path": list(chunk.heading_path),
                "word_count": chunk.word_count,
                "estimated_pages": chunk.estimated_pages,
                "start_page": chunk.start_page,
                "end_page": chunk.end_page,
            }
        )
        if reporter is not None:
            reporter(
                f"export: {index}/{total_chunks} {filename}"
                f"{_chunk_page_suffix(chunk)}"
                f" (~{chunk.estimated_pages:.2f} pages)"
            )

    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest_entries, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    return ExportResult(
        output_dir=str(output_dir),
        manifest_path=str(manifest_path),
        files=tuple(written_files),
    )


def _chunk_page_suffix(chunk: Chunk) -> str:
    if chunk.start_page is None and chunk.end_page is None:
        return ""
    if chunk.start_page == chunk.end_page:
        return f" (p.{chunk.start_page})"
    if chunk.start_page is not None and chunk.end_page is not None:
        return f" (p.{chunk.start_page}-{chunk.end_page})"
    if chunk.start_page is not None:
        return f" (from p.{chunk.start_page})"
    return f" (to p.{chunk.end_page})"


def _remove_stale_chunk_files(output_dir: Path, expected_filenames: set[str]) -> int:
    removed = 0
    for path in output_dir.glob("*.md"):
        if path.name not in expected_filenames and path.is_file():
            path.unlink()
            removed += 1
    return removed
