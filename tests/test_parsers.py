from __future__ import annotations

import tempfile
import textwrap
import zipfile
from pathlib import Path
from unittest import TestCase

from notebooklm_chunker.parsers import (
    _blocks_from_pdf_pages_with_toc,
    _clean_pdf_page_entries,
    _line_matches_toc_title,
    _pdf_page_numbers,
    inspect_pdf_page_selection,
    parse_document,
)


class ParserTests(TestCase):
    def test_markdown_parser_detects_headings(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "book.md"
            source.write_text(
                textwrap.dedent(
                    """
                    # Chapter 1

                    Intro text.

                    ## Section 1.1

                    More text.
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )

            blocks = parse_document(source)

        self.assertEqual(
            [block.kind for block in blocks], ["heading", "paragraph", "heading", "paragraph"]
        )
        self.assertEqual(blocks[0].text, "Chapter 1")
        self.assertEqual(blocks[2].level, 2)

    def test_text_parser_merges_numbered_heading_prefix_with_following_title(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "book.txt"
            source.write_text(
                "1.1\nIntroduction\nBody paragraph.\n",
                encoding="utf-8",
            )

            blocks = parse_document(source)

        self.assertEqual([block.kind for block in blocks], ["heading", "paragraph"])
        self.assertEqual(blocks[0].text, "1.1 Introduction")

    def test_html_parser_detects_headings_and_paragraphs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "book.html"
            source.write_text(
                "<html><body><h1>Chapter 1</h1><p>Hello <strong>world</strong></p></body></html>",
                encoding="utf-8",
            )

            blocks = parse_document(source)

        self.assertEqual([block.kind for block in blocks], ["heading", "paragraph"])
        self.assertEqual(blocks[1].text, "Hello world")

    def test_epub_parser_reads_spine_order(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "book.epub"
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr(
                    "META-INF/container.xml",
                    textwrap.dedent(
                        """
                        <?xml version="1.0" encoding="UTF-8"?>
                        <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
                          <rootfiles>
                            <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
                          </rootfiles>
                        </container>
                        """
                    ).strip(),
                )
                archive.writestr(
                    "OEBPS/content.opf",
                    textwrap.dedent(
                        """
                        <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
                          <manifest>
                            <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
                          </manifest>
                          <spine>
                            <itemref idref="chapter1"/>
                          </spine>
                        </package>
                        """
                    ).strip(),
                )
                archive.writestr(
                    "OEBPS/chapter1.xhtml",
                    "<html><body><h1>Chapter 1</h1><p>EPUB body.</p></body></html>",
                )

            blocks = parse_document(source)

        self.assertEqual([block.kind for block in blocks], ["heading", "paragraph"])
        self.assertEqual(blocks[0].text, "Chapter 1")

    def test_pdf_page_numbers_without_ranges_keep_all_pages(self) -> None:
        page_numbers = list(_pdf_page_numbers(10))
        self.assertEqual(page_numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

    def test_pdf_page_numbers_skip_explicit_ranges(self) -> None:
        page_numbers = list(
            _pdf_page_numbers(
                10,
                skip_ranges=("1-2", "5", "9-20"),
            )
        )
        self.assertEqual(page_numbers, [3, 4, 6, 7, 8])

    def test_pdf_page_numbers_merge_overlapping_ranges(self) -> None:
        page_numbers = list(
            _pdf_page_numbers(
                12,
                skip_ranges=("1-2", "2-5", "8", "99-120"),
            )
        )
        self.assertEqual(page_numbers, [6, 7, 9, 10, 11, 12])

    def test_pdf_page_numbers_reject_invalid_range_syntax(self) -> None:
        with self.assertRaisesRegex(Exception, "Invalid PDF skip range"):
            list(_pdf_page_numbers(10, skip_ranges=("x-y",)))

    def test_pdf_page_numbers_reject_excluding_entire_document(self) -> None:
        with self.assertRaisesRegex(Exception, "exclude the entire document"):
            list(_pdf_page_numbers(4, skip_ranges=("1-10",)))

    def test_inspect_pdf_page_selection_reports_included_and_skipped_pages(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "book.pdf"
            source.write_bytes(b"%PDF-1.4 placeholder")

            from unittest.mock import patch

            with patch("notebooklm_chunker.parsers._pdf_total_pages", return_value=10):
                selection = inspect_pdf_page_selection(source, skip_ranges=("1-2", "5", "99-100"))

        self.assertEqual(selection.total_pages, 10)
        self.assertEqual(selection.included_pages, (3, 4, 6, 7, 8, 9, 10))
        self.assertEqual(selection.skipped_pages, (1, 2, 5))

    def test_pdf_with_embedded_toc_uses_outline_headings_and_levels(self) -> None:
        fitz = __import__("fitz")

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "book.pdf"
            document = fitz.open()
            page_texts = [
                "Chapter One\nIntro body text about the first chapter.",
                "1.1 History\nDetails about history that go on for a while.",
                "Chapter Two\nSecond chapter body text.",
            ]
            for text in page_texts:
                page = document.new_page()
                page.insert_text((72, 72), text)
            document.set_toc(
                [
                    [1, "Chapter One", 1],
                    [2, "History", 2],
                    [1, "Chapter Two", 3],
                ]
            )
            document.save(str(source))
            document.close()

            blocks = parse_document(source)

        headings = [(block.level, block.text, block.page) for block in blocks if block.kind == "heading"]
        self.assertEqual(
            headings,
            [
                (1, "Chapter One", 1),
                (2, "History", 2),
                (1, "Chapter Two", 3),
            ],
        )
        paragraphs = [block for block in blocks if block.kind == "paragraph"]
        self.assertTrue(any("first chapter" in block.text for block in paragraphs))

    def test_blocks_from_pdf_pages_with_toc_places_unmatched_heading_at_page_top(self) -> None:
        blocks = _blocks_from_pdf_pages_with_toc(
            [
                (1, ["Some body text", "More body text"]),
                (2, ["Continuation text"]),
            ],
            [(1, "Missing Heading Title", 1)],
        )

        self.assertEqual(blocks[0].kind, "heading")
        self.assertEqual(blocks[0].text, "Missing Heading Title")
        self.assertEqual(blocks[0].level, 1)
        self.assertEqual(blocks[0].page, 1)
        self.assertEqual(blocks[1].kind, "paragraph")

    def test_blocks_from_pdf_pages_with_toc_skips_headings_on_skipped_pages(self) -> None:
        blocks = _blocks_from_pdf_pages_with_toc(
            [(5, ["Chapter Three", "Body text"])],
            [
                (1, "Chapter One", 1),
                (1, "Chapter Three", 5),
                (1, "Chapter Nine", 99),
            ],
        )

        headings = [block.text for block in blocks if block.kind == "heading"]
        self.assertEqual(headings, ["Chapter Three"])

    def test_line_matches_toc_title_ignores_case_and_numbering(self) -> None:
        self.assertTrue(_line_matches_toc_title("1.2 Airline Deregulation", "Airline Deregulation"))
        self.assertTrue(_line_matches_toc_title("AIRLINE DEREGULATION", "Airline Deregulation"))
        self.assertTrue(_line_matches_toc_title("Airline Deregulation", "1.2 Airline Deregulation"))
        self.assertFalse(_line_matches_toc_title("Airline Deregulation Act", "Airline Deregulation"))

    def test_clean_pdf_page_entries_removes_running_titles_with_embedded_page_numbers(self) -> None:
        cleaned = _clean_pdf_page_entries(
            [
                (2, ["2|Domain Driven Design Quickly", "Body line A"]),
                (4, ["4|Domain Driven Design Quickly", "Body line B"]),
                (6, ["6|Domain Driven Design Quickly", "Body line C"]),
            ]
        )

        self.assertEqual(cleaned[0][1], ["Body line A"])
        self.assertEqual(cleaned[1][1], ["Body line B"])
        self.assertEqual(cleaned[2][1], ["Body line C"])

    def test_clean_pdf_page_entries_removes_repeated_running_titles_and_page_numbers(self) -> None:
        cleaned = _clean_pdf_page_entries(
            [
                (
                    30,
                    [
                        "Body line A",
                        "Body line B",
                        "4",
                        "1",
                        "Origins",
                    ],
                ),
                (
                    31,
                    [
                        "Body line C",
                        "Body line D",
                        "5",
                        "1",
                        "Origins",
                    ],
                ),
                (
                    32,
                    [
                        "1.3",
                        "Airline Deregulation",
                        "Body line E",
                        "6",
                        "1",
                        "Origins",
                    ],
                ),
            ]
        )

        self.assertEqual(cleaned[0][1], ["Body line A", "Body line B"])
        self.assertEqual(cleaned[1][1], ["Body line C", "Body line D"])
        self.assertEqual(cleaned[2][1], ["1.3", "Airline Deregulation", "Body line E"])
