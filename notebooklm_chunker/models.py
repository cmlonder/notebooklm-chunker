from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class Block:
    kind: str
    text: str
    level: int = 0
    page: int | None = None


@dataclass(frozen=True, slots=True)
class Section:
    heading_path: tuple[str, ...]
    body: str
    start_page: int | None = None
    end_page: int | None = None
    estimated_pages: float | None = None

    @property
    def word_count(self) -> int:
        return len(self.body.split())

    def to_markdown(self) -> str:
        heading_lines: list[str] = []
        for index, heading in enumerate(self.heading_path, start=1):
            heading_lines.append(f'{"#" * min(index, 6)} {heading}')
            heading_lines.append("")
        heading_lines.append(self.body.strip())
        return "\n".join(line for line in heading_lines if line is not None).strip() + "\n"


@dataclass(frozen=True, slots=True)
class Chunk:
    chunk_id: int
    source_file: str
    heading_path: tuple[str, ...]
    markdown: str
    word_count: int
    estimated_pages: float
    start_page: int | None = None
    end_page: int | None = None


@dataclass(frozen=True, slots=True)
class ChunkingSettings:
    target_pages: float = 3.0
    min_pages: float = 2.5
    max_pages: float = 4.0
    words_per_page: int = 500

    @property
    def target_words(self) -> int:
        return max(1, int(self.target_pages * self.words_per_page))

    @property
    def min_words(self) -> int:
        return max(1, int(self.min_pages * self.words_per_page))

    @property
    def max_words(self) -> int:
        return max(self.min_words, int(self.max_pages * self.words_per_page))


@dataclass(frozen=True, slots=True)
class ExportResult:
    output_dir: str
    manifest_path: str
    files: tuple[str, ...] = field(default_factory=tuple)
