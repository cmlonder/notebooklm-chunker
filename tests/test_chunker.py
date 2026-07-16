from __future__ import annotations

from pathlib import Path
from unittest import TestCase

from notebooklm_chunker.chunker import (
    analyze_chunk_quality,
    build_sections,
    chunk_document,
    chunk_filename,
    chunk_filenames,
)
from notebooklm_chunker.models import Block, Chunk, ChunkingSettings


def _make_chunk(
    chunk_id: int,
    *,
    primary_heading: str,
    estimated_pages: float,
    source_file: str = "book.pdf",
    word_count: int = 1500,
) -> Chunk:
    heading_path = (primary_heading,) if primary_heading else ("book",)
    return Chunk(
        chunk_id=chunk_id,
        source_file=source_file,
        heading_path=heading_path,
        primary_heading=primary_heading,
        markdown=f"# {primary_heading}\n\nBody\n",
        word_count=word_count,
        estimated_pages=estimated_pages,
        start_page=chunk_id,
        end_page=chunk_id,
    )


class ChunkerTests(TestCase):
    def test_build_sections_tracks_heading_hierarchy(self) -> None:
        blocks = [
            Block(kind="heading", text="Chapter 1", level=1),
            Block(kind="paragraph", text="Intro"),
            Block(kind="heading", text="Section 1.1", level=2),
            Block(kind="paragraph", text="Details"),
        ]

        sections = build_sections(blocks, "book")

        self.assertEqual(
            [section.heading_path for section in sections],
            [("Chapter 1",), ("Chapter 1", "Section 1.1")],
        )

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
            settings=ChunkingSettings(
                target_pages=3.0, min_pages=2.5, max_pages=4.0, words_per_page=250
            ),
        )

        self.assertEqual(len(chunks), 2)
        self.assertEqual((chunks[0].start_page, chunks[0].end_page), (1, 3))
        self.assertEqual((chunks[1].start_page, chunks[1].end_page), (4, 6))
        self.assertIn("# Section 3", chunks[0].markdown)
        self.assertNotIn("# Section 4", chunks[0].markdown)

    def test_chunk_document_prefers_cutting_at_shallow_headings(self) -> None:
        blocks = [
            Block(kind="heading", text="Chapter 1", level=1, page=1),
            Block(kind="paragraph", text="Body", page=1),
            Block(kind="heading", text="Section 1.1", level=2, page=2),
            Block(kind="paragraph", text="Body", page=2),
            Block(kind="heading", text="Chapter 2", level=1, page=3),
            Block(kind="paragraph", text="Body", page=3),
            Block(kind="heading", text="Section 2.1", level=2, page=4),
            Block(kind="paragraph", text="Body", page=4),
        ]

        # Both a 2+2 split at "Chapter 2" (depth 1) and an equally sized split
        # at "Section 2.1" (depth 2) satisfy the size constraints; the depth
        # penalty must steer the cut to the chapter boundary.
        chunks = chunk_document(
            blocks,
            Path("book.pdf"),
            settings=ChunkingSettings(
                target_pages=2.0, min_pages=1.0, max_pages=3.0, words_per_page=100
            ),
        )

        self.assertEqual(len(chunks), 2)
        self.assertEqual((chunks[0].start_page, chunks[0].end_page), (1, 2))
        self.assertEqual((chunks[1].start_page, chunks[1].end_page), (3, 4))
        self.assertIn("Chapter 2", chunks[1].markdown.splitlines()[0])

    def test_chunk_document_raises_target_to_min_pages_when_target_is_below_min(self) -> None:
        blocks = []
        for page in range(1, 8):
            blocks.extend(
                [
                    Block(kind="heading", text=f"Section {page}", level=1, page=page),
                    Block(kind="paragraph", text="Body text", page=page),
                ]
            )

        # target below the hard min bound is unsatisfiable; the chunker must
        # treat min_pages as the effective target instead of failing.
        chunks = chunk_document(
            blocks,
            Path("book.pdf"),
            settings=ChunkingSettings(
                target_pages=2.0, min_pages=3.0, max_pages=4.0, words_per_page=250
            ),
        )

        self.assertTrue(chunks)
        for chunk in chunks[:-1]:
            span = (chunk.end_page or 0) - (chunk.start_page or 0) + 1
            self.assertGreaterEqual(span, 3)

    def test_chunk_document_splits_large_sections(self) -> None:
        text = " ".join(["word"] * 1200)
        blocks = [
            Block(kind="heading", text="Chapter 1", level=1),
            Block(kind="paragraph", text=text),
        ]

        chunks = chunk_document(
            blocks,
            Path("book.md"),
            settings=ChunkingSettings(
                target_pages=0.75, min_pages=0.5, max_pages=1.0, words_per_page=500
            ),
        )

        self.assertGreaterEqual(len(chunks), 2)
        self.assertTrue(chunks[0].heading_path[0].startswith("Chapter 1"))

    def test_chunk_filename_uses_primary_heading_with_leading_numbers(self) -> None:
        blocks = [
            Block(kind="heading", text="26 Domain-Driven Design Quickly", level=1, page=1),
            Block(kind="paragraph", text="Body", page=1),
        ]

        chunks = chunk_document(
            blocks,
            Path("book.pdf"),
            settings=ChunkingSettings(
                target_pages=1.0, min_pages=0.5, max_pages=2.0, words_per_page=250
            ),
        )

        self.assertEqual(chunks[0].primary_heading, "26 Domain-Driven Design Quickly")
        self.assertEqual(chunk_filename(chunks[0]), "c001-domain-driven-design-quickly.md")

    def test_chunk_filenames_add_page_ranges_for_duplicate_headings(self) -> None:
        chunks = [
            Chunk(
                chunk_id=1,
                source_file="book.pdf",
                heading_path=("Book", "Origins"),
                primary_heading="Origins",
                markdown="# Book\n\n## Origins\n\nBody\n",
                word_count=3,
                estimated_pages=3.0,
                start_page=30,
                end_page=32,
            ),
            Chunk(
                chunk_id=2,
                source_file="book.pdf",
                heading_path=("Book", "Origins"),
                primary_heading="Origins",
                markdown="# Book\n\n## Origins\n\nBody\n",
                word_count=3,
                estimated_pages=3.0,
                start_page=34,
                end_page=36,
            ),
        ]

        filenames = chunk_filenames(chunks)

        self.assertEqual(filenames[1], "c001-origins-p30-32.md")
        self.assertEqual(filenames[2], "c002-origins-p34-36.md")


class ChunkQualityTests(TestCase):
    _SETTINGS = ChunkingSettings(
        target_pages=3.0, min_pages=2.5, max_pages=4.0, words_per_page=500
    )

    def _codes(self, findings, chunk_id: int) -> set[str]:
        return {finding.code for finding in findings if finding.chunk_id == chunk_id}

    def test_clean_document_yields_no_findings(self) -> None:
        chunks = [
            _make_chunk(1, primary_heading="Introduction", estimated_pages=3.0),
            _make_chunk(2, primary_heading="Methods", estimated_pages=3.2),
            _make_chunk(3, primary_heading="Results", estimated_pages=2.8),
        ]

        self.assertEqual(analyze_chunk_quality(chunks, self._SETTINGS), [])

    def test_flags_too_short_and_too_long_chunks(self) -> None:
        chunks = [
            _make_chunk(1, primary_heading="Short Section", estimated_pages=1.0),
            _make_chunk(2, primary_heading="Long Section", estimated_pages=6.0),
            _make_chunk(3, primary_heading="Ending", estimated_pages=3.0),
        ]

        findings = analyze_chunk_quality(chunks, self._SETTINGS)

        self.assertIn("too_short", self._codes(findings, 1))
        self.assertIn("too_long", self._codes(findings, 2))
        too_short = next(f for f in findings if f.code == "too_short")
        self.assertEqual(too_short.severity, "warn")

    def test_short_final_chunk_is_only_info(self) -> None:
        chunks = [
            _make_chunk(1, primary_heading="Body", estimated_pages=3.0),
            _make_chunk(2, primary_heading="Appendix", estimated_pages=0.5),
        ]

        findings = analyze_chunk_quality(chunks, self._SETTINGS)

        tail = next(f for f in findings if f.chunk_id == 2 and f.code == "too_short")
        self.assertEqual(tail.severity, "info")

    def test_flags_duplicate_headings(self) -> None:
        chunks = [
            _make_chunk(1, primary_heading="Introduction", estimated_pages=3.0),
            _make_chunk(2, primary_heading="introduction", estimated_pages=3.0),
            _make_chunk(3, primary_heading="Conclusion", estimated_pages=3.0),
        ]

        findings = analyze_chunk_quality(chunks, self._SETTINGS)

        self.assertIn("duplicate_heading", self._codes(findings, 1))
        self.assertIn("duplicate_heading", self._codes(findings, 2))
        self.assertNotIn("duplicate_heading", self._codes(findings, 3))

    def test_flags_missing_heading_variants(self) -> None:
        chunks = [
            _make_chunk(1, primary_heading="", estimated_pages=3.0),
            _make_chunk(2, primary_heading="Page 12", estimated_pages=3.0),
            _make_chunk(3, primary_heading="book", estimated_pages=3.0),
        ]

        findings = analyze_chunk_quality(chunks, self._SETTINGS)

        self.assertIn("no_heading", self._codes(findings, 1))
        self.assertIn("no_heading", self._codes(findings, 2))
        # Filename fallback is a softer signal.
        stem_finding = next(
            f for f in findings if f.chunk_id == 3 and f.code == "no_heading"
        )
        self.assertEqual(stem_finding.severity, "info")

    def test_flags_mid_section_cut_from_part_suffix(self) -> None:
        chunks = [
            _make_chunk(1, primary_heading="Chapter 1 (Part 1)", estimated_pages=3.0),
            _make_chunk(2, primary_heading="Chapter 1 (Part 2)", estimated_pages=3.0),
        ]

        findings = analyze_chunk_quality(chunks, self._SETTINGS)

        self.assertNotIn("mid_section_cut", self._codes(findings, 1))
        self.assertIn("mid_section_cut", self._codes(findings, 2))

    def test_findings_are_sorted_by_chunk_then_code(self) -> None:
        chunks = [
            _make_chunk(2, primary_heading="Introduction", estimated_pages=3.0),
            _make_chunk(1, primary_heading="Introduction", estimated_pages=1.0),
        ]

        findings = analyze_chunk_quality(chunks, self._SETTINGS)
        keys = [(f.chunk_id, f.code) for f in findings]

        self.assertEqual(keys, sorted(keys))

    def test_mid_section_cut_detected_from_real_split(self) -> None:
        text = " ".join(["word"] * 1200)
        blocks = [
            Block(kind="heading", text="Chapter 1", level=1),
            Block(kind="paragraph", text=text),
        ]
        settings = ChunkingSettings(
            target_pages=0.75, min_pages=0.5, max_pages=1.0, words_per_page=500
        )

        chunks = chunk_document(blocks, Path("book.md"), settings=settings)
        findings = analyze_chunk_quality(chunks, settings)

        self.assertTrue(any(f.code == "mid_section_cut" for f in findings))
