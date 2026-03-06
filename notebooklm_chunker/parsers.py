from __future__ import annotations

import re
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from xml.etree import ElementTree

from notebooklm_chunker.models import Block


class ChunkerError(RuntimeError):
    """Base application error."""


class UnsupportedDocumentError(ChunkerError):
    """Raised when an input format cannot be parsed."""


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
        "PDF parsing requires PyMuPDF (`fitz`) or `pypdf`. Install `notebooklm-chunker[pdf]` for the easy path."
    )


def _parse_pdf_with_fitz(
    path: Path,
    *,
    skip_ranges: tuple[str, ...],
) -> list[Block] | None:
    try:
        import fitz  # type: ignore
    except ImportError:
        return None

    blocks: list[Block] = []
    document = fitz.open(path)
    try:
        page_numbers = _pdf_page_numbers(
            len(document),
            skip_ranges=skip_ranges,
        )
        for page_number in page_numbers:
            page = document.load_page(page_number - 1)
            blocks.extend(_blocks_from_text(page.get_text("text").splitlines(), page=page_number))
    finally:
        document.close()
    return blocks


def _parse_pdf_with_pypdf(
    path: Path,
    *,
    skip_ranges: tuple[str, ...],
) -> list[Block] | None:
    try:
        from pypdf import PdfReader  # type: ignore
    except ImportError:
        return None

    reader = PdfReader(str(path))
    blocks: list[Block] = []
    for page_number in _pdf_page_numbers(
        len(reader.pages),
        skip_ranges=skip_ranges,
    ):
        page = reader.pages[page_number - 1]
        blocks.extend(
            _blocks_from_text((page.extract_text() or "").splitlines(), page=page_number)
        )
    return blocks


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
                Block(kind="heading", text=_normalize_space(match.group(2)), level=len(match.group(1)))
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

        if _looks_like_heading(current, next_line):
            flush_paragraph()
            normalized = current.title() if current.isupper() else current
            blocks.append(Block(kind="heading", text=_normalize_space(normalized), level=2, page=page))
            index += 1
            continue

        paragraph.append(current)
        index += 1

    flush_paragraph()
    return blocks


def _looks_like_heading(line: str, next_line: str) -> bool:
    if len(line) > 90 or len(line.split()) > 10:
        return False
    if line.endswith((".", "!", "?", ";", ",")):
        return False
    letters = [char for char in line if char.isalpha()]
    if len(letters) < 3:
        return False

    words = line.split()
    title_like = sum(word[:1].isupper() for word in words) >= max(1, len(words) - 1)
    return (line.isupper() or title_like) and (not next_line or len(next_line.split()) > 8)


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
        if name.lower().endswith((".xhtml", ".html", ".htm"))
        and not name.startswith("__MACOSX/")
    )
