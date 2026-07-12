from __future__ import annotations

import re
import zipfile
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from xml.etree import ElementTree

from notebooklm_chunker.models import Block


class ChunkerError(RuntimeError):
    """Base application error."""


class UnsupportedDocumentError(ChunkerError):
    """Raised when an input format cannot be parsed."""


@dataclass(frozen=True, slots=True)
class PdfPageSelection:
    total_pages: int
    included_pages: tuple[int, ...]
    skipped_pages: tuple[int, ...]


def parse_document(
    path: Path,
    *,
    pdf_skip_ranges: tuple[str, ...] = (),
) -> list[Block]:
    suffix = path.suffix.lower()
    if suffix in {".md", ".markdown"}:
        return parse_markdown(path)
    if suffix in {".html", ".htm"}:
        return parse_html(path)
    if suffix == ".txt":
        return parse_text(path)
    if suffix == ".epub":
        return parse_epub(path)
    if suffix == ".pdf":
        return parse_pdf(
            path,
            skip_ranges=pdf_skip_ranges,
        )
    raise UnsupportedDocumentError(f"Unsupported input type: {path.suffix or '<none>'}")


def parse_markdown(path: Path) -> list[Block]:
    return _blocks_from_markdown_lines(path.read_text(encoding="utf-8").splitlines())


def parse_html(path: Path) -> list[Block]:
    parser = _StructuredHTMLParser()
    parser.feed(path.read_text(encoding="utf-8"))
    return parser.blocks


def parse_text(path: Path) -> list[Block]:
    return _blocks_from_text(path.read_text(encoding="utf-8").splitlines())


def parse_epub(path: Path) -> list[Block]:
    with zipfile.ZipFile(path) as archive:
        html_entries = _ordered_epub_documents(archive)
        if not html_entries:
            raise UnsupportedDocumentError(f"EPUB has no readable HTML documents: {path}")

        blocks: list[Block] = []
        for entry in html_entries:
            parser = _StructuredHTMLParser()
            parser.feed(archive.read(entry).decode("utf-8", errors="ignore"))
            blocks.extend(parser.blocks)
        return blocks


def parse_pdf(
    path: Path,
    *,
    skip_ranges: tuple[str, ...] = (),
) -> list[Block]:
    fitz_blocks = _parse_pdf_with_fitz(
        path,
        skip_ranges=skip_ranges,
    )
    if fitz_blocks is not None:
        return fitz_blocks

    pypdf_blocks = _parse_pdf_with_pypdf(
        path,
        skip_ranges=skip_ranges,
    )
    if pypdf_blocks is not None:
        return pypdf_blocks

    raise UnsupportedDocumentError(
        "PDF parsing requires PyMuPDF (`fitz`) or `pypdf`. Install `notebooklm-chunker` or add `pymupdf`."
    )


def inspect_pdf_page_selection(
    path: Path,
    *,
    skip_ranges: tuple[str, ...] = (),
) -> PdfPageSelection:
    total_pages = _pdf_total_pages(path)
    skipped_pages = tuple(sorted(_expanded_skip_pages(total_pages, skip_ranges)))
    included_pages = tuple(_pdf_page_numbers(total_pages, skip_ranges=skip_ranges))
    return PdfPageSelection(
        total_pages=total_pages,
        included_pages=included_pages,
        skipped_pages=skipped_pages,
    )


def _parse_pdf_with_fitz(
    path: Path,
    *,
    skip_ranges: tuple[str, ...],
) -> list[Block] | None:
    try:
        import fitz
    except ImportError:
        return None

    document = fitz.open(path)
    try:
        toc_entries = _usable_pdf_toc(document)
        page_entries: list[tuple[int, list[str]]] = []
        for page_number in _pdf_page_numbers(len(document), skip_ranges=skip_ranges):
            page = document.load_page(page_number - 1)
            page_entries.append((page_number, page.get_text("text").splitlines()))
    finally:
        document.close()
    if toc_entries:
        return _blocks_from_pdf_pages_with_toc(page_entries, toc_entries)
    return _blocks_from_pdf_pages(page_entries)


def _parse_pdf_with_pypdf(
    path: Path,
    *,
    skip_ranges: tuple[str, ...],
) -> list[Block] | None:
    try:
        from pypdf import PdfReader
    except ImportError:
        return None

    reader = PdfReader(str(path))
    page_entries: list[tuple[int, list[str]]] = []
    for page_number in _pdf_page_numbers(len(reader.pages), skip_ranges=skip_ranges):
        page = reader.pages[page_number - 1]
        page_entries.append((page_number, (page.extract_text() or "").splitlines()))
    return _blocks_from_pdf_pages(page_entries)


def _pdf_total_pages(path: Path) -> int:
    fitz_total_pages = _pdf_total_pages_with_fitz(path)
    if fitz_total_pages is not None:
        return fitz_total_pages

    pypdf_total_pages = _pdf_total_pages_with_pypdf(path)
    if pypdf_total_pages is not None:
        return pypdf_total_pages

    raise UnsupportedDocumentError(
        "PDF parsing requires PyMuPDF (`fitz`) or `pypdf`. Install `notebooklm-chunker` or add `pymupdf`."
    )


def _pdf_total_pages_with_fitz(path: Path) -> int | None:
    try:
        import fitz
    except ImportError:
        return None

    document = fitz.open(path)
    try:
        return len(document)
    finally:
        document.close()


def _pdf_total_pages_with_pypdf(path: Path) -> int | None:
    try:
        from pypdf import PdfReader
    except ImportError:
        return None

    return len(PdfReader(str(path)).pages)


def _pdf_page_numbers(
    total_pages: int,
    *,
    skip_ranges: tuple[str, ...] = (),
) -> list[int]:
    skipped_pages = _expanded_skip_pages(total_pages, skip_ranges)
    page_numbers = [page for page in range(1, total_pages + 1) if page not in skipped_pages]
    if not page_numbers:
        raise UnsupportedDocumentError(
            "PDF page skips exclude the entire document. Reduce `skip_ranges`."
        )
    return page_numbers


def _expanded_skip_pages(total_pages: int, skip_ranges: tuple[str, ...]) -> set[int]:
    skipped_pages: set[int] = set()
    for raw_range in skip_ranges:
        start_page, end_page = _parse_page_range(raw_range)
        bounded_start = max(1, start_page)
        bounded_end = min(total_pages, end_page)
        if bounded_start > total_pages or bounded_start > bounded_end:
            continue
        skipped_pages.update(range(bounded_start, bounded_end + 1))
    return skipped_pages


def _parse_page_range(raw_range: str) -> tuple[int, int]:
    match = re.fullmatch(r"\s*(\d+)\s*(?:-\s*(\d+)\s*)?", raw_range)
    if match is None:
        raise UnsupportedDocumentError(
            f"Invalid PDF skip range: {raw_range!r}. Use `N` or `N-M`, for example `12` or `399-420`."
        )

    start_page = int(match.group(1))
    end_page = int(match.group(2) or start_page)
    if start_page < 1 or end_page < 1:
        raise UnsupportedDocumentError(
            f"Invalid PDF skip range: {raw_range!r}. Page numbers must start at 1."
        )
    if start_page > end_page:
        raise UnsupportedDocumentError(
            f"Invalid PDF skip range: {raw_range!r}. Range start must be <= range end."
        )
    return start_page, end_page


def _blocks_from_pdf_pages(page_entries: list[tuple[int, list[str]]]) -> list[Block]:
    blocks: list[Block] = []
    for page_number, lines in _clean_pdf_page_entries(page_entries):
        blocks.extend(_blocks_from_text(lines, page=page_number))
    return blocks


_MIN_USABLE_TOC_ENTRIES = 3


def _usable_pdf_toc(document: object) -> list[tuple[int, str, int]]:
    """Read the PDF's embedded outline (bookmarks) if it is rich enough to trust.

    A publisher-authored table of contents is authoritative for both heading
    text and hierarchy level, so when present it replaces the text heuristics.
    """
    get_toc = getattr(document, "get_toc", None)
    if get_toc is None:
        return []
    try:
        raw_toc = get_toc(simple=True)
    except Exception:
        return []

    entries: list[tuple[int, str, int]] = []
    for item in raw_toc or []:
        if not isinstance(item, (list, tuple)) or len(item) < 3:
            continue
        level, title, page = item[0], item[1], item[2]
        if not isinstance(level, int) or level < 1:
            continue
        if not isinstance(page, int) or page < 1:
            continue
        normalized_title = _normalize_space(str(title or ""))
        if not normalized_title:
            continue
        entries.append((level, normalized_title, page))

    if len(entries) < _MIN_USABLE_TOC_ENTRIES:
        return []
    return entries


def _blocks_from_pdf_pages_with_toc(
    page_entries: list[tuple[int, list[str]]],
    toc_entries: list[tuple[int, str, int]],
) -> list[Block]:
    included_pages = {page_number for page_number, _ in page_entries}
    headings_by_page: dict[int, list[tuple[int, str]]] = {}
    for level, title, page in toc_entries:
        if page in included_pages:
            headings_by_page.setdefault(page, []).append((level, title))

    blocks: list[Block] = []
    for page_number, lines in _clean_pdf_page_entries(page_entries):
        page_headings = headings_by_page.get(page_number, [])
        blocks.extend(_page_blocks_with_toc_headings(lines, page_headings, page=page_number))
    return blocks


def _page_blocks_with_toc_headings(
    lines: list[str],
    page_headings: list[tuple[int, str]],
    *,
    page: int,
) -> list[Block]:
    blocks: list[Block] = []
    paragraph: list[str] = []

    def flush_paragraph() -> None:
        if paragraph:
            text = "\n".join(paragraph).strip()
            if text:
                blocks.append(Block(kind="paragraph", text=text, page=page))
            paragraph.clear()

    # Headings whose text cannot be located on the page still belong to it;
    # emit them at the top so the following body lands under them.
    pending = list(page_headings)
    unmatched = [
        heading for heading in pending if not _find_toc_heading_line(lines, heading[1])
    ]
    for level, title in unmatched:
        blocks.append(Block(kind="heading", text=title, level=level, page=page))
    matched = [heading for heading in pending if heading not in unmatched]

    for line in lines:
        stripped = line.strip()
        if not stripped:
            flush_paragraph()
            continue
        matched_heading = None
        for heading in matched:
            if _line_matches_toc_title(stripped, heading[1]):
                matched_heading = heading
                break
        if matched_heading is not None:
            matched.remove(matched_heading)
            flush_paragraph()
            blocks.append(
                Block(
                    kind="heading",
                    text=matched_heading[1],
                    level=matched_heading[0],
                    page=page,
                )
            )
            continue
        paragraph.append(stripped)

    flush_paragraph()
    return blocks


def _find_toc_heading_line(lines: list[str], title: str) -> bool:
    return any(_line_matches_toc_title(line.strip(), title) for line in lines if line.strip())


_TOC_NUMBERING_PREFIX = re.compile(r"^\d+(?:\.\d+)*\.?\s+")


def _line_matches_toc_title(line: str, title: str) -> bool:
    normalized_line = _normalize_space(line).casefold()
    normalized_title = title.casefold()
    if normalized_line == normalized_title:
        return True
    stripped_line = _TOC_NUMBERING_PREFIX.sub("", normalized_line)
    stripped_title = _TOC_NUMBERING_PREFIX.sub("", normalized_title)
    return bool(stripped_title) and stripped_line == stripped_title


def _clean_pdf_page_entries(
    page_entries: list[tuple[int, list[str]]],
) -> list[tuple[int, list[str]]]:
    if not page_entries:
        return []

    normalized_entries = [
        (page_number, [line.strip() for line in lines if line.strip()])
        for page_number, lines in page_entries
    ]
    repeated_titles = _repeated_edge_titles(normalized_entries)
    return [
        (page_number, _trim_pdf_edge_noise(lines, repeated_titles))
        for page_number, lines in normalized_entries
    ]


def _repeated_edge_titles(page_entries: list[tuple[int, list[str]]]) -> set[str]:
    counts: dict[str, int] = {}
    for _, lines in page_entries:
        for line in _edge_candidates(lines):
            if _looks_like_running_title(line):
                key = _running_title_key(line)
                counts[key] = counts.get(key, 0) + 1
    return {key for key, count in counts.items() if count >= 3}


def _running_title_key(line: str) -> str:
    # Running headers often embed the page number ("16|Book Title"), so the
    # raw lines never repeat exactly; compare with digits collapsed instead.
    return re.sub(r"\d+", "#", line)


def _edge_candidates(lines: list[str]) -> set[str]:
    candidates: set[str] = set()
    candidates.update(lines[:2])
    if len(lines) > 2:
        candidates.update(lines[-2:])
    return {line for line in candidates if line}


def _trim_pdf_edge_noise(lines: list[str], repeated_titles: set[str]) -> list[str]:
    start = 0
    end = len(lines)

    while start < end and _is_pdf_edge_noise(lines[start], repeated_titles):
        start += 1
    while end > start and _is_pdf_edge_noise(lines[end - 1], repeated_titles):
        end -= 1

    return lines[start:end]


def _is_pdf_edge_noise(line: str, repeated_titles: set[str]) -> bool:
    if not line:
        return True
    if re.fullmatch(r"\d+", line):
        return True
    if _running_title_key(line) in repeated_titles:
        return True
    return False


def _looks_like_running_title(line: str) -> bool:
    if len(line) > 60:
        return False
    if len(line.split()) > 8:
        return False
    if re.fullmatch(r"\d+(?:\.\d+)*", line):
        return False
    return _looks_like_heading(line, "")


def _blocks_from_markdown_lines(lines: list[str]) -> list[Block]:
    blocks: list[Block] = []
    paragraph: list[str] = []

    def flush_paragraph() -> None:
        if paragraph:
            text = "\n".join(paragraph).strip()
            if text:
                blocks.append(Block(kind="paragraph", text=text))
            paragraph.clear()

    index = 0
    while index < len(lines):
        stripped = lines[index].strip()
        next_line = lines[index + 1].strip() if index + 1 < len(lines) else ""

        if not stripped:
            flush_paragraph()
            index += 1
            continue

        match = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if match:
            flush_paragraph()
            blocks.append(
                Block(
                    kind="heading", text=_normalize_space(match.group(2)), level=len(match.group(1))
                )
            )
            index += 1
            continue

        if next_line and set(next_line) <= {"="} and len(next_line) >= 3:
            flush_paragraph()
            blocks.append(Block(kind="heading", text=_normalize_space(stripped), level=1))
            index += 2
            continue

        if next_line and set(next_line) <= {"-"} and len(next_line) >= 3:
            flush_paragraph()
            blocks.append(Block(kind="heading", text=_normalize_space(stripped), level=2))
            index += 2
            continue

        if stripped.startswith(("- ", "* ")) or re.match(r"^\d+\.\s+", stripped):
            flush_paragraph()
            blocks.append(Block(kind="paragraph", text=stripped))
            index += 1
            continue

        paragraph.append(stripped)
        index += 1

    flush_paragraph()
    return blocks


def _blocks_from_text(lines: list[str], page: int | None = None) -> list[Block]:
    blocks: list[Block] = []
    paragraph: list[str] = []
    index = 0

    def flush_paragraph() -> None:
        if paragraph:
            text = "\n".join(paragraph).strip()
            if text:
                blocks.append(Block(kind="paragraph", text=text, page=page))
            paragraph.clear()

    while index < len(lines):
        current = lines[index].strip()
        next_line = lines[index + 1].strip() if index + 1 < len(lines) else ""

        if not current:
            flush_paragraph()
            index += 1
            continue

        if next_line and set(next_line) <= {"="} and len(next_line) >= 3:
            flush_paragraph()
            blocks.append(Block(kind="heading", text=_normalize_space(current), level=1, page=page))
            index += 2
            continue

        if next_line and set(next_line) <= {"-"} and len(next_line) >= 3:
            flush_paragraph()
            blocks.append(Block(kind="heading", text=_normalize_space(current), level=2, page=page))
            index += 2
            continue

        if _looks_like_numbered_heading_prefix(current) and _looks_like_heading_title(next_line):
            flush_paragraph()
            blocks.append(
                Block(
                    kind="heading",
                    text=_normalize_space(f"{current} {next_line}"),
                    level=2,
                    page=page,
                )
            )
            index += 2
            continue

        if _looks_like_heading(current, next_line):
            flush_paragraph()
            normalized = current.title() if current.isupper() else current
            blocks.append(
                Block(kind="heading", text=_normalize_space(normalized), level=2, page=page)
            )
            index += 1
            continue

        paragraph.append(current)
        index += 1

    flush_paragraph()
    return blocks


def _looks_like_heading(line: str, next_line: str) -> bool:
    if next_line and len(next_line.split()) <= 8:
        return False
    if not _passes_heading_gates(line):
        return False
    return line.isupper() or _title_case_like(line)


def _looks_like_numbered_heading_prefix(line: str) -> bool:
    return re.fullmatch(r"\d+(?:\.\d+)+", line) is not None


def _looks_like_heading_title(line: str) -> bool:
    return _passes_heading_gates(line) and _title_case_like(line)


def _passes_heading_gates(line: str) -> bool:
    if not line or len(line) > 90 or len(line.split()) > 10:
        return False
    if line.endswith((".", "!", "?", ";", ",")):
        return False
    letters = [char for char in line if char.isalpha()]
    return len(letters) >= 3


def _title_case_like(line: str) -> bool:
    words = line.split()
    return sum(word[:1].isupper() for word in words) >= max(1, len(words) - 1)


def _normalize_space(text: str) -> str:
    return " ".join(text.split())


class _StructuredHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[Block] = []
        self._capture_tag: str | None = None
        self._capture_depth = 0
        self._buffer: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self._capture_tag is None and tag in _INTERESTING_TAGS:
            self._capture_tag = tag
            self._capture_depth = 1
            self._buffer = []
            return

        if self._capture_tag is not None:
            self._capture_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if self._capture_tag is None:
            return

        self._capture_depth -= 1
        if self._capture_depth > 0:
            return

        text = _normalize_space("".join(self._buffer))
        if text:
            kind, level = _INTERESTING_TAGS[self._capture_tag]
            self.blocks.append(Block(kind=kind, text=text, level=level))

        self._capture_tag = None
        self._buffer = []

    def handle_data(self, data: str) -> None:
        if self._capture_tag is not None:
            self._buffer.append(data)


_INTERESTING_TAGS: dict[str, tuple[str, int]] = {
    "h1": ("heading", 1),
    "h2": ("heading", 2),
    "h3": ("heading", 3),
    "h4": ("heading", 4),
    "h5": ("heading", 5),
    "h6": ("heading", 6),
    "p": ("paragraph", 0),
    "li": ("paragraph", 0),
    "pre": ("paragraph", 0),
}


def _ordered_epub_documents(archive: zipfile.ZipFile) -> list[str]:
    try:
        container = ElementTree.fromstring(archive.read("META-INF/container.xml"))
        rootfile = container.find(".//{*}rootfile")
        if rootfile is None:
            raise KeyError("rootfile")

        opf_path = rootfile.attrib["full-path"]
        opf_directory = Path(opf_path).parent
        package = ElementTree.fromstring(archive.read(opf_path))
        manifest = {
            item.attrib["id"]: item.attrib["href"]
            for item in package.findall(".//{*}manifest/{*}item")
            if "id" in item.attrib and "href" in item.attrib
        }
        ordered: list[str] = []
        for itemref in package.findall(".//{*}spine/{*}itemref"):
            item_id = itemref.attrib.get("idref")
            if item_id is None or item_id not in manifest:
                continue
            resolved = (opf_directory / manifest[item_id]).as_posix()
            if resolved.lower().endswith((".xhtml", ".html", ".htm")):
                ordered.append(resolved)
        if ordered:
            return ordered
    except KeyError:
        pass
    except ElementTree.ParseError:
        pass

    return sorted(
        name
        for name in archive.namelist()
        if name.lower().endswith((".xhtml", ".html", ".htm")) and not name.startswith("__MACOSX/")
    )
