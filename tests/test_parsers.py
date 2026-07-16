from __future__ import annotations

import tempfile
import textwrap
import zipfile
from pathlib import Path
from unittest import TestCase

from notebooklm_chunker.parsers import (
    _blocks_from_pdf_pages_with_toc,
    _blocks_from_text,
    _clean_pdf_page_entries,
    _dominant_font_size,
    _font_heading_levels,
    _font_heading_map,
    _line_matches_toc_title,
    _page_font_lines,
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

    def test_page_font_lines_uses_char_weighted_size_and_resists_drop_caps(self) -> None:
        page_dict = {
            "blocks": [
                {
                    "lines": [
                        # A drop-cap `T` at 40pt should not drag the line size up,
                        # because the bulk of the characters are body-sized.
                        {
                            "spans": [
                                {"text": "T", "size": 40.0},
                                {"text": "his is ordinary body text here.", "size": 12.0},
                            ]
                        },
                        {"spans": [{"text": "Chapter One", "size": 24.0}]},
                        # Whitespace-only / sizeless spans contribute nothing.
                        {"spans": [{"text": "   ", "size": 24.0}]},
                    ]
                }
            ]
        }

        records = _page_font_lines(page_dict)

        self.assertEqual(records[0], ("This is ordinary body text here.", 12.0))
        self.assertEqual(records[1], ("Chapter One", 24.0))
        self.assertEqual(len(records), 2)

    def test_dominant_font_size_is_char_weighted_mode(self) -> None:
        records = [
            ("A short heading", 24.0),
            ("A much longer stretch of ordinary body copy", 12.0),
            ("Another long ordinary body sentence to weigh", 12.0),
        ]

        self.assertEqual(_dominant_font_size(records), 12.0)

    def test_dominant_font_size_empty_records_return_none(self) -> None:
        self.assertIsNone(_dominant_font_size([]))

    def test_font_heading_levels_bucket_sizes_into_relative_levels(self) -> None:
        records = [
            ("Body", 10.0),
            ("Big Heading", 20.0),  # 2.0x body -> level 1
            ("Medium Heading", 13.0),  # 1.3x body -> level 2
            ("Barely Larger", 11.0),  # 1.1x body -> not a heading
        ]

        levels = _font_heading_levels(records, body_size=10.0)

        self.assertEqual(levels.get(20.0), 1)
        self.assertEqual(levels.get(13.0), 2)
        self.assertNotIn(11.0, levels)

    def test_font_heading_levels_all_one_size_yields_no_headings(self) -> None:
        records = [("Line one", 12.0), ("Line two", 12.0), ("Line three", 12.0)]

        self.assertEqual(_font_heading_levels(records, body_size=12.0), {})

    def test_font_heading_map_flags_larger_lines_with_levels_per_page(self) -> None:
        heading_map = _font_heading_map(
            [
                (
                    1,
                    [
                        ("Big Title", 20.0),
                        ("A long ordinary body sentence on the page", 10.0),
                    ],
                ),
                (
                    2,
                    [
                        ("Medium Heading", 13.0),
                        ("Another ordinary run of body text on this page", 10.0),
                    ],
                ),
            ]
        )

        self.assertEqual(heading_map.get((1, "Big Title")), 1)
        self.assertEqual(heading_map.get((2, "Medium Heading")), 2)
        # Body-sized lines never become headings.
        self.assertNotIn((1, "A long ordinary body sentence on the page"), heading_map)

    def test_font_heading_map_single_size_document_returns_empty(self) -> None:
        heading_map = _font_heading_map(
            [
                (1, [("Line one on page one", 12.0), ("Line two on page one", 12.0)]),
                (2, [("Line one on page two", 12.0)]),
            ]
        )

        self.assertEqual(heading_map, {})

    def test_blocks_from_text_font_signal_adds_heading_and_level(self) -> None:
        # Two short heading-like lines in a row: the pure text heuristic vetoes
        # the first because the following line is also short, but the font signal
        # rescues it and supplies level 1.
        blocks = _blocks_from_text(
            ["Introduction", "Overview", "Body paragraph that runs on for a while here."],
            page=1,
            font_heading_levels={"Introduction": 1, "Overview": 2},
        )

        headings = [(block.level, block.text) for block in blocks if block.kind == "heading"]
        self.assertIn((1, "Introduction"), headings)
        self.assertIn((2, "Overview"), headings)

    def test_blocks_from_text_font_signal_ignores_sentence_fragments(self) -> None:
        # A large-font promo sentence must not become a heading: it fails the
        # title-case / sanity gates even though the font map marks its size.
        line = "if you like the book please support"
        blocks = _blocks_from_text(
            [line, "More body text that continues on for a good while here."],
            page=1,
            font_heading_levels={line: 1},
        )

        self.assertTrue(all(block.kind != "heading" for block in blocks))

    def test_blocks_from_text_without_font_signal_is_unchanged(self) -> None:
        lines = ["Some ordinary body text.", "Another ordinary line of body text here."]

        self.assertEqual(
            _blocks_from_text(lines, page=1),
            _blocks_from_text(lines, page=1, font_heading_levels={}),
        )

    def test_pdf_without_toc_uses_font_size_to_detect_heading_and_level(self) -> None:
        fitz = __import__("fitz")

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "book.pdf"
            document = fitz.open()
            page = document.new_page()
            # Large-font heading, then several body lines at the normal size so
            # the body size is the document's dominant font.
            page.insert_text((72, 72), "Introduction", fontsize=24)
            body_lines = [
                "This is ordinary body text that continues for a while.",
                "It spans several lines so the small size clearly dominates.",
                "The heading above is rendered in a much larger font size.",
                "Font-size detection should therefore promote it to level one.",
            ]
            for offset, text in enumerate(body_lines):
                page.insert_text((72, 110 + offset * 16), text, fontsize=11)
            # Deliberately no set_toc(): exercise the font heuristic path.
            document.save(str(source))
            document.close()

            blocks = parse_document(source)

        headings = [
            (block.level, block.text) for block in blocks if block.kind == "heading"
        ]
        # The text heuristic alone would emit this at level 2; the font signal
        # upgrades it to level 1.
        self.assertIn((1, "Introduction"), headings)

    def test_pdf_with_uniform_font_falls_back_to_text_heuristic(self) -> None:
        fitz = __import__("fitz")

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "flat.pdf"
            document = fitz.open()
            page = document.new_page()
            lines = [
                "Introduction",
                "This is ordinary body text that continues for a while here.",
                "Everything on this page is rendered at exactly one font size.",
            ]
            for offset, text in enumerate(lines):
                page.insert_text((72, 90 + offset * 16), text, fontsize=12)
            document.save(str(source))
            document.close()

            blocks = parse_document(source)

        headings = [block for block in blocks if block.kind == "heading"]
        # With a single font size the font path yields nothing, so detection
        # comes purely from the text heuristic (level 2), not everything flagged.
        self.assertTrue(all(block.level == 2 for block in headings))
        self.assertLessEqual(len(headings), 1)

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
