from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest import TestCase

from notebooklm_chunker.exporters import export_markdown_chunks
from notebooklm_chunker.models import Chunk


class ExporterTests(TestCase):
    def test_export_writes_manifest_and_markdown(self) -> None:
        chunk = Chunk(
            chunk_id=1,
            source_file="book.md",
            heading_path=("Chapter 1",),
            primary_heading="Chapter 1",
            markdown="# Chapter 1\n\nHello\n",
            word_count=3,
            estimated_pages=0.01,
        )

        with tempfile.TemporaryDirectory() as directory:
            result = export_markdown_chunks([chunk], Path(directory))
            manifest = json.loads(Path(result.manifest_path).read_text(encoding="utf-8"))

        self.assertEqual(len(result.files), 1)
        self.assertEqual(manifest[0]["file"], "001-chapter-1.md")
        self.assertEqual(manifest[0]["primary_heading"], "Chapter 1")

    def test_export_removes_stale_chunk_markdown_files(self) -> None:
        chunk = Chunk(
            chunk_id=1,
            source_file="book.md",
            heading_path=("Chapter 1",),
            primary_heading="Chapter 1",
            markdown="# Chapter 1\n\nHello\n",
            word_count=3,
            estimated_pages=0.01,
        )

        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            stale = output_dir / "999-old-chunk.md"
            stale.write_text("# Old\n\nBody\n", encoding="utf-8")

            export_markdown_chunks([chunk], output_dir)

            self.assertFalse(stale.exists())
            self.assertTrue((output_dir / "001-chapter-1.md").exists())
