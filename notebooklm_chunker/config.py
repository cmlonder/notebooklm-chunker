from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from notebooklm_chunker.parsers import ChunkerError

DEFAULT_CONFIG_BASENAMES = ("nblm.toml", ".nblm.toml", "pyproject.toml")

_AUDIO_FORMATS = ("deep-dive", "brief", "critique", "debate")
_AUDIO_LENGTHS = ("short", "default", "long")
_VIDEO_FORMATS = ("explainer", "brief")
_VIDEO_STYLES = (
    "auto",
    "classic",
    "whiteboard",
    "kawaii",
    "anime",
    "watercolor",
    "retro-print",
    "heritage",
    "paper-craft",
)
_REPORT_FORMATS = ("briefing-doc", "study-guide", "blog-post", "custom")
_SLIDE_FORMATS = ("detailed", "presenter")
_SLIDE_LENGTHS = ("default", "short")
_SLIDE_DOWNLOAD_FORMATS = ("pdf", "pptx")
_QUIZ_QUANTITIES = ("fewer", "standard", "more")
_QUIZ_DIFFICULTIES = ("easy", "medium", "hard")
_INTERACTIVE_OUTPUT_FORMATS = ("json", "markdown", "html")
_INFOGRAPHIC_ORIENTATIONS = ("landscape", "portrait", "square")
_INFOGRAPHIC_DETAILS = ("concise", "standard", "detailed")


class ConfigError(ChunkerError):
    """Raised when configuration cannot be read or written."""


@dataclass(frozen=True, slots=True)
class SourceConfig:
    path: str | None = None
    skip_ranges: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class NotebookConfig:
    id: str | None = None
    title: str | None = None


@dataclass(frozen=True, slots=True)
class ChunkingConfig:
    target_pages: float | None = None
    min_pages: float | None = None
    max_pages: float | None = None
    words_per_page: int | None = None
    output_dir: str | None = None


@dataclass(frozen=True, slots=True)
class RuntimeConfig:
    max_parallel_chunks: int | None = None
    max_parallel_heavy_studios: int | None = None
    studio_wait_timeout_seconds: float | None = None
    rename_remote_titles: bool = False
    download_outputs: bool = True
    studio_create_retries: int | None = None
    studio_create_backoff_seconds: float | None = None
    studio_rate_limit_cooldown_seconds: float | None = None


@dataclass(frozen=True, slots=True)
class StudioConfig:
    enabled: bool = False
    per_chunk: bool = False
    max_parallel: int | None = None
    prompt: str | None = None
    output_path: str | None = None
    output_dir: str | None = None
    language: str | None = None
    format: str | None = None
    length: str | None = None
    style: str | None = None
    quantity: str | None = None
    difficulty: str | None = None
    orientation: str | None = None
    detail: str | None = None
    download_format: str | None = None


@dataclass(frozen=True, slots=True)
class StudiosConfig:
    audio: StudioConfig = StudioConfig()
    video: StudioConfig = StudioConfig()
    report: StudioConfig = StudioConfig()
    slide_deck: StudioConfig = StudioConfig()
    quiz: StudioConfig = StudioConfig()
    flashcards: StudioConfig = StudioConfig()
    infographic: StudioConfig = StudioConfig()
    data_table: StudioConfig = StudioConfig()
    mind_map: StudioConfig = StudioConfig()

    def enabled_items(self) -> list[tuple[str, StudioConfig]]:
        return [
            (name, config)
            for name, config in (
                ("audio", self.audio),
                ("video", self.video),
                ("report", self.report),
                ("slide_deck", self.slide_deck),
                ("quiz", self.quiz),
                ("flashcards", self.flashcards),
                ("infographic", self.infographic),
                ("data_table", self.data_table),
                ("mind_map", self.mind_map),
            )
            if config.enabled
        ]


@dataclass(frozen=True, slots=True)
class AppConfig:
    source: SourceConfig = SourceConfig()
    notebook: NotebookConfig = NotebookConfig()
    chunking: ChunkingConfig = ChunkingConfig()
    runtime: RuntimeConfig = RuntimeConfig()
    studios: StudiosConfig = StudiosConfig()
    config_path: str | None = None

    @property
    def source_path(self) -> str | None:
        return self.config_path


def load_config(explicit_path: Path | None = None, *, start_dir: Path | None = None) -> AppConfig:
    config_path = resolve_config_path(explicit_path, start_dir=start_dir)
    if config_path is None:
        return AppConfig()

    try:
        with config_path.open("rb") as handle:
            raw = tomllib.load(handle)
    except FileNotFoundError as exc:
        raise ConfigError(f"Config file not found: {config_path}") from exc
    except tomllib.TOMLDecodeError as exc:
        raise ConfigError(f"Invalid TOML in config file {config_path}: {exc}") from exc

    if config_path.name == "pyproject.toml":
        raw = _as_dict(_as_dict(raw.get("tool")).get("nblm"))

    base_dir = config_path.parent
    source = _as_dict(raw.get("source"))
    notebook = _as_dict(raw.get("notebook"))
    chunking = _as_dict(raw.get("chunking"))
    runtime = _as_dict(raw.get("runtime"))
    studios = _as_dict(raw.get("studios"))
    source_path = _optional_path(source.get("path"), "source.path", base_dir)

    return AppConfig(
        source=SourceConfig(
            path=source_path,
            skip_ranges=_optional_page_ranges(
                source.get("skip_ranges"),
                "source.skip_ranges",
            ),
        ),
        notebook=NotebookConfig(
            id=_optional_str(notebook.get("id"), "notebook.id"),
            title=_optional_str(notebook.get("title"), "notebook.title"),
        ),
        chunking=ChunkingConfig(
            target_pages=_optional_float(chunking.get("target_pages"), "chunking.target_pages"),
            min_pages=_optional_float(chunking.get("min_pages"), "chunking.min_pages"),
            max_pages=_optional_float(chunking.get("max_pages"), "chunking.max_pages"),
            words_per_page=_optional_int(chunking.get("words_per_page"), "chunking.words_per_page"),
            output_dir=_optional_template_path(
                chunking.get("output_dir"),
                "chunking.output_dir",
                base_dir,
                source_path=source_path,
            ),
        ),
        runtime=RuntimeConfig(
            max_parallel_chunks=_optional_positive_int(
                runtime.get("max_parallel_chunks"),
                "runtime.max_parallel_chunks",
            ),
            max_parallel_heavy_studios=_optional_positive_int(
                runtime.get("max_parallel_heavy_studios"),
                "runtime.max_parallel_heavy_studios",
            ),
            studio_wait_timeout_seconds=_optional_positive_float(
                runtime.get("studio_wait_timeout_seconds"),
                "runtime.studio_wait_timeout_seconds",
            ),
            rename_remote_titles=_optional_bool(
                runtime.get("rename_remote_titles"),
                "runtime.rename_remote_titles",
            ),
            download_outputs=(
                True
                if runtime.get("download_outputs") is None
                else _optional_bool(
                    runtime.get("download_outputs"),
                    "runtime.download_outputs",
                )
            ),
            studio_create_retries=_optional_non_negative_int(
                runtime.get("studio_create_retries"),
                "runtime.studio_create_retries",
            ),
            studio_create_backoff_seconds=_optional_positive_float(
                runtime.get("studio_create_backoff_seconds"),
                "runtime.studio_create_backoff_seconds",
            ),
            studio_rate_limit_cooldown_seconds=_optional_positive_float(
                runtime.get("studio_rate_limit_cooldown_seconds"),
                "runtime.studio_rate_limit_cooldown_seconds",
            ),
        ),
        studios=StudiosConfig(
            audio=_load_studio_config(
                studios,
                "audio",
                base_dir=base_dir,
                source_path=source_path,
                allowed_formats=_AUDIO_FORMATS,
                allowed_lengths=_AUDIO_LENGTHS,
            ),
            video=_load_studio_config(
                studios,
                "video",
                base_dir=base_dir,
                source_path=source_path,
                allowed_formats=_VIDEO_FORMATS,
                allowed_styles=_VIDEO_STYLES,
            ),
            report=_load_studio_config(
                studios,
                "report",
                base_dir=base_dir,
                source_path=source_path,
                allowed_formats=_REPORT_FORMATS,
            ),
            slide_deck=_load_studio_config(
                studios,
                "slide_deck",
                base_dir=base_dir,
                source_path=source_path,
                allowed_formats=_SLIDE_FORMATS,
                allowed_lengths=_SLIDE_LENGTHS,
                allowed_download_formats=_SLIDE_DOWNLOAD_FORMATS,
            ),
            quiz=_load_studio_config(
                studios,
                "quiz",
                base_dir=base_dir,
                source_path=source_path,
                allowed_quantities=_QUIZ_QUANTITIES,
                allowed_difficulties=_QUIZ_DIFFICULTIES,
                allowed_download_formats=_INTERACTIVE_OUTPUT_FORMATS,
            ),
            flashcards=_load_studio_config(
                studios,
                "flashcards",
                base_dir=base_dir,
                source_path=source_path,
                allowed_quantities=_QUIZ_QUANTITIES,
                allowed_difficulties=_QUIZ_DIFFICULTIES,
                allowed_download_formats=_INTERACTIVE_OUTPUT_FORMATS,
            ),
            infographic=_load_studio_config(
                studios,
                "infographic",
                base_dir=base_dir,
                source_path=source_path,
                allowed_orientations=_INFOGRAPHIC_ORIENTATIONS,
                allowed_details=_INFOGRAPHIC_DETAILS,
            ),
            data_table=_load_studio_config(
                studios,
                "data_table",
                base_dir=base_dir,
                source_path=source_path,
            ),
            mind_map=_load_studio_config(
                studios,
                "mind_map",
                base_dir=base_dir,
                source_path=source_path,
            ),
        ),
        config_path=str(config_path),
    )


def resolve_config_path(
    explicit_path: Path | None = None, *, start_dir: Path | None = None
) -> Path | None:
    if explicit_path is not None:
        return explicit_path.expanduser().resolve()

    env_path = os.getenv("NBLM_CONFIG")
    if env_path:
        return Path(env_path).expanduser().resolve()

    current = (start_dir or Path.cwd()).resolve()
    for directory in (current, *current.parents):
        for basename in DEFAULT_CONFIG_BASENAMES:
            candidate = directory / basename
            if candidate.is_file():
                if candidate.name == "pyproject.toml" and not _pyproject_has_nblm(candidate):
                    continue
                return candidate
    return None


def write_config_template(
    destination: Path,
    *,
    target_pages: float,
    min_pages: float,
    max_pages: float,
    words_per_page: int,
    force: bool = False,
) -> Path:
    resolved = destination.expanduser().resolve()
    if resolved.exists() and not force:
        raise ConfigError(f"Config file already exists: {resolved}")

    content = "\n".join(
        [
            "# notebooklm-chunker workflow configuration",
            "# Use `nblm login` once before the first live NotebookLM run.",
            "# Start simple. Add more Studio blocks or advanced runtime options later if needed.",
            "",
            "[source]",
            "# Relative paths are resolved from this TOML file.",
            'path = "./your-document.pdf"',
            "# PDF only: skip explicit inclusive physical PDF page ranges (1-based).",
            "# These are file pages, not the page numbers printed inside the book.",
            '# Example: ["1-8", "399-420"] skips front matter and references by file page range.',
            '# skip_ranges = ["1-8", "399-420", "512"]',
            "",
            "[notebook]",
            "# Create a new notebook with this title unless `id` is set.",
            'title = "Interactive Learning Notebook"',
            '# id = "nb_..."',
            "",
            "[chunking]",
            "# Markdown chunks, manifest.json, and .nblm-run-state.json are written here.",
            "# `{source_stem}` expands from `source.path`. Example: `book.pdf` -> `book`.",
            'output_dir = "./output/{source_stem}/chunks"',
            "# Preferred chunk size in approximate pages.",
            f"target_pages = {target_pages}",
            "# Soft lower bound.",
            f"min_pages = {min_pages}",
            "# Hard upper bound.",
            f"max_pages = {max_pages}",
            "# Keep this only if you need to tune page estimates manually.",
            f"words_per_page = {words_per_page}",
            "",
            "[runtime]",
            "# How many source uploads may run at once.",
            "max_parallel_chunks = 3",
            "",
            "[studios.report]",
            "enabled = true",
            "per_chunk = true",
            'output_dir = "./output/{source_stem}/reports"',
            'prompt = """',
            "Write a study-guide style report for this chunk.",
            "Explain the main ideas, terminology, and tradeoffs.",
            '"""',
            'language = "en"',
            'format = "study-guide"',
            "",
            "[studios.slide_deck]",
            "enabled = true",
            "per_chunk = true",
            'output_dir = "./output/{source_stem}/slides"',
            'prompt = """',
            "Build a teaching deck for this chunk.",
            "Keep the section order and one clear idea per slide.",
            '"""',
            'language = "en"',
            'format = "detailed"',
            'length = "default"',
            'download_format = "pdf"',
            "",
            "[studios.quiz]",
            "enabled = false",
            "# Turn this on later if you want one quiz per chunk.",
            "# per_chunk = true",
            '# output_dir = "./output/{source_stem}/quizzes"',
            'prompt = """',
            "Ask concept-check questions that reveal whether",
            "the learner really understood the text.",
            '"""',
            'quantity = "more"',
            'difficulty = "hard"',
            'download_format = "json"',
            "",
        ]
    )
    resolved.write_text(content + "\n", encoding="utf-8")
    return resolved


def _pyproject_has_nblm(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            raw = tomllib.load(handle)
    except (FileNotFoundError, tomllib.TOMLDecodeError):
        return False
    return bool(_as_dict(_as_dict(raw.get("tool")).get("nblm")))


def _load_studio_config(
    studios: dict[str, Any],
    key: str,
    *,
    base_dir: Path,
    source_path: str | None,
    allowed_formats: tuple[str, ...] | None = None,
    allowed_lengths: tuple[str, ...] | None = None,
    allowed_styles: tuple[str, ...] | None = None,
    allowed_quantities: tuple[str, ...] | None = None,
    allowed_difficulties: tuple[str, ...] | None = None,
    allowed_orientations: tuple[str, ...] | None = None,
    allowed_details: tuple[str, ...] | None = None,
    allowed_download_formats: tuple[str, ...] | None = None,
) -> StudioConfig:
    raw = _as_dict(studios.get(key))
    if not raw and "_" in key:
        raw = _as_dict(studios.get(key.replace("_", "-")))

    label = f"studios.{key}"
    return StudioConfig(
        enabled=_optional_bool(raw.get("enabled"), f"{label}.enabled"),
        per_chunk=_optional_bool(raw.get("per_chunk"), f"{label}.per_chunk"),
        max_parallel=_optional_positive_int(raw.get("max_parallel"), f"{label}.max_parallel"),
        prompt=_optional_str(raw.get("prompt"), f"{label}.prompt"),
        output_path=_optional_template_path(
            raw.get("output_path"), f"{label}.output_path", base_dir, source_path
        ),
        output_dir=_optional_template_path(
            raw.get("output_dir"), f"{label}.output_dir", base_dir, source_path
        ),
        language=_optional_str(raw.get("language"), f"{label}.language"),
        format=_optional_choice(raw.get("format"), f"{label}.format", allowed_formats),
        length=_optional_choice(raw.get("length"), f"{label}.length", allowed_lengths),
        style=_optional_choice(raw.get("style"), f"{label}.style", allowed_styles),
        quantity=_optional_choice(raw.get("quantity"), f"{label}.quantity", allowed_quantities),
        difficulty=_optional_choice(
            raw.get("difficulty"),
            f"{label}.difficulty",
            allowed_difficulties,
        ),
        orientation=_optional_choice(
            raw.get("orientation"),
            f"{label}.orientation",
            allowed_orientations,
        ),
        detail=_optional_choice(raw.get("detail"), f"{label}.detail", allowed_details),
        download_format=_optional_choice(
            raw.get("download_format"),
            f"{label}.download_format",
            allowed_download_formats,
        ),
    )


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _optional_bool(value: Any, label: str) -> bool:
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    raise ConfigError(f"Expected bool for {label}, got {type(value).__name__}")


def _optional_choice(
    value: Any,
    label: str,
    allowed: tuple[str, ...] | None,
) -> str | None:
    if value is None:
        return None
    text = _optional_str(value, label)
    if allowed is not None and text not in allowed:
        options = ", ".join(allowed)
        raise ConfigError(f"Invalid value for {label}: {text!r}. Expected one of: {options}")
    return text


def _optional_float(value: Any, label: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    raise ConfigError(f"Expected float for {label}, got {type(value).__name__}")


def _optional_int(value: Any, label: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, int):
        return value
    raise ConfigError(f"Expected int for {label}, got {type(value).__name__}")


def _optional_positive_int(value: Any, label: str) -> int | None:
    number = _optional_int(value, label)
    if number is None:
        return None
    if number < 1:
        raise ConfigError(f"Expected {label} to be >= 1, got {number}")
    return number


def _optional_non_negative_int(value: Any, label: str) -> int | None:
    number = _optional_int(value, label)
    if number is None:
        return None
    if number < 0:
        raise ConfigError(f"Expected {label} to be >= 0, got {number}")
    return number


def _optional_positive_float(value: Any, label: str) -> float | None:
    number = _optional_float(value, label)
    if number is None:
        return None
    if number <= 0:
        raise ConfigError(f"Expected {label} to be > 0, got {number}")
    return number


def _optional_page_ranges(value: Any, label: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list):
        raise ConfigError(f"Expected array of strings for {label}, got {type(value).__name__}")

    ranges: list[str] = []
    for index, item in enumerate(value):
        text = _optional_str(item, f"{label}[{index}]")
        if text is None:
            raise ConfigError(f"Expected non-empty string for {label}[{index}]")
        ranges.append(text)
    return tuple(ranges)


def _optional_path(value: Any, label: str, base_dir: Path) -> str | None:
    text = _optional_str(value, label)
    if text is None:
        return None
    return str(_resolve_relative_path(text, base_dir))


def _optional_template_path(
    value: Any,
    label: str,
    base_dir: Path,
    source_path: str | None,
) -> str | None:
    text = _optional_str(value, label)
    if text is None:
        return None
    return str(
        _resolve_relative_path(_expand_source_path_placeholders(text, label, source_path), base_dir)
    )


def _optional_str(value: Any, label: str) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    raise ConfigError(f"Expected string for {label}, got {type(value).__name__}")


def _resolve_relative_path(value: str, base_dir: Path) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = (base_dir / path).resolve()
    else:
        path = path.resolve()
    return path


def _expand_source_path_placeholders(value: str, label: str, source_path: str | None) -> str:
    if "{source_stem}" not in value:
        return value
    if source_path is None:
        raise ConfigError(
            f"{label} uses {{source_stem}} but `source.path` is not set in this config."
        )
    return value.replace("{source_stem}", Path(source_path).stem)
