from __future__ import annotations

import asyncio
import importlib
import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from notebooklm_chunker.config import StudioConfig, StudiosConfig
from notebooklm_chunker.parsers import ChunkerError


_AUDIO_FORMAT_TO_MEMBER = {
    "deep-dive": "DEEP_DIVE",
    "brief": "BRIEF",
    "critique": "CRITIQUE",
    "debate": "DEBATE",
}
_AUDIO_LENGTH_TO_MEMBER = {
    "short": "SHORT",
    "default": "DEFAULT",
    "long": "LONG",
}
_VIDEO_FORMAT_TO_MEMBER = {
    "explainer": "EXPLAINER",
    "brief": "BRIEF",
}
_VIDEO_STYLE_TO_MEMBER = {
    "auto": "AUTO_SELECT",
    "classic": "CLASSIC",
    "whiteboard": "WHITEBOARD",
    "kawaii": "KAWAII",
    "anime": "ANIME",
    "watercolor": "WATERCOLOR",
    "retro-print": "RETRO_PRINT",
    "heritage": "HERITAGE",
    "paper-craft": "PAPER_CRAFT",
}
_REPORT_FORMAT_TO_MEMBER = {
    "briefing-doc": "BRIEFING_DOC",
    "study-guide": "STUDY_GUIDE",
    "blog-post": "BLOG_POST",
    "custom": "CUSTOM",
}
_SLIDE_FORMAT_TO_MEMBER = {
    "detailed": "DETAILED_DECK",
    "presenter": "PRESENTER_SLIDES",
}
_SLIDE_LENGTH_TO_MEMBER = {
    "default": "DEFAULT",
    "short": "SHORT",
}
_QUIZ_QUANTITY_TO_MEMBER = {
    "fewer": "FEWER",
    "standard": "STANDARD",
    "more": "MORE",
}
_QUIZ_DIFFICULTY_TO_MEMBER = {
    "easy": "EASY",
    "medium": "MEDIUM",
    "hard": "HARD",
}
_INFOGRAPHIC_ORIENTATION_TO_MEMBER = {
    "landscape": "LANDSCAPE",
    "portrait": "PORTRAIT",
    "square": "SQUARE",
}
_INFOGRAPHIC_DETAIL_TO_MEMBER = {
    "concise": "CONCISE",
    "standard": "STANDARD",
    "detailed": "DETAILED",
}


class UploadError(ChunkerError):
    """Raised when notebook uploads or studio generation fail."""


@dataclass(frozen=True, slots=True)
class UploadResult:
    file_path: str
    source_id: str | None


@dataclass(frozen=True, slots=True)
class StudioResult:
    studio: str
    artifact_id: str | None
    output_path: str | None
    source_file: str | None = None


class NotebookLMPyUploader:
    def upload_directory(
        self,
        directory: Path,
        *,
        notebook_id: str | None = None,
        notebook_title: str | None = None,
        reporter: Callable[[str], None] | None = None,
    ) -> tuple[str, list[UploadResult]]:
        markdown_files = _collect_markdown_files(directory)
        _emit(reporter, f"upload: found {len(markdown_files)} chunk file(s) in {directory}")
        return asyncio.run(
            self._upload_directory_async(
                markdown_files,
                notebook_id=notebook_id,
                notebook_title=notebook_title or directory.name,
                reporter=reporter,
            )
        )

    def ingest_directory(
        self,
        directory: Path,
        *,
        notebook_id: str | None = None,
        notebook_title: str | None = None,
        studios: StudiosConfig | None = None,
        studio_output_dir: Path | None = None,
        reporter: Callable[[str], None] | None = None,
    ) -> tuple[str, list[UploadResult], list[StudioResult]]:
        markdown_files = _collect_markdown_files(directory)
        _emit(reporter, f"upload: found {len(markdown_files)} chunk file(s) in {directory}")
        return asyncio.run(
            self._ingest_directory_async(
                markdown_files,
                notebook_id=notebook_id,
                notebook_title=notebook_title or directory.name,
                studios=studios or StudiosConfig(),
                studio_output_dir=studio_output_dir,
                reporter=reporter,
            )
        )

    def run_studios(
        self,
        *,
        notebook_id: str,
        studios: StudiosConfig,
        studio_output_dir: Path | None = None,
        reporter: Callable[[str], None] | None = None,
    ) -> list[StudioResult]:
        return asyncio.run(
            self._run_studios_async(
                notebook_id=notebook_id,
                studios=studios,
                studio_output_dir=studio_output_dir,
                source_ids=None,
                reporter=reporter,
            )
        )

    async def _upload_directory_async(
        self,
        markdown_files: list[Path],
        *,
        notebook_id: str | None,
        notebook_title: str,
        reporter: Callable[[str], None] | None,
    ) -> tuple[str, list[UploadResult]]:
        client_class = _load_notebooklm_client_class()
        try:
            async with await client_class.from_storage() as client:
                resolved_notebook_id = await _ensure_notebook(
                    client,
                    notebook_id=notebook_id,
                    notebook_title=notebook_title,
                    reporter=reporter,
                )
                uploaded = await _upload_markdown_files(
                    client,
                    resolved_notebook_id,
                    markdown_files,
                    reporter=reporter,
                )
                return resolved_notebook_id, uploaded
        except UploadError:
            raise
        except Exception as exc:  # pragma: no cover - exercised with mocked failure path if needed
            raise UploadError(
                "notebooklm-py upload failed. Make sure `notebooklm login` completed successfully."
            ) from exc

    async def _ingest_directory_async(
        self,
        markdown_files: list[Path],
        *,
        notebook_id: str | None,
        notebook_title: str,
        studios: StudiosConfig,
        studio_output_dir: Path | None,
        reporter: Callable[[str], None] | None,
    ) -> tuple[str, list[UploadResult], list[StudioResult]]:
        client_class = _load_notebooklm_client_class()
        rpc_module = _load_notebooklm_rpc_module()
        try:
            async with await client_class.from_storage() as client:
                resolved_notebook_id = await _ensure_notebook(
                    client,
                    notebook_id=notebook_id,
                    notebook_title=notebook_title,
                    reporter=reporter,
                )
                per_chunk_studios, aggregate_studios = _partition_studios(studios)
                per_chunk_job_count = len(per_chunk_studios.enabled_items()) * len(markdown_files)
                aggregate_job_count = len(aggregate_studios.enabled_items())
                if per_chunk_job_count:
                    _emit(reporter, f"studio: {per_chunk_job_count} per-chunk job(s) will start as uploads complete")
                if aggregate_job_count:
                    _emit(reporter, f"studio: {aggregate_job_count} notebook-level job(s) will start after uploads")

                uploaded: list[UploadResult] = []
                studio_results: list[StudioResult] = []
                total_files = len(markdown_files)
                for index, path in enumerate(markdown_files, start=1):
                    uploaded_item = await _upload_markdown_file(
                        client,
                        resolved_notebook_id,
                        path,
                        index=index,
                        total_files=total_files,
                        reporter=reporter,
                    )
                    uploaded.append(uploaded_item)
                    if uploaded_item.source_id and per_chunk_studios.enabled_items():
                        studio_results.extend(
                            await _run_enabled_studios(
                                client,
                                rpc_module,
                                notebook_id=resolved_notebook_id,
                                studios=per_chunk_studios,
                                studio_output_dir=studio_output_dir,
                                uploaded_sources=[uploaded_item],
                                source_ids=[uploaded_item.source_id],
                                reporter=reporter,
                                announce_queue=False,
                            )
                        )

                source_ids = [item.source_id for item in uploaded if item.source_id]
                if aggregate_studios.enabled_items():
                    studio_results.extend(
                        await _run_enabled_studios(
                            client,
                            rpc_module,
                            notebook_id=resolved_notebook_id,
                            studios=aggregate_studios,
                            studio_output_dir=studio_output_dir,
                            uploaded_sources=uploaded,
                            source_ids=source_ids or None,
                            reporter=reporter,
                            announce_queue=True,
                        )
                    )
                return resolved_notebook_id, uploaded, studio_results
        except UploadError:
            raise
        except Exception as exc:  # pragma: no cover - exercised with mocked failure path if needed
            raise UploadError(
                "notebooklm-py run failed. Make sure `notebooklm login` completed successfully."
            ) from exc

    async def _run_studios_async(
        self,
        *,
        notebook_id: str,
        studios: StudiosConfig,
        studio_output_dir: Path | None,
        source_ids: list[str] | None,
        reporter: Callable[[str], None] | None,
    ) -> list[StudioResult]:
        client_class = _load_notebooklm_client_class()
        rpc_module = _load_notebooklm_rpc_module()
        try:
            async with await client_class.from_storage() as client:
                return await _run_enabled_studios(
                    client,
                    rpc_module,
                    notebook_id=notebook_id,
                    studios=studios,
                    studio_output_dir=studio_output_dir,
                    uploaded_sources=None,
                    source_ids=source_ids,
                    reporter=reporter,
                )
        except UploadError:
            raise
        except Exception as exc:  # pragma: no cover - exercised with mocked failure path if needed
            raise UploadError(
                "notebooklm-py studio generation failed. Make sure `notebooklm login` completed successfully."
            ) from exc


def run_notebooklm_login() -> None:
    try:
        subprocess.run(["notebooklm", "login"], check=True)
    except FileNotFoundError as exc:
        raise UploadError(
            "The `notebooklm` CLI was not found. Install `notebooklm-chunker[full]` first."
        ) from exc
    except subprocess.CalledProcessError as exc:
        raise UploadError("`notebooklm login` failed.") from exc


def run_notebooklm_logout() -> tuple[list[str], str | None]:
    notebooklm_home = _notebooklm_home()
    removed_paths: list[str] = []

    for candidate in (
        notebooklm_home / "storage_state.json",
        notebooklm_home / "context.json",
    ):
        if candidate.exists():
            candidate.unlink()
            removed_paths.append(str(candidate))

    browser_profile = notebooklm_home / "browser_profile"
    if browser_profile.exists():
        shutil.rmtree(browser_profile)
        removed_paths.append(str(browser_profile))

    auth_json_note = None
    if os.getenv("NOTEBOOKLM_AUTH_JSON"):
        auth_json_note = (
            "NOTEBOOKLM_AUTH_JSON is set in the environment. `nblm logout` only removed local notebooklm-py "
            "storage; clear that environment variable yourself if you also want to drop injected auth state."
        )

    return removed_paths, auth_json_note


def _notebooklm_home() -> Path:
    configured = os.getenv("NOTEBOOKLM_HOME")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".notebooklm"


async def _ensure_notebook(
    client: Any,
    *,
    notebook_id: str | None,
    notebook_title: str,
    reporter: Callable[[str], None] | None,
) -> str:
    if notebook_id is not None:
        _emit(reporter, f"notebook: using existing {notebook_id}")
        return notebook_id

    _emit(reporter, f'notebook: creating "{notebook_title}"')
    notebook = await client.notebooks.create(notebook_title)
    resolved_notebook_id = _read_attr(notebook, "id")
    if not resolved_notebook_id:
        raise UploadError("notebooklm-py did not return a notebook ID after create().")
    _emit(reporter, f'notebook: created "{notebook_title}" -> {resolved_notebook_id}')
    return resolved_notebook_id


async def _upload_markdown_files(
    client: Any,
    notebook_id: str,
    markdown_files: list[Path],
    *,
    reporter: Callable[[str], None] | None,
) -> list[UploadResult]:
    uploaded: list[UploadResult] = []
    total_files = len(markdown_files)
    for index, path in enumerate(markdown_files, start=1):
        uploaded.append(
            await _upload_markdown_file(
                client,
                notebook_id,
                path,
                index=index,
                total_files=total_files,
                reporter=reporter,
            )
        )
    return uploaded


async def _upload_markdown_file(
    client: Any,
    notebook_id: str,
    path: Path,
    *,
    index: int,
    total_files: int,
    reporter: Callable[[str], None] | None,
) -> UploadResult:
    source = await client.sources.add_file(notebook_id, path, wait=True)
    source_id = _read_attr(source, "id")
    _emit(
        reporter,
        f"upload: {index}/{total_files} {path.name}"
        + (f" -> {source_id}" if source_id else ""),
    )
    return UploadResult(
        file_path=str(path),
        source_id=source_id,
    )


async def _run_enabled_studios(
    client: Any,
    rpc_module: Any,
    *,
    notebook_id: str,
    studios: StudiosConfig,
    studio_output_dir: Path | None,
    uploaded_sources: list[UploadResult] | None,
    source_ids: list[str] | None,
    reporter: Callable[[str], None] | None,
    announce_queue: bool = True,
) -> list[StudioResult]:
    jobs: list[tuple[str, StudioConfig, list[str] | None, str | None]] = []
    for studio_name, studio_config in studios.enabled_items():
        if studio_config.per_chunk:
            if not uploaded_sources:
                raise UploadError(
                    f"`studios.{studio_name}.per_chunk` requires chunk uploads from the same `nblm run` execution."
                )

            for uploaded in uploaded_sources:
                if uploaded.source_id is None:
                    continue
                jobs.append((studio_name, studio_config, [uploaded.source_id], Path(uploaded.file_path).name))
            continue

        jobs.append((studio_name, studio_config, source_ids, None))

    results: list[StudioResult] = []
    total_jobs = len(jobs)
    if total_jobs and announce_queue:
        _emit(reporter, f"studio: {total_jobs} generation job(s) queued")
    for index, (studio_name, studio_config, job_source_ids, source_file) in enumerate(jobs, start=1):
        results.append(
            await _run_single_studio(
                client,
                rpc_module,
                notebook_id=notebook_id,
                studio_name=studio_name,
                studio_config=studio_config,
                studio_output_dir=studio_output_dir,
                source_ids=job_source_ids,
                source_file=source_file,
                reporter=reporter,
                job_index=index,
                job_total=total_jobs,
            )
        )
    return results


async def _run_single_studio(
    client: Any,
    rpc_module: Any,
    *,
    notebook_id: str,
    studio_name: str,
    studio_config: StudioConfig,
    studio_output_dir: Path | None,
    source_ids: list[str] | None,
    source_file: str | None,
    reporter: Callable[[str], None] | None,
    job_index: int,
    job_total: int,
) -> StudioResult:
    output_path = _resolve_output_path(
        studio_name,
        studio_config,
        studio_output_dir,
        source_file=source_file,
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    _emit(reporter, f"studio: start {job_index}/{job_total} {_studio_label(studio_name, source_file)}")

    if studio_name == "audio":
        status = await client.artifacts.generate_audio(
            notebook_id,
            source_ids=source_ids,
            language=studio_config.language or "en",
            instructions=studio_config.prompt,
            audio_format=_enum_value(
                rpc_module,
                "AudioFormat",
                _AUDIO_FORMAT_TO_MEMBER,
                studio_config.format or "deep-dive",
            ),
            audio_length=_enum_value(
                rpc_module,
                "AudioLength",
                _AUDIO_LENGTH_TO_MEMBER,
                studio_config.length or "long",
            ),
        )
        status = await _wait_for_completion(client, notebook_id, status, "audio")
        downloaded = await client.artifacts.download_audio(
            notebook_id,
            str(output_path),
            artifact_id=status.task_id,
        )
        _emit(reporter, f"studio: done  {job_index}/{job_total} {_studio_label(studio_name, source_file)} -> {downloaded}")
        return StudioResult("audio", status.task_id, downloaded, source_file=source_file)

    if studio_name == "video":
        status = await client.artifacts.generate_video(
            notebook_id,
            source_ids=source_ids,
            language=studio_config.language or "en",
            instructions=studio_config.prompt,
            video_format=_enum_value(
                rpc_module,
                "VideoFormat",
                _VIDEO_FORMAT_TO_MEMBER,
                studio_config.format or "explainer",
            ),
            video_style=_enum_value(
                rpc_module,
                "VideoStyle",
                _VIDEO_STYLE_TO_MEMBER,
                studio_config.style or "whiteboard",
            ),
        )
        status = await _wait_for_completion(client, notebook_id, status, "video")
        downloaded = await client.artifacts.download_video(
            notebook_id,
            str(output_path),
            artifact_id=status.task_id,
        )
        _emit(reporter, f"studio: done  {job_index}/{job_total} {_studio_label(studio_name, source_file)} -> {downloaded}")
        return StudioResult("video", status.task_id, downloaded, source_file=source_file)

    if studio_name == "report":
        report_format = _enum_value(
            rpc_module,
            "ReportFormat",
            _REPORT_FORMAT_TO_MEMBER,
            studio_config.format or "study-guide",
        )
        status = await client.artifacts.generate_report(
            notebook_id,
            source_ids=source_ids,
            language=studio_config.language or "en",
            report_format=report_format,
            custom_prompt=studio_config.prompt if (studio_config.format or "study-guide") == "custom" else None,
            extra_instructions=studio_config.prompt if (studio_config.format or "study-guide") != "custom" else None,
        )
        status = await _wait_for_completion(client, notebook_id, status, "report")
        downloaded = await client.artifacts.download_report(
            notebook_id,
            str(output_path),
            artifact_id=status.task_id,
        )
        _emit(reporter, f"studio: done  {job_index}/{job_total} {_studio_label(studio_name, source_file)} -> {downloaded}")
        return StudioResult("report", status.task_id, downloaded, source_file=source_file)

    if studio_name == "slide_deck":
        status = await client.artifacts.generate_slide_deck(
            notebook_id,
            source_ids=source_ids,
            language=studio_config.language or "en",
            instructions=studio_config.prompt,
            slide_format=_enum_value(
                rpc_module,
                "SlideDeckFormat",
                _SLIDE_FORMAT_TO_MEMBER,
                studio_config.format or "detailed",
            ),
            slide_length=_enum_value(
                rpc_module,
                "SlideDeckLength",
                _SLIDE_LENGTH_TO_MEMBER,
                studio_config.length or "default",
            ),
        )
        status = await _wait_for_completion(client, notebook_id, status, "slide deck")
        download_format = studio_config.download_format or "pdf"
        downloaded = await client.artifacts.download_slide_deck(
            notebook_id,
            str(output_path),
            artifact_id=status.task_id,
            output_format=download_format,
        )
        _emit(reporter, f"studio: done  {job_index}/{job_total} {_studio_label(studio_name, source_file)} -> {downloaded}")
        return StudioResult("slide_deck", status.task_id, downloaded, source_file=source_file)

    if studio_name == "quiz":
        status = await client.artifacts.generate_quiz(
            notebook_id,
            source_ids=source_ids,
            instructions=studio_config.prompt,
            quantity=_enum_value(
                rpc_module,
                "QuizQuantity",
                _QUIZ_QUANTITY_TO_MEMBER,
                studio_config.quantity or "more",
            ),
            difficulty=_enum_value(
                rpc_module,
                "QuizDifficulty",
                _QUIZ_DIFFICULTY_TO_MEMBER,
                studio_config.difficulty or "hard",
            ),
        )
        status = await _wait_for_completion(client, notebook_id, status, "quiz")
        downloaded = await client.artifacts.download_quiz(
            notebook_id,
            str(output_path),
            artifact_id=status.task_id,
            output_format=studio_config.download_format or "json",
        )
        _emit(reporter, f"studio: done  {job_index}/{job_total} {_studio_label(studio_name, source_file)} -> {downloaded}")
        return StudioResult("quiz", status.task_id, downloaded, source_file=source_file)

    if studio_name == "flashcards":
        status = await client.artifacts.generate_flashcards(
            notebook_id,
            source_ids=source_ids,
            instructions=studio_config.prompt,
            quantity=_enum_value(
                rpc_module,
                "QuizQuantity",
                _QUIZ_QUANTITY_TO_MEMBER,
                studio_config.quantity or "more",
            ),
            difficulty=_enum_value(
                rpc_module,
                "QuizDifficulty",
                _QUIZ_DIFFICULTY_TO_MEMBER,
                studio_config.difficulty or "hard",
            ),
        )
        status = await _wait_for_completion(client, notebook_id, status, "flashcards")
        downloaded = await client.artifacts.download_flashcards(
            notebook_id,
            str(output_path),
            artifact_id=status.task_id,
            output_format=studio_config.download_format or "markdown",
        )
        _emit(reporter, f"studio: done  {job_index}/{job_total} {_studio_label(studio_name, source_file)} -> {downloaded}")
        return StudioResult("flashcards", status.task_id, downloaded, source_file=source_file)

    if studio_name == "infographic":
        status = await client.artifacts.generate_infographic(
            notebook_id,
            source_ids=source_ids,
            language=studio_config.language or "en",
            instructions=studio_config.prompt,
            orientation=_enum_value(
                rpc_module,
                "InfographicOrientation",
                _INFOGRAPHIC_ORIENTATION_TO_MEMBER,
                studio_config.orientation or "portrait",
            ),
            detail_level=_enum_value(
                rpc_module,
                "InfographicDetail",
                _INFOGRAPHIC_DETAIL_TO_MEMBER,
                studio_config.detail or "detailed",
            ),
        )
        status = await _wait_for_completion(client, notebook_id, status, "infographic")
        downloaded = await client.artifacts.download_infographic(
            notebook_id,
            str(output_path),
            artifact_id=status.task_id,
        )
        _emit(reporter, f"studio: done  {job_index}/{job_total} {_studio_label(studio_name, source_file)} -> {downloaded}")
        return StudioResult("infographic", status.task_id, downloaded, source_file=source_file)

    if studio_name == "data_table":
        status = await client.artifacts.generate_data_table(
            notebook_id,
            source_ids=source_ids,
            language=studio_config.language or "en",
            instructions=studio_config.prompt or _DEFAULT_DATA_TABLE_PROMPT,
        )
        status = await _wait_for_completion(client, notebook_id, status, "data table")
        downloaded = await client.artifacts.download_data_table(
            notebook_id,
            str(output_path),
            artifact_id=status.task_id,
        )
        _emit(reporter, f"studio: done  {job_index}/{job_total} {_studio_label(studio_name, source_file)} -> {downloaded}")
        return StudioResult("data_table", status.task_id, downloaded, source_file=source_file)

    if studio_name == "mind_map":
        result = await client.artifacts.generate_mind_map(
            notebook_id,
            source_ids=source_ids,
        )
        note_id = result.get("note_id") if isinstance(result, dict) else None
        downloaded = await client.artifacts.download_mind_map(
            notebook_id,
            str(output_path),
            artifact_id=note_id,
        )
        _emit(reporter, f"studio: done  {job_index}/{job_total} {_studio_label(studio_name, source_file)} -> {downloaded}")
        return StudioResult("mind_map", note_id, downloaded, source_file=source_file)

    raise UploadError(f"Unsupported studio type: {studio_name}")


async def _wait_for_completion(
    client: Any,
    notebook_id: str,
    status: Any,
    studio_label: str,
) -> Any:
    task_id = _read_attr(status, "task_id")
    if not task_id:
        raise UploadError(f"NotebookLM did not return a task ID for {studio_label}.")

    final_status = await client.artifacts.wait_for_completion(notebook_id, task_id, timeout=900.0)
    if getattr(final_status, "is_failed", False):
        error = _read_attr(final_status, "error") or f"{studio_label} generation failed."
        raise UploadError(str(error))
    return final_status


def _collect_markdown_files(directory: Path) -> list[Path]:
    manifest_path = directory / "manifest.json"
    if manifest_path.is_file():
        return _collect_manifest_markdown_files(directory, manifest_path)

    markdown_files = sorted(path for path in directory.glob("*.md") if path.is_file())
    if not markdown_files:
        raise UploadError(f"No Markdown chunk files found in {directory}")
    return markdown_files


def _collect_manifest_markdown_files(directory: Path, manifest_path: Path) -> list[Path]:
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise UploadError(f"Invalid manifest.json in {directory}: {exc}") from exc

    if not isinstance(manifest, list):
        raise UploadError(f"Invalid manifest.json in {directory}: expected a JSON array.")

    markdown_files: list[Path] = []
    seen: set[str] = set()
    for index, item in enumerate(manifest, start=1):
        if not isinstance(item, dict) or not isinstance(item.get("file"), str):
            raise UploadError(
                f"Invalid manifest.json in {directory}: entry {index} is missing a string `file` field."
            )
        filename = item["file"]
        if filename in seen:
            continue
        seen.add(filename)
        path = directory / filename
        if not path.is_file():
            raise UploadError(f"manifest.json references a missing chunk file: {path}")
        markdown_files.append(path)

    if not markdown_files:
        raise UploadError(f"No Markdown chunk files listed in {manifest_path}")
    return markdown_files


def _default_output_filename(studio_name: str, studio_config: StudioConfig) -> str:
    if studio_name == "audio":
        return "audio-overview.mp4"
    if studio_name == "video":
        return "video-overview.mp4"
    if studio_name == "report":
        return "report.md"
    if studio_name == "slide_deck":
        return f"slide-deck.{studio_config.download_format or 'pdf'}"
    if studio_name == "quiz":
        return f"quiz.{_interactive_extension(studio_config.download_format or 'json')}"
    if studio_name == "flashcards":
        return f"flashcards.{_interactive_extension(studio_config.download_format or 'markdown')}"
    if studio_name == "infographic":
        return "infographic.png"
    if studio_name == "data_table":
        return "data-table.csv"
    if studio_name == "mind_map":
        return "mind-map.json"
    raise UploadError(f"Unsupported studio type: {studio_name}")


def _per_chunk_output_filename(
    studio_name: str,
    studio_config: StudioConfig,
    *,
    source_file: str,
    configured_output_path: Path | None = None,
) -> str:
    source_stem = Path(source_file).stem
    if configured_output_path is not None:
        suffix = configured_output_path.suffix
        if not suffix:
            suffix = "." + _default_output_filename(studio_name, studio_config).split(".")[-1]
        return f"{source_stem}-{configured_output_path.stem}{suffix}"
    return f"{source_stem}-{_default_output_filename(studio_name, studio_config)}"


def _interactive_extension(output_format: str) -> str:
    return {"json": "json", "markdown": "md", "html": "html"}[output_format]


def _resolve_output_path(
    studio_name: str,
    studio_config: StudioConfig,
    studio_output_dir: Path | None,
    *,
    source_file: str | None,
) -> Path:
    if studio_config.per_chunk:
        if source_file is None:
            raise UploadError(f"{studio_name} per-chunk generation requires a source file label.")
        if studio_config.output_dir is not None:
            base_dir = Path(studio_config.output_dir)
            return base_dir / _per_chunk_output_filename(
                studio_name,
                studio_config,
                source_file=source_file,
            )
        if studio_config.output_path is not None:
            configured = Path(studio_config.output_path)
            return configured.parent / _per_chunk_output_filename(
                studio_name,
                studio_config,
                source_file=source_file,
                configured_output_path=configured,
            )
        base_dir = (studio_output_dir or (Path.cwd() / "nblm-studio")).resolve() / studio_name.replace("_", "-")
        return base_dir / _per_chunk_output_filename(
            studio_name,
            studio_config,
            source_file=source_file,
        )

    if studio_config.output_path is not None:
        return Path(studio_config.output_path)
    base_dir = (studio_output_dir or (Path.cwd() / "nblm-studio")).resolve()
    return base_dir / _default_output_filename(studio_name, studio_config)


def _enum_value(
    rpc_module: Any,
    class_name: str,
    member_map: dict[str, str],
    value: str | None,
) -> Any | None:
    if value is None:
        return None
    enum_class = getattr(rpc_module, class_name, None)
    if enum_class is None:
        raise UploadError(f"notebooklm-py is missing enum {class_name}.")
    member_name = member_map[value]
    return getattr(enum_class, member_name)


def _load_notebooklm_client_class() -> Any:
    try:
        module = importlib.import_module("notebooklm")
    except ImportError as exc:
        raise UploadError(
            "notebooklm-py is not installed. Run `pip install \"notebooklm-chunker[full]\"` first."
        ) from exc

    client_class = getattr(module, "NotebookLMClient", None)
    if client_class is None:
        raise UploadError("notebooklm-py is installed but `NotebookLMClient` was not found.")
    return client_class


def _load_notebooklm_rpc_module() -> Any:
    try:
        return importlib.import_module("notebooklm.rpc")
    except ImportError as exc:
        raise UploadError("notebooklm-py is installed but `notebooklm.rpc` could not be imported.") from exc


def _read_attr(value: Any, name: str) -> str | None:
    attr = getattr(value, name, None)
    if attr is None:
        return None
    if not isinstance(attr, str):
        return str(attr)
    return attr


def _emit(reporter: Callable[[str], None] | None, message: str) -> None:
    if reporter is not None:
        reporter(message)


def _studio_label(studio_name: str, source_file: str | None) -> str:
    label = studio_name.replace("_", "-")
    if source_file:
        return f"{label} [{source_file}]"
    return label


def _partition_studios(studios: StudiosConfig) -> tuple[StudiosConfig, StudiosConfig]:
    per_chunk_kwargs: dict[str, StudioConfig] = {}
    aggregate_kwargs: dict[str, StudioConfig] = {}
    for name in (
        "audio",
        "video",
        "report",
        "slide_deck",
        "quiz",
        "flashcards",
        "infographic",
        "data_table",
        "mind_map",
    ):
        config = getattr(studios, name)
        per_chunk_kwargs[name] = config if config.enabled and config.per_chunk else StudioConfig()
        aggregate_kwargs[name] = config if config.enabled and not config.per_chunk else StudioConfig()
    return StudiosConfig(**per_chunk_kwargs), StudiosConfig(**aggregate_kwargs)


_DEFAULT_DATA_TABLE_PROMPT = (
    "Create a structured comparison table of the most important concepts, examples, and takeaways."
)
