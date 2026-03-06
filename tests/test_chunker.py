from __future__ import annotations

from pathlib import Path
from unittest import TestCase

from notebooklm_chunker.chunker import build_sections, chunk_document
from notebooklm_chunker.models import Block, ChunkingSettings


class ChunkerTests(TestCase):
    def test_build_sections_tracks_heading_hierarchy(self) -> None:
        blocks = [
            Block(kind="heading", text="Chapter 1", level=1),
            Block(kind="paragraph", text="Intro"),
            Block(kind="heading", text="Section 1.1", level=2),
            Block(kind="paragraph", text="Details"),
        ]

        sections = build_sections(blocks, "book")

        self.assertEqual([section.heading_path for section in sections], [("Chapter 1",), ("Chapter 1", "Section 1.1")])

    def test_chunk_document_prefers_heading_boundaries_near_target_pages(self) -> None:
        blocks = []
        for page in range(1, 7):
            blocks.extend(
                [
                    Block(kind="heading", text=f"Section {page}", level=1, page=page),
                    Block(kind="paragraph", text="Body text", page=page),
                ]
            )

        chunks = chunk_document(
            blocks,
            Path("book.pdf"),
            settings=ChunkingSettings(target_pages=3.0, min_pages=2.5, max_pages=4.0, words_per_page=250),
        )

        self.assertEqual(len(chunks), 2)
        self.assertEqual((chunks[0].start_page, chunks[0].end_page), (1, 3))
        self.assertEqual((chunks[1].start_page, chunks[1].end_page), (4, 6))
        self.assertIn("# Section 3", chunks[0].markdown)
        self.assertNotIn("# Section 4", chunks[0].markdown)

    def test_chunk_document_splits_large_sections(self) -> None:
        text = " ".join(["word"] * 1200)
        blocks = [Block(kind="heading", text="Chapter 1", level=1), Block(kind="paragraph", text=text)]

        chunks = chunk_document(
            blocks,
            Path("book.md"),
            settings=ChunkingSettings(target_pages=0.75, min_pages=0.5, max_pages=1.0, words_per_page=500),
        )

        self.assertGreaterEqual(len(chunks), 2)
        self.assertTrue(chunks[0].heading_path[0].startswith("Chapter 1"))
