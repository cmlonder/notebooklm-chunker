from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
import traceback
from collections.abc import AsyncIterable, Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, TypeVar

from notebooklm_chunker.models import ExportResult as UploadResult
from notebooklm_chunker.run_state import RunStateStore

T = TypeVar("T")

# CLI'nin beklediği sabitler
RUN_STATE_BASENAME = "run_state.json"
DEFAULT_STUDIO_WAIT_TIMEOUT_SECONDS = 7200.0
DEFAULT_STUDIO_RATE_LIMIT_COOLDOWN_SECONDS = 30.0

@dataclass(frozen=True)
class StudioResult:
    name: str
    status: str
    output_path: str | None = None

@dataclass(frozen=True)
class UploadResult:
    file_path: str
    source_id: str | None
    remote_title: str | None

def _emit(reporter: Callable[[str], None] | None, message: str) -> None:
    if reporter:
        reporter(message)

def _read_attr(obj: Any, attr: str) -> Any | None:
    try:
        return getattr(obj, attr, None)
    except Exception:
        return None

def _load_notebooklm_client_class() -> type:
    try:
        from notebooklm import NotebookLMClient
        return NotebookLMClient
    except ImportError as e:
        raise ImportError(f"The 'notebooklm' package is required. Actual error: {e}")
    except Exception as e:
        raise RuntimeError(f"Unexpected error loading NotebookLM: {e}")

async def run_notebooklm_login() -> None:
    client_class = _load_notebooklm_client_class()
    async with await client_class.from_storage() as client:
        await client.login()

async def run_notebooklm_logout() -> None:
    p = Path.home() / ".notebooklm" / "storage_state.json"
    if p.exists():
        p.unlink()

async def _ensure_notebook(
    client: Any,
    *,
    notebook_id: str | None,
    notebook_title: str | None,
    reporter: Callable[[str], None] | None,
) -> str:
    if notebook_id:
        return notebook_id
    nb = await client.notebooks.create(title=notebook_title or "Untitled Notebook")
    new_id = _read_attr(nb, "id")
    if not new_id:
        raise ValueError("No ID returned from NotebookLM.")
    _emit(reporter, f"notebook: created \"{notebook_title}\" -> {new_id}")
    return new_id

def _remote_source_title(path: Path) -> str:
    return path.stem.replace("-", " ").replace("_", " ").title()

async def _rename_source(client: Any, notebook_id: str, source_id: str, remote_title: str, reporter: Any) -> None:
    try:
        await client.sources.update(notebook_id, source_id, title=remote_title)
        _emit(reporter, f"source: renamed {source_id} -> \"{remote_title}\"")
    except Exception: pass

async def _upload_markdown_file(
    client: Any, notebook_id: str, path: Path, *, index: int, total_files: int, rename_remote_titles: bool,
    reporter: Callable[[str], None] | None, file_titles: dict[str, str] | None = None, source_map: dict[str, str] | None = None,
) -> UploadResult:
    # Delete before upload to prevent duplication
    if source_map and path.name in source_map:
        old_id = source_map[path.name]
        try:
            _emit(reporter, f"upload: deleting existing source {old_id} for {path.name}")
            await client.sources.delete(notebook_id, old_id)
            _emit(reporter, f"upload: deleted {old_id}")
        except Exception as e:
            _emit(reporter, f"upload: failed to delete {old_id}: {e}")

    _emit(reporter, f"upload: {index + 1}/{total_files} {path.name}")
    source = await client.sources.add_file(notebook_id, path, wait=True)
    source_id = _read_attr(source, "id")
    
    if source_id:
        _emit(reporter, f"upload: {path.name} -> {source_id} (captured)")

    remote_title = None
    if rename_remote_titles:
        remote_title = file_titles.get(path.name) if file_titles else _remote_source_title(path)
        _emit(reporter, f"upload: setting remote title to \"{remote_title}\" for {source_id}")
        if source_id: await _rename_source(client, notebook_id, source_id, remote_title, reporter)
    return UploadResult(file_path=str(path), source_id=source_id, remote_title=remote_title)

class NotebookLMPyUploader:
    def upload_directory(
        self, directory: Path, *, notebook_id: str | None = None, notebook_title: str | None = None,
        max_parallel_chunks: int = 5, rename_remote_titles: bool = False, include_files: set[str] | None = None,
        file_titles: dict[str, str] | None = None, source_map: dict[str, str] | None = None, reporter: Any = None,
    ) -> tuple[str, list[UploadResult]]:
        if include_files is not None:
            files = [directory / f for f in include_files if (directory / f).is_file()]
        else:
            files = sorted(directory.glob("*.md"))
            
        if not files: return notebook_id or "", []
        
        async def run_async():
            client_class = _load_notebooklm_client_class()
            async with await client_class.from_storage() as client:
                nb_id = await _ensure_notebook(client, notebook_id=notebook_id, notebook_title=notebook_title, reporter=reporter)
                
                semaphore = asyncio.Semaphore(max_parallel_chunks)
                
                async def sem_upload(i, f):
                    async with semaphore:
                        return await _upload_markdown_file(
                            client, nb_id, f, index=i, total_files=len(files), 
                            rename_remote_titles=rename_remote_titles, reporter=reporter, 
                            file_titles=file_titles, source_map=source_map
                        )
                
                tasks = [sem_upload(i, f) for i, f in enumerate(files)]
                return nb_id, await asyncio.gather(*tasks)
        return asyncio.run(run_async())
