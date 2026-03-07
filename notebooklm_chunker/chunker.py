from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Callable

from notebooklm_chunker.models import Block, Chunk, ChunkingSettings, Section
from notebooklm_chunker.parsers import ChunkerError


def build_sections(blocks: list[Block], source_name: str) -> list[Section]:
    sections: list[Section] = []
    current_heading_path: tuple[str, ...] = (source_name,)
    current_body: list[str] = []
    current_start_page: int | None = None
    current_end_page: int | None = None

    def flush_section() -> None:
        nonlocal current_body, current_start_page, current_end_page
        body = "\n\n".join(part.strip() for part in current_body if part.strip()).strip()
        if body:
            sections.append(
                Section(
                    heading_path=current_heading_path,
                    body=body,
                    start_page=current_start_page,
                    end_page=current_end_page,
                )
            )
        current_body = []
        current_start_page = None
        current_end_page = None

    for block in blocks:
        if block.kind == "heading":
            flush_section()
            level = max(1, block.level or 1)
            if level == 1:
                current_heading_path = (block.text,)
            else:
                prefix = current_heading_path[: level - 1]
                if not prefix:
                    prefix = (source_name,)
                current_heading_path = prefix + (block.text,)
            current_start_page = block.page
            current_end_page = block.page
            continue

        if current_start_page is None:
            current_start_page = block.page
        if block.page is not None:
            current_end_page = block.page
        current_body.append(block.text)

    flush_section()
    return sections


def chunk_document(
    blocks: list[Block],
    source_path: Path,
    settings: ChunkingSettings | None = None,
) -> list[Chunk]:
    resolved_settings = settings or ChunkingSettings()
    _validate_settings(resolved_settings)

    sections = build_sections(blocks, source_path.stem.replace("_", " ").strip() or source_path.stem)
    if not sections:
        return []

    normalized_sections = _split_oversized_sections(sections, resolved_settings)
    grouped_sections = _group_sections(normalized_sections, resolved_settings)

    chunks: list[Chunk] = []
    for chunk_id, chunk_sections in enumerate(grouped_sections, start=1):
        chunks.append(
            _finalize_chunk(
                chunk_id=chunk_id,
                source_path=source_path,
                sections=chunk_sections,
                settings=resolved_settings,
            )
        )
    return chunks


def _validate_settings(settings: ChunkingSettings) -> None:
    if settings.words_per_page <= 0:
        raise ChunkerError("`words_per_page` must be greater than 0.")
    if settings.min_pages <= 0 or settings.max_pages <= 0 or settings.target_pages <= 0:
        raise ChunkerError("`target_pages`, `min_pages`, and `max_pages` must be greater than 0.")
    if settings.min_pages > settings.max_pages:
        raise ChunkerError("`min_pages` cannot be greater than `max_pages`.")
    if not (settings.min_pages <= settings.target_pages <= settings.max_pages):
        raise ChunkerError("`target_pages` must be between `min_pages` and `max_pages`.")


def _split_oversized_sections(
    sections: list[Section],
    settings: ChunkingSettings,
) -> list[Section]:
    normalized: list[Section] = []
    for section in sections:
        if _section_pages(section, settings) <= settings.max_pages and section.word_count <= settings.max_words:
            normalized.append(section)
            continue

        parts = _split_body(section.body, settings)
        if len(parts) == 1:
            normalized.append(section)
            continue

        for index, part in enumerate(parts, start=1):
            heading_path = list(section.heading_path)
            heading_path[-1] = f"{heading_path[-1]} (Part {index})"
            normalized.append(
                Section(
                    heading_path=tuple(heading_path),
                    body=part,
                    estimated_pages=round(len(part.split()) / max(1, settings.words_per_page), 2),
                )
            )
    return normalized


def _split_body(body: str, settings: ChunkingSettings) -> list[str]:
    paragraphs = [paragraph.strip() for paragraph in body.split("\n\n") if paragraph.strip()]
    fragments: list[str] = []
    for paragraph in paragraphs:
        fragments.extend(_split_paragraph(paragraph, settings.max_words))

    if not fragments:
        return []

    prefix_words = [0]
    for fragment in fragments:
        prefix_words.append(prefix_words[-1] + len(fragment.split()))

    ranges = _choose_ranges(
        len(fragments),
        settings,
        range_pages_fn=lambda start, end: (prefix_words[end] - prefix_words[start]) / settings.words_per_page,
    )
    return ["\n\n".join(fragments[start:end]) for start, end in ranges]


def _split_paragraph(paragraph: str, max_words: int) -> list[str]:
    if len(paragraph.split()) <= max_words:
        return [paragraph]

    sentences = [
        sentence.strip()
        for sentence in re.split(r"(?<=[.!?])\s+", paragraph)
        if sentence.strip()
    ]
    if len(sentences) == 1:
        words = paragraph.split()
        return [
            " ".join(words[index : index + max_words])
            for index in range(0, len(words), max_words)
        ]

    parts: list[str] = []
    current: list[str] = []
    current_words = 0
    for sentence in sentences:
        sentence_words = len(sentence.split())
        if current and current_words + sentence_words > max_words:
            parts.append(" ".join(current))
            current = []
            current_words = 0
        current.append(sentence)
        current_words += sentence_words

    if current:
        parts.append(" ".join(current))
    return parts


def _group_sections(
    sections: list[Section],
    settings: ChunkingSettings,
) -> list[list[Section]]:
    if not sections:
        return []

    ranges = _choose_ranges(
        len(sections),
        settings,
        range_pages_fn=lambda start, end: _chunk_pages(sections[start:end], settings),
    )
    return [sections[start:end] for start, end in ranges]


def _choose_ranges(
    count: int,
    settings: ChunkingSettings,
    *,
    range_pages_fn: Callable[[int, int], float],
) -> list[tuple[int, int]]:
    if count == 0:
        return []

    best_costs = [math.inf] * (count + 1)
    next_breaks = [-1] * (count + 1)
    best_costs[count] = 0.0

    for start in range(count - 1, -1, -1):
        for end in range(start + 1, count + 1):
            pages = range_pages_fn(start, end)
            if pages > settings.max_pages and end > start + 1:
                break

            local_cost = _range_cost(
                pages,
                settings,
                is_last=(end == count),
                is_singleton=(end == start + 1),
            )
            total_cost = local_cost + best_costs[end]
            if total_cost < best_costs[start]:
                best_costs[start] = total_cost
                next_breaks[start] = end

    if next_breaks[0] == -1:
        raise ChunkerError("Unable to split the document into chunks with the current chunking settings.")

    ranges: list[tuple[int, int]] = []
    cursor = 0
    while cursor < count:
        end = next_breaks[cursor]
        if end == -1 or end <= cursor:
            raise ChunkerError("Chunk planning failed due to an invalid chunk boundary.")
        ranges.append((cursor, end))
        cursor = end
    return ranges


def _range_cost(
    pages: float,
    settings: ChunkingSettings,
    *,
    is_last: bool,
    is_singleton: bool,
) -> float:
    if pages > settings.max_pages:
        if is_singleton:
            return 500.0 + ((pages - settings.max_pages) * 100.0)
        return math.inf

    penalty = abs(pages - settings.target_pages)
    if pages < settings.min_pages:
        shortage = settings.min_pages - pages
        penalty += shortage * (6.0 if not is_last else 2.0)
    if pages > settings.target_pages:
        penalty += (pages - settings.target_pages) * 0.5
    return penalty


def _section_pages(section: Section, settings: ChunkingSettings) -> float:
    if section.estimated_pages is not None:
        return section.estimated_pages
    if section.start_page is not None and section.end_page is not None:
        return float(max(1, section.end_page - section.start_page + 1))
    return round(section.word_count / max(1, settings.words_per_page), 2)


def _chunk_pages(sections: list[Section], settings: ChunkingSettings) -> float:
    if all(
        section.estimated_pages is None
        and section.start_page is not None
        and section.end_page is not None
        for section in sections
    ):
        start_page = sections[0].start_page
        end_page = sections[-1].end_page
        if start_page is not None and end_page is not None:
            return float(max(1, end_page - start_page + 1))

    return round(sum(_section_pages(section, settings) for section in sections), 2)


def _finalize_chunk(
    chunk_id: int,
    source_path: Path,
    sections: list[Section],
    settings: ChunkingSettings,
) -> Chunk:
    markdown = "\n\n".join(section.to_markdown().strip() for section in sections).strip() + "\n"
    word_count = len(markdown.split())
    start_page = next((section.start_page for section in sections if section.start_page is not None), None)
    end_page = next((section.end_page for section in reversed(sections) if section.end_page is not None), None)
    return Chunk(
        chunk_id=chunk_id,
        source_file=source_path.name,
        heading_path=sections[0].heading_path,
        primary_heading=_chunk_primary_heading(sections, source_path),
        markdown=markdown,
        word_count=word_count,
        estimated_pages=round(_chunk_pages(sections, settings), 2),
        start_page=start_page,
        end_page=end_page,
    )


def chunk_filename(chunk: Chunk) -> str:
    slug_source = chunk.primary_heading or (chunk.heading_path[-1] if chunk.heading_path else Path(chunk.source_file).stem)
    slug = re.sub(r"[^a-z0-9]+", "-", slug_source.lower()).strip("-") or "chunk"
    return f"{chunk.chunk_id:03d}-{slug}.md"


def _chunk_primary_heading(sections: list[Section], source_path: Path) -> str:
    for section in sections:
        if section.heading_path:
            heading = section.heading_path[-1].strip()
            if heading:
                return heading
    return source_path.stem.replace("_", " ").strip() or source_path.stem
