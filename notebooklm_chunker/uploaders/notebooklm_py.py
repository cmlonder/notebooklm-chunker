from __future__ import annotations

import asyncio
import importlib
import json
import os
import re
import shutil
import subprocess
from datetime import UTC, datetime, timedelta
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from notebooklm_chunker.config import StudioConfig, StudiosConfig
from notebooklm_chunker.parsers import ChunkerError
from notebooklm_chunker.run_state import RunStateStore, chunk_content_hash

DEFAULT_STUDIO_WAIT_TIMEOUT_SECONDS = 7200.0
DEFAULT_STUDIO_CREATE_RETRIES = 3
DEFAULT_STUDIO_CREATE_BACKOFF_SECONDS = 2.0
DEFAULT_STUDIO_RATE_LIMIT_COOLDOWN_SECONDS = 30.0
DEFAULT_MAX_PARALLEL_HEAVY_STUDIOS = 1
RUN_STATE_BASENAME = ".nblm-run-state.json"

_HEAVY_STUDIO_NAMES = frozenset({"audio", "video", "slide_deck", "infographic"})
_BACKGROUND_STUDIO_NAMES = frozenset({"video", "slide_deck"})


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


class QuotaExceededError(UploadError):
    """Raised when NotebookLM appears to have hit a longer-lived quota block."""

    def __init__(self, message: str, *, blocked_until: str) -> None:
        super().__init__(message)
        self.blocked_until = blocked_until


@dataclass(frozen=True, slots=True)
class UploadResult:
    file_path: str
    source_id: str | None
    remote_title: str | None = None


@dataclass(frozen=True, slots=True)
class PendingTaskStatus:
    task_id: str


@dataclass(frozen=True, slots=True)
class StudioResult:
    studio: str
    artifact_id: str | None
    output_path: str | None
    source_file: str | None = None
    remote_title: str | None = None
    status: str = "completed"


@dataclass(slots=True)
class CreateQuotaCooldown:
    minimum_cooldown_seconds: float
    _lock: asyncio.Lock = field(init=False, repr=False)
    _next_allowed_at: float = field(init=False, default=0.0, repr=False)

    def __post_init__(self) -> None:
        self._lock = asyncio.Lock()
        self._next_allowed_at = 0.0

    async def wait_if_needed(self) -> float:
        waited = 0.0
        while True:
            async with self._lock:
                now = asyncio.get_running_loop().time()
                delay = self._next_allowed_at - now
            if delay <= 0:
                return waited
            waited += delay
            await asyncio.sleep(delay)

    async def extend(self, delay_seconds: float) -> float:
        async with self._lock:
            loop = asyncio.get_running_loop()
            now = loop.time()
            target = now + max(delay_seconds, self.minimum_cooldown_seconds)
            if target > self._next_allowed_at:
                self._next_allowed_at = target
            return max(0.0, self._next_allowed_at - now)


class NotebookLMPyUploader:
    def upload_directory(
        self,
        directory: Path,
        *,
        notebook_id: str | None = None,
        notebook_title: str | None = None,
        max_parallel_chunks: int = 1,
        studio_wait_timeout_seconds: float = DEFAULT_STUDIO_WAIT_TIMEOUT_SECONDS,
        studio_rate_limit_cooldown_seconds: float = DEFAULT_STUDIO_RATE_LIMIT_COOLDOWN_SECONDS,
        rename_remote_titles: bool = False,
        reporter: Callable[[str], None] | None = None,
    ) -> tuple[str, list[UploadResult]]:
        markdown_files = _collect_markdown_files(directory)
        _emit(reporter, f"upload: found {len(markdown_files)} chunk file(s) in {directory}")
        return asyncio.run(
            self._upload_directory_async(
                markdown_files,
                notebook_id=notebook_id,
                notebook_title=notebook_title or directory.name,
                max_parallel_chunks=max_parallel_chunks,
                studio_wait_timeout_seconds=studio_wait_timeout_seconds,
                studio_rate_limit_cooldown_seconds=studio_rate_limit_cooldown_seconds,
                rename_remote_titles=rename_remote_titles,
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
        max_parallel_chunks: int = 1,
        max_parallel_heavy_studios: int = DEFAULT_MAX_PARALLEL_HEAVY_STUDIOS,
        studio_wait_timeout_seconds: float = DEFAULT_STUDIO_WAIT_TIMEOUT_SECONDS,
        studio_create_retries: int = DEFAULT_STUDIO_CREATE_RETRIES,
        studio_create_backoff_seconds: float = DEFAULT_STUDIO_CREATE_BACKOFF_SECONDS,
        studio_rate_limit_cooldown_seconds: float = DEFAULT_STUDIO_RATE_LIMIT_COOLDOWN_SECONDS,
        rename_remote_titles: bool = False,
        download_outputs: bool = True,
        resume: bool = False,
        reporter: Callable[[str], None] | None = None,
    ) -> tuple[str, list[UploadResult], list[StudioResult]]:
        markdown_files = _collect_markdown_files(directory)
        _emit(reporter, f"upload: found {len(markdown_files)} chunk file(s) in {directory}")
        return asyncio.run(
            self._ingest_directory_async(
                directory=directory,
                markdown_files=markdown_files,
                notebook_id=notebook_id,
                notebook_title=notebook_title or directory.name,
                studios=studios or StudiosConfig(),
                studio_output_dir=studio_output_dir,
                max_parallel_chunks=max_parallel_chunks,
                max_parallel_heavy_studios=max_parallel_heavy_studios,
                studio_wait_timeout_seconds=studio_wait_timeout_seconds,
                studio_create_retries=studio_create_retries,
                studio_create_backoff_seconds=studio_create_backoff_seconds,
                studio_rate_limit_cooldown_seconds=studio_rate_limit_cooldown_seconds,
                rename_remote_titles=rename_remote_titles,
                download_outputs=download_outputs,
                resume=resume,
                reporter=reporter,
            )
        )

    def run_studios(
        self,
        *,
        notebook_id: str | None,
        studios: StudiosConfig,
        studio_output_dir: Path | None = None,
        run_state_path: Path | None = None,
        max_parallel_heavy_studios: int = DEFAULT_MAX_PARALLEL_HEAVY_STUDIOS,
        studio_wait_timeout_seconds: float = DEFAULT_STUDIO_WAIT_TIMEOUT_SECONDS,
        studio_create_retries: int = DEFAULT_STUDIO_CREATE_RETRIES,
        studio_create_backoff_seconds: float = DEFAULT_STUDIO_CREATE_BACKOFF_SECONDS,
        studio_rate_limit_cooldown_seconds: float = DEFAULT_STUDIO_RATE_LIMIT_COOLDOWN_SECONDS,
        rename_remote_titles: bool = False,
        download_outputs: bool = True,
        reporter: Callable[[str], None] | None = None,
    ) -> list[StudioResult]:
        return asyncio.run(
            self._run_studios_async(
                notebook_id=notebook_id,
                studios=studios,
                studio_output_dir=studio_output_dir,
                run_state_path=run_state_path,
                source_ids=None,
                max_parallel_heavy_studios=max_parallel_heavy_studios,
                studio_wait_timeout_seconds=studio_wait_timeout_seconds,
                studio_create_retries=studio_create_retries,
                studio_create_backoff_seconds=studio_create_backoff_seconds,
                studio_rate_limit_cooldown_seconds=studio_rate_limit_cooldown_seconds,
                rename_remote_titles=rename_remote_titles,
                download_outputs=download_outputs,
                reporter=reporter,
            )
        )

    async def _upload_directory_async(
        self,
        markdown_files: list[Path],
        *,
        notebook_id: str | None,
        notebook_title: str,
        max_parallel_chunks: int,
        studio_wait_timeout_seconds: float,
        studio_rate_limit_cooldown_seconds: float,
        rename_remote_titles: bool,
        reporter: Callable[[str], None] | None,
    ) -> tuple[str, list[UploadResult]]:
        max_parallel_chunks = _normalize_parallelism(max_parallel_chunks)
        _normalize_wait_timeout(studio_wait_timeout_seconds)
        _normalize_quota_cooldown(studio_rate_limit_cooldown_seconds)
        client_class = _load_notebooklm_client_class()
        try:
            async with await client_class.from_storage() as client:
                resolved_notebook_id = await _ensure_notebook(
                    client,
                    notebook_id=notebook_id,
                    notebook_title=notebook_title,
                    resume_state_path=None,
                    reporter=reporter,
                )
                uploaded = await _upload_markdown_files(
                    client,
                    resolved_notebook_id,
                    markdown_files,
                    max_parallel_chunks=max_parallel_chunks,
                    rename_remote_titles=rename_remote_titles,
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
        *,
        directory: Path,
        markdown_files: list[Path],
        notebook_id: str | None,
        notebook_title: str,
        studios: StudiosConfig,
        studio_output_dir: Path | None,
        max_parallel_chunks: int,
        max_parallel_heavy_studios: int,
        studio_wait_timeout_seconds: float,
        studio_create_retries: int,
        studio_create_backoff_seconds: float,
        studio_rate_limit_cooldown_seconds: float,
        rename_remote_titles: bool,
        download_outputs: bool,
        resume: bool,
        reporter: Callable[[str], None] | None,
    ) -> tuple[str, list[UploadResult], list[StudioResult]]:
        max_parallel_chunks = _normalize_parallelism(max_parallel_chunks)
        max_parallel_heavy_studios = _normalize_parallelism(max_parallel_heavy_studios)
        studio_wait_timeout_seconds = _normalize_wait_timeout(studio_wait_timeout_seconds)
        studio_create_retries = _normalize_create_retries(studio_create_retries)
        studio_create_backoff_seconds = _normalize_create_backoff(studio_create_backoff_seconds)
        studio_rate_limit_cooldown_seconds = _normalize_quota_cooldown(studio_rate_limit_cooldown_seconds)
        client_class = _load_notebooklm_client_class()
        rpc_module = _load_notebooklm_rpc_module()
        run_state = _open_run_state(directory / RUN_STATE_BASENAME, resume=resume)
        create_quota_cooldown = CreateQuotaCooldown(studio_rate_limit_cooldown_seconds)
        try:
            async with await client_class.from_storage() as client:
                if resume:
                    notebook_id = _resolve_resume_notebook_id(
                        run_state,
                        requested_notebook_id=notebook_id,
                        reporter=reporter,
                    )
                resolved_notebook_id = await _ensure_notebook(
                    client,
                    notebook_id=notebook_id,
                    notebook_title=notebook_title,
                    resume_state_path=run_state.path if resume else None,
                    reporter=reporter,
                )
                await run_state.set_notebook(notebook_id=resolved_notebook_id, notebook_title=notebook_title)
                per_chunk_studios, aggregate_studios = _partition_studios(studios)
                per_chunk_job_count = len(per_chunk_studios.enabled_items()) * len(markdown_files)
                aggregate_job_count = len(aggregate_studios.enabled_items())
                if per_chunk_job_count:
                    _emit(reporter, f"studio: {per_chunk_job_count} per-chunk job(s) will start as uploads complete")
                if aggregate_job_count:
                    _emit(reporter, f"studio: {aggregate_job_count} notebook-level job(s) will start after uploads")
                if max_parallel_chunks > 1 and len(markdown_files) > 1:
                    _emit(
                        reporter,
                        f"runtime: processing up to {max_parallel_chunks} chunk upload(s) in parallel",
                    )
                _emit_heavy_studio_parallelism(
                    studios,
                    max_parallel_heavy_studios=max_parallel_heavy_studios,
                    reporter=reporter,
                )
                studio_locks = _build_remote_rename_locks(studios, rename_remote_titles=rename_remote_titles)
                studio_semaphores = _build_studio_execution_semaphores(
                    studios,
                    max_parallel_heavy_studios=max_parallel_heavy_studios,
                )

                uploaded, studio_results = await _run_chunk_pipelines(
                    client,
                    rpc_module,
                    notebook_id=resolved_notebook_id,
                    markdown_files=markdown_files,
                    per_chunk_studios=per_chunk_studios,
                    studio_output_dir=studio_output_dir,
                    studio_locks=studio_locks,
                    studio_semaphores=studio_semaphores,
                    run_state=run_state,
                    max_parallel_chunks=max_parallel_chunks,
                    max_parallel_heavy_studios=max_parallel_heavy_studios,
                    studio_wait_timeout_seconds=studio_wait_timeout_seconds,
                    studio_create_retries=studio_create_retries,
                    studio_create_backoff_seconds=studio_create_backoff_seconds,
                    create_quota_cooldown=create_quota_cooldown,
                    rename_remote_titles=rename_remote_titles,
                    download_outputs=download_outputs,
                    reporter=reporter,
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
                            studio_locks=studio_locks,
                            studio_semaphores=studio_semaphores,
                            run_state=run_state,
                            studio_wait_timeout_seconds=studio_wait_timeout_seconds,
                            studio_create_retries=studio_create_retries,
                            studio_create_backoff_seconds=studio_create_backoff_seconds,
                            create_quota_cooldown=create_quota_cooldown,
                            rename_remote_titles=rename_remote_titles,
                            download_outputs=download_outputs,
                            reporter=reporter,
                            announce_queue=True,
                        )
                    )
                _raise_for_relevant_quota_blocks(run_state, studios=studios)
                return resolved_notebook_id, uploaded, studio_results
        except QuotaExceededError:
            raise
        except UploadError:
            raise
        except Exception as exc:  # pragma: no cover - exercised with mocked failure path if needed
            raise UploadError(
                "notebooklm-py run failed. Make sure `notebooklm login` completed successfully."
            ) from exc

    async def _run_studios_async(
        self,
        *,
        notebook_id: str | None,
        studios: StudiosConfig,
        studio_output_dir: Path | None,
        run_state_path: Path | None,
        source_ids: list[str] | None,
        max_parallel_heavy_studios: int,
        studio_wait_timeout_seconds: float,
        studio_create_retries: int,
        studio_create_backoff_seconds: float,
        studio_rate_limit_cooldown_seconds: float,
        rename_remote_titles: bool,
        download_outputs: bool,
        reporter: Callable[[str], None] | None,
    ) -> list[StudioResult]:
        studio_wait_timeout_seconds = _normalize_wait_timeout(studio_wait_timeout_seconds)
        max_parallel_heavy_studios = _normalize_parallelism(max_parallel_heavy_studios)
        studio_create_retries = _normalize_create_retries(studio_create_retries)
        studio_create_backoff_seconds = _normalize_create_backoff(studio_create_backoff_seconds)
        studio_rate_limit_cooldown_seconds = _normalize_quota_cooldown(studio_rate_limit_cooldown_seconds)
        client_class = _load_notebooklm_client_class()
        rpc_module = _load_notebooklm_rpc_module()
        create_quota_cooldown = CreateQuotaCooldown(studio_rate_limit_cooldown_seconds)
        run_state = None
        uploaded_sources: list[UploadResult] | None = None
        if run_state_path is not None and run_state_path.is_file():
            run_state = RunStateStore.load(run_state_path)
            notebook_id = _resolve_state_notebook_id(
                run_state,
                requested_notebook_id=notebook_id,
                reporter=reporter,
                mode_label="studios",
            )
            uploaded_sources = _uploaded_sources_from_run_state(run_state)
            if uploaded_sources:
                _emit(
                    reporter,
                    f"studio: using {len(uploaded_sources)} uploaded chunk source(s) from {run_state.path.name}",
                )
                if source_ids is None:
                    source_ids = [item.source_id for item in uploaded_sources if item.source_id]
        elif notebook_id is None:
            raise UploadError(
                "Notebook ID is required for `nblm studios` unless a previous `.nblm-run-state.json` is available."
            )
        if notebook_id is None:
            raise UploadError(
                "The saved `.nblm-run-state.json` does not contain a notebook ID. Run `nblm run` again, "
                "or pass `--notebook-id` to `nblm studios`."
            )
        try:
            async with await client_class.from_storage() as client:
                existing_notebook = await _verify_existing_notebook(
                    client,
                    notebook_id=notebook_id,
                    resume_state_path=run_state.path if run_state is not None else None,
                )
                if existing_notebook is None:
                    _emit(
                        reporter,
                        "notebook: using existing "
                        f"{notebook_id} (notebook existence could not be verified; this notebooklm-py "
                        "version does not expose notebooks.get/list)",
                    )
                else:
                    title = _read_attr(existing_notebook, "title")
                    title_suffix = f' "{title}"' if title else ""
                    _emit(reporter, f"notebook: verified existing {notebook_id}{title_suffix}")
                _emit_heavy_studio_parallelism(
                    studios,
                    max_parallel_heavy_studios=max_parallel_heavy_studios,
                    reporter=reporter,
                )
                return await _run_enabled_studios(
                    client,
                    rpc_module,
                    notebook_id=notebook_id,
                    studios=studios,
                    studio_output_dir=studio_output_dir,
                    uploaded_sources=uploaded_sources,
                    source_ids=source_ids,
                    studio_locks=_build_remote_rename_locks(studios, rename_remote_titles=rename_remote_titles),
                    studio_semaphores=_build_studio_execution_semaphores(
                        studios,
                        max_parallel_heavy_studios=max_parallel_heavy_studios,
                    ),
                    run_state=run_state,
                    studio_wait_timeout_seconds=studio_wait_timeout_seconds,
                    studio_create_retries=studio_create_retries,
                    studio_create_backoff_seconds=studio_create_backoff_seconds,
                    create_quota_cooldown=create_quota_cooldown,
                    rename_remote_titles=rename_remote_titles,
                    download_outputs=download_outputs,
                    reporter=reporter,
                )
                if run_state is not None:
                    _raise_for_relevant_quota_blocks(run_state, studios=studios)
        except QuotaExceededError:
            raise
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
    resume_state_path: Path | None = None,
    reporter: Callable[[str], None] | None,
) -> str:
    if notebook_id is not None:
        existing_notebook = await _verify_existing_notebook(
            client,
            notebook_id=notebook_id,
            resume_state_path=resume_state_path,
        )
        if existing_notebook is None:
            _emit(
                reporter,
                "notebook: using existing "
                f"{notebook_id} (notebook existence could not be verified; this notebooklm-py "
                "version does not expose notebooks.get/list)",
            )
            return notebook_id

        title = _read_attr(existing_notebook, "title")
        title_suffix = f' "{title}"' if title else ""
        _emit(reporter, f"notebook: verified existing {notebook_id}{title_suffix}")
        return notebook_id

    _emit(reporter, f'notebook: creating "{notebook_title}"')
    notebook = await client.notebooks.create(notebook_title)
    resolved_notebook_id = _read_attr(notebook, "id")
    if not resolved_notebook_id:
        raise UploadError("notebooklm-py did not return a notebook ID after create().")
    _emit(reporter, f'notebook: created "{notebook_title}" -> {resolved_notebook_id}')
    return resolved_notebook_id


async def _verify_existing_notebook(
    client: Any,
    *,
    notebook_id: str,
    resume_state_path: Path | None,
) -> Any | None:
    notebooks_api = getattr(client, "notebooks", None)
    get_method = getattr(notebooks_api, "get", None)
    if callable(get_method):
        try:
            notebook = await get_method(notebook_id)
        except Exception as exc:
            raise UploadError(
                _describe_notebook_verification_failure(
                    notebook_id,
                    exc=exc,
                    resume_state_path=resume_state_path,
                )
            ) from exc
        resolved_notebook_id = _read_attr(notebook, "id")
        if resolved_notebook_id == notebook_id:
            return notebook
        raise UploadError(
            _describe_missing_notebook(
                notebook_id,
                resume_state_path=resume_state_path,
                details=f"notebooks.get returned notebook id {resolved_notebook_id!r}",
            )
        )

    list_method = getattr(notebooks_api, "list", None)
    if callable(list_method):
        try:
            notebooks = await list_method()
        except Exception as exc:
            raise UploadError(
                _describe_notebook_verification_failure(
                    notebook_id,
                    exc=exc,
                    resume_state_path=resume_state_path,
                )
            ) from exc
        for notebook in notebooks or []:
            if _read_attr(notebook, "id") == notebook_id:
                return notebook
        raise UploadError(
            _describe_missing_notebook(
                notebook_id,
                resume_state_path=resume_state_path,
            )
        )

    return None


async def _upload_markdown_files(
    client: Any,
    notebook_id: str,
    markdown_files: list[Path],
    *,
    max_parallel_chunks: int,
    rename_remote_titles: bool,
    reporter: Callable[[str], None] | None,
) -> list[UploadResult]:
    total_files = len(markdown_files)
    if max_parallel_chunks > 1 and total_files > 1:
        _emit(reporter, f"runtime: processing up to {max_parallel_chunks} chunk upload(s) in parallel")

    async def upload_one(index: int, path: Path) -> UploadResult:
        return await _upload_markdown_file(
            client,
            notebook_id,
            path,
            index=index,
            total_files=total_files,
            rename_remote_titles=rename_remote_titles,
            reporter=reporter,
        )

    return await _gather_chunk_tasks(
        markdown_files,
        max_parallel_chunks=max_parallel_chunks,
        operation=upload_one,
    )


async def _run_chunk_pipelines(
    client: Any,
    rpc_module: Any,
    *,
    notebook_id: str,
    markdown_files: list[Path],
    per_chunk_studios: StudiosConfig,
    studio_output_dir: Path | None,
    studio_locks: dict[str, asyncio.Lock] | None,
    studio_semaphores: dict[str, asyncio.Semaphore] | None,
    run_state: RunStateStore,
    max_parallel_chunks: int,
    max_parallel_heavy_studios: int,
    studio_wait_timeout_seconds: float,
    studio_create_retries: int,
    studio_create_backoff_seconds: float,
    create_quota_cooldown: CreateQuotaCooldown,
    rename_remote_titles: bool,
    download_outputs: bool,
    reporter: Callable[[str], None] | None,
) -> tuple[list[UploadResult], list[StudioResult]]:
    total_files = len(markdown_files)
    per_chunk_items = per_chunk_studios.enabled_items()
    job_total = len(per_chunk_items) * total_files
    job_indices = _build_per_chunk_job_indices(markdown_files, per_chunk_items)
    studio_queues: dict[str, asyncio.Queue[UploadResult | None]] = {}
    studio_worker_counts: dict[str, int] = {}
    studio_workers: list[asyncio.Task[list[StudioResult]]] = []
    blocked_studios: dict[str, str] = {}

    for studio_name, studio_config in per_chunk_items:
        queue: asyncio.Queue[UploadResult | None] = asyncio.Queue()
        studio_queues[studio_name] = queue
        worker_count = _per_chunk_studio_worker_count(
            studio_name,
            studio_config,
            max_parallel_chunks=max_parallel_chunks,
            max_parallel_heavy_studios=max_parallel_heavy_studios,
        )
        studio_worker_counts[studio_name] = worker_count

        def _make_worker(
            current_studio_name: str,
            current_studio_config: StudioConfig,
            current_queue: asyncio.Queue[UploadResult | None],
        ) -> Callable[[], Awaitable[list[StudioResult]]]:
            async def worker() -> list[StudioResult]:
                results: list[StudioResult] = []
                while True:
                    uploaded_item = await current_queue.get()
                    if uploaded_item is None:
                        current_queue.task_done()
                        return results
                    try:
                        if uploaded_item.source_id is None:
                            continue
                        if current_studio_name in blocked_studios:
                            continue
                        results.append(
                            await _run_single_studio(
                                client,
                                rpc_module,
                                notebook_id=notebook_id,
                                studio_name=current_studio_name,
                                studio_config=current_studio_config,
                                studio_output_dir=studio_output_dir,
                                source_ids=[uploaded_item.source_id],
                                source_file=Path(uploaded_item.file_path).name,
                                source_remote_title=uploaded_item.remote_title,
                                studio_locks=studio_locks,
                                studio_semaphores=studio_semaphores,
                                run_state=run_state,
                                studio_wait_timeout_seconds=studio_wait_timeout_seconds,
                                studio_create_retries=studio_create_retries,
                                studio_create_backoff_seconds=studio_create_backoff_seconds,
                                create_quota_cooldown=create_quota_cooldown,
                                rename_remote_titles=rename_remote_titles,
                                download_outputs=download_outputs,
                                studio_quota_blocks=blocked_studios,
                                reporter=reporter,
                                job_index=job_indices[(current_studio_name, Path(uploaded_item.file_path).name)],
                                job_total=job_total,
                            )
                        )
                    except QuotaExceededError as exc:
                        if current_studio_name not in blocked_studios:
                            blocked_studios[current_studio_name] = exc.blocked_until
                            _emit(
                                reporter,
                                f"studio: suspending remaining {current_studio_name.replace('_', '-')} jobs until {exc.blocked_until}",
                            )
                    finally:
                        current_queue.task_done()

            return worker

        studio_workers.extend(
            asyncio.create_task(_make_worker(studio_name, studio_config, queue)())
            for _ in range(worker_count)
        )

    async def process_one(index: int, path: Path) -> tuple[UploadResult, list[StudioResult]]:
        uploaded_item = await _upload_markdown_file(
            client,
            notebook_id,
            path,
            index=index,
            total_files=total_files,
            rename_remote_titles=rename_remote_titles,
            reporter=reporter,
            run_state=run_state,
        )
        if uploaded_item.source_id:
            for studio_name, _ in per_chunk_items:
                await studio_queues[studio_name].put(uploaded_item)
        return uploaded_item, []

    chunk_results = await _gather_chunk_tasks(
        markdown_files,
        max_parallel_chunks=max_parallel_chunks,
        operation=process_one,
    )
    uploaded = [uploaded_item for uploaded_item, _ in chunk_results]

    studio_results: list[StudioResult] = []
    for studio_name, queue in studio_queues.items():
        for _ in range(studio_worker_counts[studio_name]):
            await queue.put(None)
    worker_results = await asyncio.gather(*studio_workers)
    for result_set in worker_results:
        studio_results.extend(result_set)

    return uploaded, studio_results


async def _gather_studio_results(studio_tasks: list[asyncio.Task[list[StudioResult]]]) -> list[StudioResult]:
    if not studio_tasks:
        return []
    try:
        results = await asyncio.gather(*studio_tasks)
    except Exception:
        for task in studio_tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*studio_tasks, return_exceptions=True)
        raise

    flattened: list[StudioResult] = []
    for chunk_results in results:
        flattened.extend(chunk_results)
    return flattened


async def _gather_chunk_tasks(
    markdown_files: list[Path],
    *,
    max_parallel_chunks: int,
    operation: Callable[[int, Path], Any],
) -> list[Any]:
    if max_parallel_chunks <= 1 or len(markdown_files) <= 1:
        results: list[Any] = []
        for index, path in enumerate(markdown_files, start=1):
            results.append(await operation(index, path))
        return results

    semaphore = asyncio.Semaphore(max_parallel_chunks)

    async def worker(index: int, path: Path) -> Any:
        async with semaphore:
            return await operation(index, path)

    tasks = [worker(index, path) for index, path in enumerate(markdown_files, start=1)]
    return list(await asyncio.gather(*tasks))


async def _upload_markdown_file(
    client: Any,
    notebook_id: str,
    path: Path,
    *,
    index: int,
    total_files: int,
    rename_remote_titles: bool,
    reporter: Callable[[str], None] | None,
    run_state: RunStateStore | None = None,
) -> UploadResult:
    content_hash = chunk_content_hash(path)
    if run_state is not None:
        resumed = run_state.uploaded_source(path.name, content_hash=content_hash)
        if resumed is not None:
            source_id, remote_title = resumed
            _emit(
                reporter,
                f"upload: resume {index}/{total_files} {path.name} -> {source_id}",
            )
            return UploadResult(
                file_path=str(path),
                source_id=source_id,
                remote_title=remote_title,
            )

    if run_state is not None:
        await run_state.record_source_state(
            file_name=path.name,
            content_hash=content_hash,
            status="uploading",
            last_error=None,
        )

    try:
        source = await client.sources.add_file(notebook_id, path, wait=True)
    except Exception as exc:
        if run_state is not None:
            await run_state.record_source_failed(
                file_name=path.name,
                content_hash=content_hash,
                error=_describe_exception(exc),
            )
        raise

    source_id = _read_attr(source, "id")
    if source_id is None:
        error = f"NotebookLM did not return a source ID after uploading {path.name}."
        if run_state is not None:
            await run_state.record_source_failed(
                file_name=path.name,
                content_hash=content_hash,
                error=error,
            )
        raise UploadError(error)

    if run_state is not None:
        await run_state.record_source_uploaded(
            file_name=path.name,
            content_hash=content_hash,
            source_id=source_id,
            remote_title=None,
        )

    _emit(
        reporter,
        f"upload: {index}/{total_files} {path.name}"
        + (f" -> {source_id}" if source_id else ""),
    )
    remote_title = None
    if source_id is not None and rename_remote_titles:
        remote_title = _remote_source_title(path)
        await _rename_source(
            client,
            notebook_id=notebook_id,
            source_id=source_id,
            remote_title=remote_title,
            reporter=reporter,
        )
    if run_state is not None:
        await run_state.record_source_uploaded(
            file_name=path.name,
            content_hash=content_hash,
            source_id=source_id,
            remote_title=remote_title,
        )
    return UploadResult(
        file_path=str(path),
        source_id=source_id,
        remote_title=remote_title,
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
    studio_locks: dict[str, asyncio.Lock] | None,
    studio_semaphores: dict[str, asyncio.Semaphore] | None,
    run_state: RunStateStore | None,
    studio_wait_timeout_seconds: float,
    studio_create_retries: int,
    studio_create_backoff_seconds: float,
    create_quota_cooldown: CreateQuotaCooldown,
    rename_remote_titles: bool,
    download_outputs: bool,
    reporter: Callable[[str], None] | None,
    announce_queue: bool = True,
) -> list[StudioResult]:
    jobs: list[tuple[str, StudioConfig, list[str] | None, str | None, str | None]] = []
    for studio_name, studio_config in studios.enabled_items():
        if studio_config.per_chunk:
            if not uploaded_sources:
                raise UploadError(
                    f"`studios.{studio_name}.per_chunk` requires chunk uploads from the same `nblm run` execution."
                )

            for uploaded in uploaded_sources:
                if uploaded.source_id is None:
                    continue
                jobs.append(
                    (
                        studio_name,
                        studio_config,
                        [uploaded.source_id],
                        Path(uploaded.file_path).name,
                        uploaded.remote_title,
                    )
                )
            continue

        jobs.append((studio_name, studio_config, source_ids, None, None))

    results: list[StudioResult] = []
    total_jobs = len(jobs)
    blocked_studios: dict[str, str] = {}
    if total_jobs and announce_queue:
        _emit(reporter, f"studio: {total_jobs} generation job(s) queued")
    for index, (studio_name, studio_config, job_source_ids, source_file, source_remote_title) in enumerate(jobs, start=1):
        if studio_name in blocked_studios:
            continue
        try:
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
                    source_remote_title=source_remote_title,
                    studio_locks=studio_locks,
                    studio_semaphores=studio_semaphores,
                    run_state=run_state,
                    studio_wait_timeout_seconds=studio_wait_timeout_seconds,
                    studio_create_retries=studio_create_retries,
                    studio_create_backoff_seconds=studio_create_backoff_seconds,
                    create_quota_cooldown=create_quota_cooldown,
                    rename_remote_titles=rename_remote_titles,
                    download_outputs=download_outputs,
                    studio_quota_blocks=blocked_studios,
                    reporter=reporter,
                    job_index=index,
                    job_total=total_jobs,
                )
            )
        except QuotaExceededError as exc:
            if studio_name not in blocked_studios:
                blocked_studios[studio_name] = exc.blocked_until
                _emit(
                    reporter,
                    f"studio: suspending remaining {studio_name.replace('_', '-')} jobs until {exc.blocked_until}",
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
    source_remote_title: str | None,
    studio_locks: dict[str, asyncio.Lock] | None,
    studio_semaphores: dict[str, asyncio.Semaphore] | None,
    run_state: RunStateStore | None,
    studio_wait_timeout_seconds: float,
    studio_create_retries: int,
    studio_create_backoff_seconds: float,
    create_quota_cooldown: CreateQuotaCooldown,
    rename_remote_titles: bool,
    download_outputs: bool,
    studio_quota_blocks: dict[str, str] | None,
    reporter: Callable[[str], None] | None,
    job_index: int,
    job_total: int,
) -> StudioResult:
    semaphore = (studio_semaphores or {}).get(studio_name)
    create_semaphore = semaphore if studio_name in _BACKGROUND_STUDIO_NAMES else None
    if create_semaphore is not None:
        semaphore = None
    lock = None
    if rename_remote_titles and source_file is not None and _supports_remote_artifact_rename(studio_name):
        lock = (studio_locks or {}).get(studio_name)
    if semaphore is not None and lock is not None:
        async with semaphore:
            async with lock:
                return await _run_single_studio_locked(
                    client,
                    rpc_module,
                    notebook_id=notebook_id,
                    studio_name=studio_name,
                    studio_config=studio_config,
                    studio_output_dir=studio_output_dir,
                    source_ids=source_ids,
                    source_file=source_file,
                    source_remote_title=source_remote_title,
                    studio_wait_timeout_seconds=studio_wait_timeout_seconds,
                    studio_create_retries=studio_create_retries,
                    studio_create_backoff_seconds=studio_create_backoff_seconds,
                    rename_remote_titles=rename_remote_titles,
                    run_state=run_state,
                    create_semaphore=create_semaphore,
                    create_quota_cooldown=create_quota_cooldown,
                    download_outputs=download_outputs,
                    studio_quota_blocks=studio_quota_blocks,
                    reporter=reporter,
                    job_index=job_index,
                    job_total=job_total,
                )
    if semaphore is not None:
        async with semaphore:
            return await _run_single_studio_locked(
                client,
                rpc_module,
                notebook_id=notebook_id,
                studio_name=studio_name,
                studio_config=studio_config,
                studio_output_dir=studio_output_dir,
                source_ids=source_ids,
                source_file=source_file,
                source_remote_title=source_remote_title,
                studio_wait_timeout_seconds=studio_wait_timeout_seconds,
                studio_create_retries=studio_create_retries,
                studio_create_backoff_seconds=studio_create_backoff_seconds,
                rename_remote_titles=rename_remote_titles,
                run_state=run_state,
                create_semaphore=create_semaphore,
                create_quota_cooldown=create_quota_cooldown,
                download_outputs=download_outputs,
                studio_quota_blocks=studio_quota_blocks,
                reporter=reporter,
                job_index=job_index,
                job_total=job_total,
            )
    if lock is not None:
        async with lock:
            return await _run_single_studio_locked(
                client,
                rpc_module,
                notebook_id=notebook_id,
                studio_name=studio_name,
                studio_config=studio_config,
                studio_output_dir=studio_output_dir,
                source_ids=source_ids,
                source_file=source_file,
                source_remote_title=source_remote_title,
                studio_wait_timeout_seconds=studio_wait_timeout_seconds,
                studio_create_retries=studio_create_retries,
                studio_create_backoff_seconds=studio_create_backoff_seconds,
                rename_remote_titles=rename_remote_titles,
                run_state=run_state,
                create_semaphore=create_semaphore,
                create_quota_cooldown=create_quota_cooldown,
                download_outputs=download_outputs,
                studio_quota_blocks=studio_quota_blocks,
                reporter=reporter,
                job_index=job_index,
                job_total=job_total,
            )
    return await _run_single_studio_locked(
        client,
        rpc_module,
        notebook_id=notebook_id,
        studio_name=studio_name,
        studio_config=studio_config,
        studio_output_dir=studio_output_dir,
        source_ids=source_ids,
        source_file=source_file,
        source_remote_title=source_remote_title,
        studio_wait_timeout_seconds=studio_wait_timeout_seconds,
        studio_create_retries=studio_create_retries,
        studio_create_backoff_seconds=studio_create_backoff_seconds,
        rename_remote_titles=rename_remote_titles,
        run_state=run_state,
        create_semaphore=create_semaphore,
        create_quota_cooldown=create_quota_cooldown,
        download_outputs=download_outputs,
        studio_quota_blocks=studio_quota_blocks,
        reporter=reporter,
        job_index=job_index,
        job_total=job_total,
    )


async def _run_single_studio_locked(
    client: Any,
    rpc_module: Any,
    *,
    notebook_id: str,
    studio_name: str,
    studio_config: StudioConfig,
    studio_output_dir: Path | None,
    source_ids: list[str] | None,
    source_file: str | None,
    source_remote_title: str | None,
    studio_wait_timeout_seconds: float,
    studio_create_retries: int,
    studio_create_backoff_seconds: float,
    rename_remote_titles: bool,
    run_state: RunStateStore | None,
    create_semaphore: asyncio.Semaphore | None,
    create_quota_cooldown: CreateQuotaCooldown,
    download_outputs: bool,
    studio_quota_blocks: dict[str, str] | None,
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
    if download_outputs:
        output_path.parent.mkdir(parents=True, exist_ok=True)
    studio_attempt_label = _studio_label(studio_name, source_file)
    resumed = _resume_completed_studio(
        run_state,
        studio_name=studio_name,
        source_file=source_file,
    )
    if resumed is not None:
        _emit(reporter, f"studio: resume {job_index}/{job_total} {studio_attempt_label} -> {output_path}")
        return resumed
    _emit(reporter, f"studio: start {job_index}/{job_total} {studio_attempt_label}")
    remote_title = None
    if rename_remote_titles:
        remote_title = _remote_artifact_title(studio_name, source_file, source_remote_title=source_remote_title)
    known_artifact_ids: set[str] | None = None
    if remote_title is not None:
        known_artifact_ids = await _list_artifact_ids_for_studio(client, notebook_id, studio_name)

    if studio_name == "audio":
        async def create_audio() -> Any:
            return await client.artifacts.generate_audio(
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

        async def download_audio(artifact_id: str | None, resolved_output_path: Path) -> str:
            return await client.artifacts.download_audio(
                notebook_id,
                str(resolved_output_path),
                artifact_id=artifact_id,
            )

        return await _run_artifact_studio_job(
            client,
            notebook_id=notebook_id,
            studio_name=studio_name,
            studio_attempt_label=studio_attempt_label,
            source_file=source_file,
            output_path=output_path,
            remote_title=remote_title,
            known_artifact_ids=known_artifact_ids,
            run_state=run_state,
            create_semaphore=create_semaphore,
            create_quota_cooldown=create_quota_cooldown,
            studio_wait_timeout_seconds=studio_wait_timeout_seconds,
            studio_create_retries=studio_create_retries,
            studio_create_backoff_seconds=studio_create_backoff_seconds,
            reporter=reporter,
            job_index=job_index,
            job_total=job_total,
            wait_label="audio",
            create_operation=create_audio,
            download_operation=download_audio,
            download_outputs=download_outputs,
            studio_quota_blocks=studio_quota_blocks,
        )

    if studio_name == "video":
        async def create_video() -> Any:
            return await client.artifacts.generate_video(
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

        async def download_video(artifact_id: str | None, resolved_output_path: Path) -> str:
            return await client.artifacts.download_video(
                notebook_id,
                str(resolved_output_path),
                artifact_id=artifact_id,
            )

        return await _run_artifact_studio_job(
            client,
            notebook_id=notebook_id,
            studio_name=studio_name,
            studio_attempt_label=studio_attempt_label,
            source_file=source_file,
            output_path=output_path,
            remote_title=remote_title,
            known_artifact_ids=known_artifact_ids,
            run_state=run_state,
            create_semaphore=create_semaphore,
            create_quota_cooldown=create_quota_cooldown,
            studio_wait_timeout_seconds=studio_wait_timeout_seconds,
            studio_create_retries=studio_create_retries,
            studio_create_backoff_seconds=studio_create_backoff_seconds,
            reporter=reporter,
            job_index=job_index,
            job_total=job_total,
            wait_label="video",
            create_operation=create_video,
            download_operation=download_video,
            download_outputs=download_outputs,
            studio_quota_blocks=studio_quota_blocks,
        )

    if studio_name == "report":
        report_format = _enum_value(
            rpc_module,
            "ReportFormat",
            _REPORT_FORMAT_TO_MEMBER,
            studio_config.format or "study-guide",
        )
        async def create_report() -> Any:
            return await client.artifacts.generate_report(
                notebook_id,
                source_ids=source_ids,
                language=studio_config.language or "en",
                report_format=report_format,
                custom_prompt=studio_config.prompt if (studio_config.format or "study-guide") == "custom" else None,
                extra_instructions=studio_config.prompt if (studio_config.format or "study-guide") != "custom" else None,
            )

        async def download_report(artifact_id: str | None, resolved_output_path: Path) -> str:
            return await client.artifacts.download_report(
                notebook_id,
                str(resolved_output_path),
                artifact_id=artifact_id,
            )

        return await _run_artifact_studio_job(
            client,
            notebook_id=notebook_id,
            studio_name=studio_name,
            studio_attempt_label=studio_attempt_label,
            source_file=source_file,
            output_path=output_path,
            remote_title=remote_title,
            known_artifact_ids=known_artifact_ids,
            run_state=run_state,
            create_semaphore=create_semaphore,
            create_quota_cooldown=create_quota_cooldown,
            studio_wait_timeout_seconds=studio_wait_timeout_seconds,
            studio_create_retries=studio_create_retries,
            studio_create_backoff_seconds=studio_create_backoff_seconds,
            reporter=reporter,
            job_index=job_index,
            job_total=job_total,
            wait_label="report",
            create_operation=create_report,
            download_operation=download_report,
            download_outputs=download_outputs,
            studio_quota_blocks=studio_quota_blocks,
        )

    if studio_name == "slide_deck":
        async def create_slide_deck() -> Any:
            return await client.artifacts.generate_slide_deck(
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

        download_format = studio_config.download_format or "pdf"

        async def download_slide_deck(artifact_id: str | None, resolved_output_path: Path) -> str:
            return await client.artifacts.download_slide_deck(
                notebook_id,
                str(resolved_output_path),
                artifact_id=artifact_id,
                output_format=download_format,
            )

        return await _run_artifact_studio_job(
            client,
            notebook_id=notebook_id,
            studio_name=studio_name,
            studio_attempt_label=studio_attempt_label,
            source_file=source_file,
            output_path=output_path,
            remote_title=remote_title,
            known_artifact_ids=known_artifact_ids,
            run_state=run_state,
            create_semaphore=create_semaphore,
            create_quota_cooldown=create_quota_cooldown,
            studio_wait_timeout_seconds=studio_wait_timeout_seconds,
            studio_create_retries=studio_create_retries,
            studio_create_backoff_seconds=studio_create_backoff_seconds,
            reporter=reporter,
            job_index=job_index,
            job_total=job_total,
            wait_label="slide deck",
            create_operation=create_slide_deck,
            download_operation=download_slide_deck,
            download_outputs=download_outputs,
            studio_quota_blocks=studio_quota_blocks,
        )

    if studio_name == "quiz":
        async def create_quiz() -> Any:
            return await client.artifacts.generate_quiz(
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

        async def download_quiz(artifact_id: str | None, resolved_output_path: Path) -> str:
            return await client.artifacts.download_quiz(
                notebook_id,
                str(resolved_output_path),
                artifact_id=artifact_id,
                output_format=studio_config.download_format or "json",
            )

        return await _run_artifact_studio_job(
            client,
            notebook_id=notebook_id,
            studio_name=studio_name,
            studio_attempt_label=studio_attempt_label,
            source_file=source_file,
            output_path=output_path,
            remote_title=remote_title,
            known_artifact_ids=known_artifact_ids,
            run_state=run_state,
            create_semaphore=create_semaphore,
            create_quota_cooldown=create_quota_cooldown,
            studio_wait_timeout_seconds=studio_wait_timeout_seconds,
            studio_create_retries=studio_create_retries,
            studio_create_backoff_seconds=studio_create_backoff_seconds,
            reporter=reporter,
            job_index=job_index,
            job_total=job_total,
            wait_label="quiz",
            create_operation=create_quiz,
            download_operation=download_quiz,
            download_outputs=download_outputs,
            studio_quota_blocks=studio_quota_blocks,
        )

    if studio_name == "flashcards":
        async def create_flashcards() -> Any:
            return await client.artifacts.generate_flashcards(
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

        async def download_flashcards(artifact_id: str | None, resolved_output_path: Path) -> str:
            return await client.artifacts.download_flashcards(
                notebook_id,
                str(resolved_output_path),
                artifact_id=artifact_id,
                output_format=studio_config.download_format or "markdown",
            )

        return await _run_artifact_studio_job(
            client,
            notebook_id=notebook_id,
            studio_name=studio_name,
            studio_attempt_label=studio_attempt_label,
            source_file=source_file,
            output_path=output_path,
            remote_title=remote_title,
            known_artifact_ids=known_artifact_ids,
            run_state=run_state,
            create_semaphore=create_semaphore,
            create_quota_cooldown=create_quota_cooldown,
            studio_wait_timeout_seconds=studio_wait_timeout_seconds,
            studio_create_retries=studio_create_retries,
            studio_create_backoff_seconds=studio_create_backoff_seconds,
            reporter=reporter,
            job_index=job_index,
            job_total=job_total,
            wait_label="flashcards",
            create_operation=create_flashcards,
            download_operation=download_flashcards,
            download_outputs=download_outputs,
            studio_quota_blocks=studio_quota_blocks,
        )

    if studio_name == "infographic":
        async def create_infographic() -> Any:
            return await client.artifacts.generate_infographic(
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

        async def download_infographic(artifact_id: str | None, resolved_output_path: Path) -> str:
            return await client.artifacts.download_infographic(
                notebook_id,
                str(resolved_output_path),
                artifact_id=artifact_id,
            )

        return await _run_artifact_studio_job(
            client,
            notebook_id=notebook_id,
            studio_name=studio_name,
            studio_attempt_label=studio_attempt_label,
            source_file=source_file,
            output_path=output_path,
            remote_title=remote_title,
            known_artifact_ids=known_artifact_ids,
            run_state=run_state,
            create_semaphore=create_semaphore,
            create_quota_cooldown=create_quota_cooldown,
            studio_wait_timeout_seconds=studio_wait_timeout_seconds,
            studio_create_retries=studio_create_retries,
            studio_create_backoff_seconds=studio_create_backoff_seconds,
            reporter=reporter,
            job_index=job_index,
            job_total=job_total,
            wait_label="infographic",
            create_operation=create_infographic,
            download_operation=download_infographic,
            download_outputs=download_outputs,
            studio_quota_blocks=studio_quota_blocks,
        )

    if studio_name == "data_table":
        async def create_data_table() -> Any:
            return await client.artifacts.generate_data_table(
                notebook_id,
                source_ids=source_ids,
                language=studio_config.language or "en",
                instructions=studio_config.prompt or _DEFAULT_DATA_TABLE_PROMPT,
            )

        async def download_data_table(artifact_id: str | None, resolved_output_path: Path) -> str:
            return await client.artifacts.download_data_table(
                notebook_id,
                str(resolved_output_path),
                artifact_id=artifact_id,
            )

        return await _run_artifact_studio_job(
            client,
            notebook_id=notebook_id,
            studio_name=studio_name,
            studio_attempt_label=studio_attempt_label,
            source_file=source_file,
            output_path=output_path,
            remote_title=remote_title,
            known_artifact_ids=known_artifact_ids,
            run_state=run_state,
            create_semaphore=create_semaphore,
            create_quota_cooldown=create_quota_cooldown,
            studio_wait_timeout_seconds=studio_wait_timeout_seconds,
            studio_create_retries=studio_create_retries,
            studio_create_backoff_seconds=studio_create_backoff_seconds,
            reporter=reporter,
            job_index=job_index,
            job_total=job_total,
            wait_label="data table",
            create_operation=create_data_table,
            download_operation=download_data_table,
            download_outputs=download_outputs,
            studio_quota_blocks=studio_quota_blocks,
        )

    if studio_name == "mind_map":
        result = await client.artifacts.generate_mind_map(
            notebook_id,
            source_ids=source_ids,
        )
        note_id = result.get("note_id") if isinstance(result, dict) else None
        downloaded: str | None = None
        if download_outputs:
            downloaded = await client.artifacts.download_mind_map(
                notebook_id,
                str(output_path),
                artifact_id=note_id,
            )
        await _record_completed_studio(
            run_state,
            studio_name=studio_name,
            source_file=source_file,
            artifact_id=note_id,
            output_path=downloaded,
            remote_title=None,
        )
        destination = downloaded or "remote artifact only"
        _emit(reporter, f"studio: done  {job_index}/{job_total} {_studio_label(studio_name, source_file)} -> {destination}")
        return StudioResult("mind_map", note_id, downloaded, source_file=source_file, remote_title=None)

    raise UploadError(f"Unsupported studio type: {studio_name}")


async def _run_artifact_studio_job(
    client: Any,
    *,
    notebook_id: str,
    studio_name: str,
    studio_attempt_label: str,
    source_file: str | None,
    output_path: Path,
    remote_title: str | None,
    known_artifact_ids: set[str] | None,
    run_state: RunStateStore | None,
    create_semaphore: asyncio.Semaphore | None,
    create_quota_cooldown: CreateQuotaCooldown,
    studio_wait_timeout_seconds: float,
    studio_create_retries: int,
    studio_create_backoff_seconds: float,
    studio_quota_blocks: dict[str, str] | None,
    reporter: Callable[[str], None] | None,
    job_index: int,
    job_total: int,
    wait_label: str,
    create_operation: Callable[[], Awaitable[Any]],
    download_operation: Callable[[str | None, Path], Awaitable[str]],
    download_outputs: bool,
) -> StudioResult:
    pending_state = _resume_pending_studio_state(
        run_state,
        studio_name=studio_name,
        source_file=source_file,
    )
    pending_task_id = _dict_optional_str(pending_state.get("task_id")) if pending_state is not None else None

    if pending_task_id:
        _emit(reporter, f"studio: continue {job_index}/{job_total} {studio_attempt_label}")
        status = PendingTaskStatus(pending_task_id)
    else:
        try:
            status = await _create_artifact_with_retry(
                studio_label=studio_attempt_label,
                create_operation=_limit_create_operation(create_operation, create_semaphore=create_semaphore),
                studio_name=studio_name,
                retry_count=studio_create_retries,
                backoff_seconds=studio_create_backoff_seconds,
                quota_cooldown=create_quota_cooldown,
                studio_quota_blocks=studio_quota_blocks,
                reporter=reporter,
            )
        except QuotaExceededError as exc:
            if run_state is not None:
                await _record_pending_studio(
                    run_state,
                    studio_name=studio_name,
                    source_file=source_file,
                    task_id=None,
                    output_path=str(output_path) if download_outputs else None,
                    remote_title=remote_title,
                    error=str(exc),
                    status="quota_blocked",
                    next_retry_at=exc.blocked_until,
                )
                await run_state.record_quota_block(
                    blocked_until=exc.blocked_until,
                    error=str(exc),
                    studio_name=studio_name,
                    source_file=source_file,
                )
            _emit(reporter, f"studio: quota exhausted {studio_attempt_label} -> {exc.blocked_until}")
            raise
        except UploadError as exc:
            if run_state is None:
                raise
            await _record_pending_studio(
                run_state,
                studio_name=studio_name,
                source_file=source_file,
                task_id=None,
                output_path=str(output_path) if download_outputs else None,
                remote_title=remote_title,
                error=str(exc),
                status="create_failed",
            )
            _emit(reporter, f"studio: pending {job_index}/{job_total} {studio_attempt_label} -> {run_state.path.name}")
            return _pending_studio_result(
                studio_name=studio_name,
                source_file=source_file,
                remote_title=remote_title,
                output_path=output_path if download_outputs else None,
            )
        await _record_pending_studio(
            run_state,
            studio_name=studio_name,
            source_file=source_file,
            task_id=_read_attr(status, "task_id"),
            output_path=str(output_path) if download_outputs else None,
            remote_title=remote_title,
            error=None,
            status="pending",
        )

    try:
        status = await _wait_for_completion(client, notebook_id, status, wait_label, studio_wait_timeout_seconds)
    except QuotaExceededError as exc:
        if run_state is None:
            raise
        await _record_pending_studio(
            run_state,
            studio_name=studio_name,
            source_file=source_file,
            task_id=_read_attr(status, "task_id"),
            output_path=str(output_path) if download_outputs else None,
            remote_title=remote_title,
            error=str(exc),
            status="quota_blocked",
            next_retry_at=exc.blocked_until,
        )
        await run_state.record_quota_block(
            blocked_until=exc.blocked_until,
            error=str(exc),
            studio_name=studio_name,
            source_file=source_file,
        )
        _emit(reporter, f"studio: quota exhausted {studio_attempt_label} -> {exc.blocked_until}")
        raise
    except Exception as exc:
        if run_state is None:
            raise
        await _record_pending_studio(
            run_state,
            studio_name=studio_name,
            source_file=source_file,
            task_id=_read_attr(status, "task_id"),
            output_path=str(output_path) if download_outputs else None,
            remote_title=remote_title,
            error=str(exc),
            status="pending",
        )
        _emit(reporter, f"studio: pending {job_index}/{job_total} {studio_attempt_label} -> {run_state.path.name}")
        return _pending_studio_result(
            studio_name=studio_name,
            source_file=source_file,
            remote_title=remote_title,
            output_path=output_path if download_outputs else None,
        )

    artifact_id = await _resolve_artifact_id(
        client,
        notebook_id=notebook_id,
        studio_name=studio_name,
        fallback_id=_read_attr(status, "task_id"),
        known_artifact_ids=known_artifact_ids,
    )
    await _maybe_rename_artifact(
        client,
        notebook_id=notebook_id,
        artifact_id=artifact_id,
        remote_title=remote_title,
        reporter=reporter,
    )
    downloaded: str | None = None
    if download_outputs:
        downloaded = await download_operation(artifact_id, output_path)
    await _record_completed_studio(
        run_state,
        studio_name=studio_name,
        source_file=source_file,
        artifact_id=artifact_id,
        output_path=downloaded,
        remote_title=remote_title,
    )
    destination = downloaded or "remote artifact only"
    _emit(reporter, f"studio: done  {job_index}/{job_total} {_studio_label(studio_name, source_file)} -> {destination}")
    return StudioResult(studio_name, artifact_id, downloaded, source_file=source_file, remote_title=remote_title)


def _limit_create_operation(
    create_operation: Callable[[], Awaitable[Any]],
    *,
    create_semaphore: asyncio.Semaphore | None,
) -> Callable[[], Awaitable[Any]]:
    async def run_with_limit() -> Any:
        if create_semaphore is None:
            return await create_operation()
        async with create_semaphore:
            return await create_operation()

    return run_with_limit


async def _wait_for_completion(
    client: Any,
    notebook_id: str,
    status: Any,
    studio_label: str,
    wait_timeout_seconds: float,
) -> Any:
    task_id = _read_attr(status, "task_id")
    if not task_id:
        error = _read_attr(status, "error")
        state = _read_attr(status, "status")
        details: list[str] = []
        if state:
            details.append(f"status={state}")
        if error:
            details.append(f"error={error}")
        suffix = f" ({', '.join(details)})" if details else ""
        raise UploadError(
            f"NotebookLM did not return a task ID for {studio_label}.{suffix} "
            "This happened before the local completion wait started."
        )

    final_status = await client.artifacts.wait_for_completion(
        notebook_id,
        task_id,
        timeout=wait_timeout_seconds,
    )
    if getattr(final_status, "is_failed", False):
        error = _read_attr(final_status, "error") or f"{studio_label} generation failed."
        if _looks_like_quota_exhausted_message(error):
            blocked_until = _quota_blocked_until()
            raise QuotaExceededError(
                f"{error} Daily NotebookLM quota appears exhausted. Try `nblm resume` again after {blocked_until}.",
                blocked_until=blocked_until,
            )
        raise UploadError(str(error))
    return final_status


async def _create_artifact_with_retry(
    *,
    studio_label: str,
    create_operation: Callable[[], Awaitable[Any]],
    studio_name: str,
    retry_count: int,
    backoff_seconds: float,
    quota_cooldown: CreateQuotaCooldown | None,
    studio_quota_blocks: dict[str, str] | None,
    reporter: Callable[[str], None] | None,
) -> Any:
    max_attempts = retry_count + 1
    last_error: str | None = None

    for attempt in range(1, max_attempts + 1):
        if studio_quota_blocks is not None and studio_name in studio_quota_blocks:
            blocked_until = studio_quota_blocks[studio_name]
            raise QuotaExceededError(
                f"{studio_label} create skipped because {studio_name.replace('_', '-')} quota is already blocked. "
                f"Try `nblm resume` again after {blocked_until}.",
                blocked_until=blocked_until,
            )
        if quota_cooldown is not None:
            waited = await quota_cooldown.wait_if_needed()
            if waited > 0:
                _emit(
                    reporter,
                    f"studio: quota cooldown delayed {studio_label} create by {waited:.1f}s",
                )
        quota_exhausted = False
        try:
            status = await create_operation()
        except Exception as exc:
            last_error = f"{studio_label} create failed before a task ID was returned: {_describe_exception(exc)}"
            rate_limited = _is_rate_limited_error(exc)
            quota_exhausted = _is_quota_exhausted_error(exc)
        else:
            task_id = _read_attr(status, "task_id")
            if task_id:
                if attempt > 1:
                    _emit(reporter, f"studio: recovered {studio_label} create on attempt {attempt}/{max_attempts}")
                return status
            last_error = _describe_create_failure(studio_label, status)
            rate_limited = _is_rate_limited_status(status)
            quota_exhausted = _is_quota_exhausted_status(status)

        if quota_exhausted:
            blocked_until = _quota_blocked_until()
            if studio_quota_blocks is not None:
                studio_quota_blocks[studio_name] = blocked_until
            raise QuotaExceededError(
                f"{last_error} Daily NotebookLM quota appears exhausted. Try `nblm resume` again after {blocked_until}.",
                blocked_until=blocked_until,
            )

        _emit(reporter, f"studio: create failure {studio_label} attempt {attempt}/{max_attempts}: {last_error}")

        if attempt == max_attempts:
            break

        delay = backoff_seconds * (2 ** (attempt - 1))
        if rate_limited and quota_cooldown is not None:
            shared_delay = await quota_cooldown.extend(delay)
            _emit(
                reporter,
                f"studio: quota cooldown triggered by {studio_label}; holding Studio create requests for {shared_delay:.1f}s",
            )
        _emit(
            reporter,
            f"studio: retry {attempt}/{retry_count} {studio_label} create after failure; waiting {delay:.1f}s",
        )
        await asyncio.sleep(delay)
        _emit(
            reporter,
            f"studio: retry {attempt + 1}/{max_attempts} {studio_label} create starting now",
        )

    raise UploadError(last_error or f"{studio_label} create failed before a task ID was returned.")


def _describe_create_failure(studio_label: str, status: Any) -> str:
    error = _read_attr(status, "error")
    state = _read_attr(status, "status")
    details: list[str] = []
    if state:
        details.append(f"status={state}")
    if error:
        details.append(f"error={error}")
    suffix = f" ({', '.join(details)})" if details else ""
    return f"{studio_label} create failed before a task ID was returned.{suffix}"


def _describe_exception(exc: Exception) -> str:
    message = str(exc).strip()
    if message:
        return message
    return exc.__class__.__name__


def _is_rate_limited_error(exc: Exception) -> bool:
    retry_after = getattr(exc, "retry_after", None)
    if retry_after is not None:
        return True
    return _looks_like_rate_limit_message(_describe_exception(exc))


def _is_rate_limited_status(status: Any) -> bool:
    error = _read_attr(status, "error")
    return _looks_like_rate_limit_message(error)


def _is_quota_exhausted_error(exc: Exception) -> bool:
    return _looks_like_quota_exhausted_message(_describe_exception(exc))


def _is_quota_exhausted_status(status: Any) -> bool:
    error = _read_attr(status, "error")
    return _looks_like_quota_exhausted_message(error)


def _looks_like_rate_limit_message(message: str | None) -> bool:
    if message is None:
        return False
    normalized = message.lower()
    return "rate limit" in normalized or "quota exceeded" in normalized or "too many requests" in normalized


def _looks_like_quota_exhausted_message(message: str | None) -> bool:
    if message is None:
        return False
    normalized = message.lower()
    return "quota exceeded" in normalized or "daily quota" in normalized


def _quota_blocked_until() -> str:
    return (datetime.now(UTC) + timedelta(hours=24)).isoformat().replace("+00:00", "Z")


def _raise_for_relevant_quota_blocks(run_state: RunStateStore, *, studios: StudiosConfig) -> None:
    active_blocks = run_state.quota_blocks(
        studio_names=[studio_name for studio_name, _ in studios.enabled_items()]
    )
    if not active_blocks:
        return

    summaries = [
        f"{studio_name.replace('_', '-')} until {block['blocked_until']}"
        for studio_name, block in sorted(active_blocks.items())
        if block.get("blocked_until")
    ]
    if not summaries:
        return
    latest_block = max(
        (
            block["blocked_until"]
            for block in active_blocks.values()
            if isinstance(block.get("blocked_until"), str)
        ),
        default=None,
    )
    retry_hint = (
        f" Try `nblm resume` again after {latest_block}."
        if latest_block is not None
        else ""
    )
    raise UploadError(
        "Daily NotebookLM quota appears exhausted for: "
        + ", ".join(summaries)
        + ". Completed work was saved to the run state."
        + retry_hint
    )


def _describe_missing_notebook(
    notebook_id: str,
    *,
    resume_state_path: Path | None,
    details: str | None = None,
) -> str:
    parts = [f'Notebook "{notebook_id}" is not available in the current NotebookLM session.']
    if details:
        parts.append(f"Details: {details}.")
    parts.append("It may have been deleted, moved, or your current auth session may no longer have access.")
    if resume_state_path is not None:
        parts.append(f"Delete {resume_state_path.name} to start a fresh run.")
    return " ".join(parts)


def _describe_notebook_verification_failure(
    notebook_id: str,
    *,
    exc: Exception,
    resume_state_path: Path | None,
) -> str:
    return _describe_missing_notebook(
        notebook_id,
        resume_state_path=resume_state_path,
        details=_describe_exception(exc),
    )


async def _rename_source(
    client: Any,
    *,
    notebook_id: str,
    source_id: str,
    remote_title: str,
    reporter: Callable[[str], None] | None,
) -> None:
    rename_method = getattr(client.sources, "rename", None)
    if rename_method is None:
        raise UploadError("notebooklm-py does not expose `client.sources.rename` in this version.")
    await rename_method(notebook_id, source_id, remote_title)
    _emit(reporter, f'source: renamed {source_id} -> "{remote_title}"')


async def _maybe_rename_artifact(
    client: Any,
    *,
    notebook_id: str,
    artifact_id: str | None,
    remote_title: str | None,
    reporter: Callable[[str], None] | None,
) -> None:
    if artifact_id is None or remote_title is None:
        return
    rename_method = getattr(client.artifacts, "rename", None)
    if rename_method is None:
        raise UploadError("notebooklm-py does not expose `client.artifacts.rename` in this version.")
    await rename_method(notebook_id, artifact_id, remote_title)
    _emit(reporter, f'studio: renamed {artifact_id} -> "{remote_title}"')


async def _list_artifact_ids_for_studio(
    client: Any,
    notebook_id: str,
    studio_name: str,
) -> set[str]:
    if not _supports_remote_artifact_rename(studio_name):
        return set()
    list_method = getattr(client.artifacts, "list", None)
    if list_method is None:
        raise UploadError("notebooklm-py does not expose `client.artifacts.list` in this version.")

    artifacts = await list_method(notebook_id)
    ids: set[str] = set()
    for artifact in artifacts or []:
        artifact_id = _read_attr(artifact, "id")
        if artifact_id is None:
            continue
        if _artifact_kind_matches_studio(_read_attr(artifact, "kind"), studio_name):
            ids.add(artifact_id)
    return ids


async def _resolve_artifact_id(
    client: Any,
    *,
    notebook_id: str,
    studio_name: str,
    fallback_id: str | None,
    known_artifact_ids: set[str] | None,
) -> str | None:
    if known_artifact_ids is None:
        return fallback_id

    list_method = getattr(client.artifacts, "list", None)
    if list_method is None:
        raise UploadError("notebooklm-py does not expose `client.artifacts.list` in this version.")

    for _attempt in range(10):
        artifacts = await list_method(notebook_id)
        new_ids = [
            _read_attr(artifact, "id")
            for artifact in (artifacts or [])
            if _read_attr(artifact, "id") is not None
            and _artifact_kind_matches_studio(_read_attr(artifact, "kind"), studio_name)
            and _read_attr(artifact, "id") not in known_artifact_ids
        ]
        if len(new_ids) == 1:
            return new_ids[0]
        if len(new_ids) > 1:
            raise UploadError(
                f"Could not safely resolve the generated {studio_name.replace('_', '-')} artifact ID. "
                "Multiple new artifacts appeared in the same notebook. Avoid running the same Studio type "
                "concurrently from outside this `nblm run`."
            )
        await asyncio.sleep(0.5)

    raise UploadError(
        f"Could not resolve the generated {studio_name.replace('_', '-')} artifact ID after completion."
    )


def _resolve_state_notebook_id(
    run_state: RunStateStore,
    *,
    requested_notebook_id: str | None,
    reporter: Callable[[str], None] | None,
    mode_label: str,
) -> str | None:
    resumed_notebook_id = run_state.notebook_id
    if resumed_notebook_id is None:
        return requested_notebook_id
    if requested_notebook_id is not None and requested_notebook_id != resumed_notebook_id:
        raise UploadError(
            f"Saved state in {run_state.path.name} points to a different notebook ID. "
            f"Reuse notebook {resumed_notebook_id}, or replace that state file if you want to target another notebook."
        )
    _emit(reporter, f"{mode_label}: using notebook {resumed_notebook_id} from {run_state.path.name}")
    return resumed_notebook_id


def _resolve_resume_notebook_id(
    run_state: RunStateStore,
    *,
    requested_notebook_id: str | None,
    reporter: Callable[[str], None] | None,
) -> str | None:
    return _resolve_state_notebook_id(
        run_state,
        requested_notebook_id=requested_notebook_id,
        reporter=reporter,
        mode_label="resume",
    )


def _open_run_state(path: Path, *, resume: bool) -> RunStateStore:
    if resume:
        if not path.is_file():
            raise UploadError(
                f"No resume state found at {path}. Run `nblm run` first, then use `nblm resume` to continue."
            )
        return RunStateStore.load(path)
    return RunStateStore(path)


def _uploaded_sources_from_run_state(run_state: RunStateStore) -> list[UploadResult]:
    return [
        UploadResult(
            file_path=entry["file_name"],
            source_id=entry["source_id"],
            remote_title=entry["remote_title"],
        )
        for entry in run_state.uploaded_chunk_sources()
        if entry["source_id"] is not None
    ]


def _resume_completed_studio(
    run_state: RunStateStore | None,
    *,
    studio_name: str,
    source_file: str | None,
) -> StudioResult | None:
    if run_state is None:
        return None
    if source_file is not None:
        chunk_path = run_state.path.parent / source_file
        studio_entry = run_state.completed_chunk_studio(
            file_name=source_file,
            studio_name=studio_name,
            content_hash=chunk_content_hash(chunk_path),
        )
    else:
        studio_entry = run_state.completed_notebook_studio(studio_name=studio_name)
    if studio_entry is None:
        return None
    return StudioResult(
        studio=studio_name,
        artifact_id=_dict_optional_str(studio_entry.get("artifact_id")),
        output_path=_dict_optional_str(studio_entry.get("output_path")),
        source_file=source_file,
        remote_title=_dict_optional_str(studio_entry.get("remote_title")),
    )


def _resume_pending_studio_state(
    run_state: RunStateStore | None,
    *,
    studio_name: str,
    source_file: str | None,
) -> dict[str, Any] | None:
    if run_state is None:
        return None
    if source_file is not None:
        chunk_path = run_state.path.parent / source_file
        return run_state.pending_chunk_studio(
            file_name=source_file,
            studio_name=studio_name,
            content_hash=chunk_content_hash(chunk_path),
        )
    return run_state.pending_notebook_studio(studio_name=studio_name)


async def _record_pending_studio(
    run_state: RunStateStore | None,
    *,
    studio_name: str,
    source_file: str | None,
    task_id: str | None,
    output_path: str | None,
    remote_title: str | None,
    error: str | None,
    status: str = "pending",
    next_retry_at: str | None = None,
) -> None:
    if run_state is None:
        return
    if source_file is not None:
        chunk_path = run_state.path.parent / source_file
        await run_state.record_pending_chunk_studio(
            file_name=source_file,
            studio_name=studio_name,
            content_hash=chunk_content_hash(chunk_path),
            task_id=task_id,
            output_path=output_path,
            remote_title=remote_title,
            error=error,
            status=status,
            next_retry_at=next_retry_at,
        )
        return
    await run_state.record_pending_notebook_studio(
        studio_name=studio_name,
        task_id=task_id,
        output_path=output_path,
        remote_title=remote_title,
        error=error,
        status=status,
        next_retry_at=next_retry_at,
    )


def _pending_studio_result(
    *,
    studio_name: str,
    source_file: str | None,
    remote_title: str | None,
    output_path: Path | None,
) -> StudioResult:
    return StudioResult(
        studio=studio_name,
        artifact_id=None,
        output_path=str(output_path) if output_path is not None else None,
        source_file=source_file,
        remote_title=remote_title,
        status="pending",
    )


async def _record_completed_studio(
    run_state: RunStateStore | None,
    *,
    studio_name: str,
    source_file: str | None,
    artifact_id: str | None,
    output_path: str | None,
    remote_title: str | None,
) -> None:
    if run_state is None:
        return
    if source_file is not None:
        chunk_path = run_state.path.parent / source_file
        await run_state.record_completed_chunk_studio(
            file_name=source_file,
            studio_name=studio_name,
            content_hash=chunk_content_hash(chunk_path),
            artifact_id=artifact_id,
            output_path=output_path,
            remote_title=remote_title,
        )
        return
    await run_state.record_completed_notebook_studio(
        studio_name=studio_name,
        artifact_id=artifact_id,
        output_path=output_path,
        remote_title=remote_title,
    )


def _dict_optional_str(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        return str(value)
    return value


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


def _normalize_parallelism(value: int) -> int:
    if value < 1:
        raise UploadError("`max_parallel_chunks` must be greater than or equal to 1.")
    return value


def _normalize_wait_timeout(value: float) -> float:
    if value <= 0:
        raise UploadError("`studio_wait_timeout_seconds` must be greater than 0.")
    return value


def _normalize_create_retries(value: int) -> int:
    if value < 0:
        raise UploadError("`studio_create_retries` must be greater than or equal to 0.")
    return value


def _normalize_create_backoff(value: float) -> float:
    if value <= 0:
        raise UploadError("`studio_create_backoff_seconds` must be greater than 0.")
    return value


def _normalize_quota_cooldown(value: float) -> float:
    if value <= 0:
        raise UploadError("`studio_rate_limit_cooldown_seconds` must be greater than 0.")
    return value


def _build_remote_rename_locks(
    studios: StudiosConfig,
    *,
    rename_remote_titles: bool,
) -> dict[str, asyncio.Lock]:
    if not rename_remote_titles:
        return {}
    locks: dict[str, asyncio.Lock] = {}
    for studio_name, studio_config in studios.enabled_items():
        if studio_config.per_chunk and _supports_remote_artifact_rename(studio_name):
            locks[studio_name] = asyncio.Lock()
    return locks


def _build_studio_execution_semaphores(
    studios: StudiosConfig,
    *,
    max_parallel_heavy_studios: int,
) -> dict[str, asyncio.Semaphore]:
    semaphores: dict[str, asyncio.Semaphore] = {}
    if max_parallel_heavy_studios < 1:
        raise UploadError("`max_parallel_heavy_studios` must be greater than or equal to 1.")
    for studio_name, studio_config in studios.enabled_items():
        limit = _studio_parallel_limit(
            studio_name,
            studio_config,
            max_parallel_heavy_studios=max_parallel_heavy_studios,
        )
        if limit is not None:
            semaphores[studio_name] = asyncio.Semaphore(limit)
    return semaphores


def _studio_parallel_limit(
    studio_name: str,
    studio_config: StudioConfig,
    *,
    max_parallel_heavy_studios: int,
) -> int | None:
    if studio_config.max_parallel is not None:
        return studio_config.max_parallel
    if studio_name in _HEAVY_STUDIO_NAMES:
        return max_parallel_heavy_studios
    return None


def _per_chunk_studio_worker_count(
    studio_name: str,
    studio_config: StudioConfig,
    *,
    max_parallel_chunks: int,
    max_parallel_heavy_studios: int,
) -> int:
    limit = _studio_parallel_limit(
        studio_name,
        studio_config,
        max_parallel_heavy_studios=max_parallel_heavy_studios,
    )
    if limit is not None:
        return max(1, limit)
    return max(1, max_parallel_chunks)


def _build_per_chunk_job_indices(
    markdown_files: list[Path],
    per_chunk_items: list[tuple[str, StudioConfig]],
) -> dict[tuple[str, str], int]:
    indices: dict[tuple[str, str], int] = {}
    next_index = 1
    for path in markdown_files:
        for studio_name, _ in per_chunk_items:
            indices[(studio_name, path.name)] = next_index
            next_index += 1
    return indices


def _emit_heavy_studio_parallelism(
    studios: StudiosConfig,
    *,
    max_parallel_heavy_studios: int,
    reporter: Callable[[str], None] | None,
) -> None:
    for studio_name, studio_config in studios.enabled_items():
        if studio_name not in _HEAVY_STUDIO_NAMES and studio_config.max_parallel is None:
            continue
        limit = _studio_parallel_limit(
            studio_name,
            studio_config,
            max_parallel_heavy_studios=max_parallel_heavy_studios,
        )
        if limit is None:
            continue
        _emit(reporter, f"runtime: {_studio_label(studio_name, None)} jobs limited to {limit} in parallel")


def _has_heavy_studio_jobs(studios: StudiosConfig) -> bool:
    return any(studio_name in _HEAVY_STUDIO_NAMES for studio_name, _ in studios.enabled_items())


def _supports_remote_artifact_rename(studio_name: str) -> bool:
    return studio_name != "mind_map"


def _remote_source_title(path: Path) -> str:
    heading = _first_markdown_heading(path) or _humanize_path_stem(path.stem)
    chunk_prefix = _chunk_prefix(path.stem)
    if chunk_prefix:
        return f"{chunk_prefix} {heading}"
    return heading


def _remote_artifact_title(
    studio_name: str,
    source_file: str | None,
    *,
    source_remote_title: str | None,
) -> str | None:
    if source_file is None or not _supports_remote_artifact_rename(studio_name):
        return None
    source_title = source_remote_title or _remote_source_title(Path(source_file))
    return f"{source_title} - {_studio_display_name(studio_name)}"


def _artifact_kind_matches_studio(kind: str | None, studio_name: str) -> bool:
    if kind is None:
        return False
    normalized = kind.lower().replace("-", "_")
    return normalized == studio_name


def _first_markdown_heading(path: Path) -> str | None:
    try:
        headings: list[tuple[int, str]] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped.startswith("#"):
                continue
            level = len(stripped) - len(stripped.lstrip("#"))
            heading = _strip_heading_numbering(stripped.lstrip("#").strip())
            if heading:
                headings.append((level, heading))
    except OSError:
        return None

    for level, heading in headings:
        if level > 1:
            return heading
    if headings:
        return headings[0][1]
    return None


def _humanize_path_stem(stem: str) -> str:
    text = re.sub(r"[-_]+", " ", stem).strip()
    text = re.sub(r"^c\d+\s+", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^\d+\s+", "", text)
    return _strip_heading_numbering(re.sub(r"\s+", " ", text))


def _strip_heading_numbering(text: str) -> str:
    return re.sub(r"^\s*\d+(?:\.\d+)*\s+", "", text).strip()


def _chunk_prefix(stem: str) -> str | None:
    match = re.match(r"^(c\d+)-", stem, flags=re.IGNORECASE)
    if match:
        return match.group(1).upper()
    return None


def _studio_display_name(studio_name: str) -> str:
    return {
        "audio": "Audio Overview",
        "video": "Video Overview",
        "report": "Report",
        "slide_deck": "Slide Deck",
        "quiz": "Quiz",
        "flashcards": "Flashcards",
        "infographic": "Infographic",
        "data_table": "Data Table",
        "mind_map": "Mind Map",
    }[studio_name]


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
