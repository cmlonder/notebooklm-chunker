from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from typing import Any

from notebooklm_chunker.parsers import ChunkerError


CURRENT_STATE_VERSION = 2
_EMPTY_SOURCE_STATE = {
    "status": "pending",
    "source_id": None,
    "remote_title": None,
    "attempts": 0,
    "last_error": None,
    "updated_at": None,
}
_EMPTY_STUDIO_STATE = {
    "status": "pending",
    "task_id": None,
    "artifact_id": None,
    "output_path": None,
    "remote_title": None,
    "attempts": 0,
    "last_error": None,
    "next_retry_at": None,
    "updated_at": None,
}


class RunStateError(ChunkerError):
    """Raised when a persisted run state file cannot be read or written."""


class RunStateStore:
    def __init__(
        self,
        path: Path,
        *,
        notebook_id: str | None = None,
        notebook_title: str | None = None,
        chunks: dict[str, dict[str, Any]] | None = None,
        notebook_studios: dict[str, dict[str, Any]] | None = None,
    ) -> None:
        self.path = path
        self.notebook_id = notebook_id
        self.notebook_title = notebook_title
        self._chunks = chunks or {}
        self._notebook_studios = notebook_studios or {}
        self._lock = asyncio.Lock()

    @classmethod
    def load(cls, path: Path) -> "RunStateStore":
        if not path.is_file():
            return cls(path)

        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise RunStateError(f"Invalid resume state file {path}: {exc}") from exc
        except OSError as exc:
            raise RunStateError(f"Could not read resume state file {path}: {exc}") from exc

        if not isinstance(raw, dict):
            raise RunStateError(f"Invalid resume state file {path}: expected a JSON object.")

        notebook_id = _read_optional_str(raw.get("notebook_id"))
        notebook_title = _read_optional_str(raw.get("notebook_title"))
        chunks = _normalize_chunks(raw.get("chunks"))
        notebook_studios = _normalize_notebook_studios(raw.get("notebook_studios"))
        return cls(
            path,
            notebook_id=notebook_id,
            notebook_title=notebook_title,
            chunks=chunks,
            notebook_studios=notebook_studios,
        )

    async def set_notebook(self, *, notebook_id: str, notebook_title: str | None) -> None:
        async with self._lock:
            self.notebook_id = notebook_id
            if notebook_title:
                self.notebook_title = notebook_title
            self._write()

    def uploaded_source(self, file_name: str, *, content_hash: str) -> tuple[str, str | None] | None:
        entry = self._matching_chunk(file_name, content_hash=content_hash)
        if entry is None:
            return None
        source = _normalize_source_state(entry.get("source"))
        if source.get("status") != "uploaded":
            return None
        source_id = _read_optional_str(source.get("source_id"))
        if source_id is None:
            return None
        return source_id, _read_optional_str(source.get("remote_title"))

    def source_state(self, file_name: str, *, content_hash: str) -> dict[str, Any] | None:
        entry = self._matching_chunk(file_name, content_hash=content_hash)
        if entry is None:
            return None
        return _normalize_source_state(entry.get("source"))

    async def record_source_state(
        self,
        *,
        file_name: str,
        content_hash: str,
        status: str,
        source_id: str | None = None,
        remote_title: str | None = None,
        last_error: str | None = None,
        attempts: int | None = None,
    ) -> None:
        async with self._lock:
            entry = self._chunk_entry(file_name)
            entry["content_hash"] = content_hash
            entry["source"] = _merge_source_state(
                entry.get("source"),
                status=status,
                source_id=source_id,
                remote_title=remote_title,
                last_error=last_error,
                attempts=attempts,
            )
            self._write()

    async def record_source_uploaded(
        self,
        *,
        file_name: str,
        content_hash: str,
        source_id: str,
        remote_title: str | None,
    ) -> None:
        await self.record_source_state(
            file_name=file_name,
            content_hash=content_hash,
            status="uploaded",
            source_id=source_id,
            remote_title=remote_title,
            last_error=None,
        )

    async def record_source_failed(
        self,
        *,
        file_name: str,
        content_hash: str,
        error: str,
    ) -> None:
        await self.record_source_state(
            file_name=file_name,
            content_hash=content_hash,
            status="failed",
            last_error=error,
        )

    def uploaded_chunk(self, file_name: str, *, content_hash: str) -> tuple[str, str | None] | None:
        return self.uploaded_source(file_name, content_hash=content_hash)

    async def record_uploaded_chunk(
        self,
        *,
        file_name: str,
        content_hash: str,
        source_id: str,
        remote_title: str | None,
    ) -> None:
        await self.record_source_uploaded(
            file_name=file_name,
            content_hash=content_hash,
            source_id=source_id,
            remote_title=remote_title,
        )

    def completed_chunk_studio(
        self,
        *,
        file_name: str,
        studio_name: str,
        content_hash: str,
        output_path: Path,
    ) -> dict[str, Any] | None:
        studio_state = self._chunk_studio_state(
            file_name=file_name,
            studio_name=studio_name,
            content_hash=content_hash,
        )
        if studio_state is None:
            return None
        if studio_state.get("status") != "completed":
            return None
        if not output_path.is_file():
            return None
        return studio_state

    def pending_chunk_studio(
        self,
        *,
        file_name: str,
        studio_name: str,
        content_hash: str,
    ) -> dict[str, Any] | None:
        studio_state = self._chunk_studio_state(
            file_name=file_name,
            studio_name=studio_name,
            content_hash=content_hash,
        )
        if studio_state is None:
            return None
        if studio_state.get("status") == "completed":
            return None
        return studio_state

    async def record_chunk_studio_state(
        self,
        *,
        file_name: str,
        studio_name: str,
        content_hash: str,
        status: str,
        task_id: str | None = None,
        artifact_id: str | None = None,
        output_path: str | None = None,
        remote_title: str | None = None,
        error: str | None = None,
        attempts: int | None = None,
        next_retry_at: str | None = None,
    ) -> None:
        async with self._lock:
            entry = self._chunk_entry(file_name)
            entry["content_hash"] = content_hash
            studios = entry.setdefault("studios", {})
            studios[studio_name] = _merge_studio_state(
                studios.get(studio_name),
                status=status,
                task_id=task_id,
                artifact_id=artifact_id,
                output_path=output_path,
                remote_title=remote_title,
                error=error,
                attempts=attempts,
                next_retry_at=next_retry_at,
            )
            self._write()

    async def record_completed_chunk_studio(
        self,
        *,
        file_name: str,
        studio_name: str,
        content_hash: str,
        artifact_id: str | None,
        output_path: str | None,
        remote_title: str | None,
    ) -> None:
        await self.record_chunk_studio_state(
            file_name=file_name,
            studio_name=studio_name,
            content_hash=content_hash,
            status="completed",
            artifact_id=artifact_id,
            output_path=output_path,
            remote_title=remote_title,
            error=None,
        )

    async def record_pending_chunk_studio(
        self,
        *,
        file_name: str,
        studio_name: str,
        content_hash: str,
        task_id: str | None,
        output_path: str | None,
        remote_title: str | None,
        error: str | None,
        status: str = "pending",
        next_retry_at: str | None = None,
    ) -> None:
        await self.record_chunk_studio_state(
            file_name=file_name,
            studio_name=studio_name,
            content_hash=content_hash,
            status=status,
            task_id=task_id,
            output_path=output_path,
            remote_title=remote_title,
            error=error,
            next_retry_at=next_retry_at,
        )

    def completed_notebook_studio(self, *, studio_name: str, output_path: Path) -> dict[str, Any] | None:
        entry = _normalize_studio_state(self._notebook_studios.get(studio_name))
        if entry.get("status") != "completed":
            return None
        if not output_path.is_file():
            return None
        return entry

    def pending_notebook_studio(self, *, studio_name: str) -> dict[str, Any] | None:
        entry = _normalize_studio_state(self._notebook_studios.get(studio_name))
        if entry.get("status") == "completed":
            return None
        return entry

    async def record_notebook_studio_state(
        self,
        *,
        studio_name: str,
        status: str,
        task_id: str | None = None,
        artifact_id: str | None = None,
        output_path: str | None = None,
        remote_title: str | None = None,
        error: str | None = None,
        attempts: int | None = None,
        next_retry_at: str | None = None,
    ) -> None:
        async with self._lock:
            self._notebook_studios[studio_name] = _merge_studio_state(
                self._notebook_studios.get(studio_name),
                status=status,
                task_id=task_id,
                artifact_id=artifact_id,
                output_path=output_path,
                remote_title=remote_title,
                error=error,
                attempts=attempts,
                next_retry_at=next_retry_at,
            )
            self._write()

    async def record_completed_notebook_studio(
        self,
        *,
        studio_name: str,
        artifact_id: str | None,
        output_path: str | None,
        remote_title: str | None,
    ) -> None:
        await self.record_notebook_studio_state(
            studio_name=studio_name,
            status="completed",
            artifact_id=artifact_id,
            output_path=output_path,
            remote_title=remote_title,
            error=None,
        )

    async def record_pending_notebook_studio(
        self,
        *,
        studio_name: str,
        task_id: str | None,
        output_path: str | None,
        remote_title: str | None,
        error: str | None,
        status: str = "pending",
        next_retry_at: str | None = None,
    ) -> None:
        await self.record_notebook_studio_state(
            studio_name=studio_name,
            status=status,
            task_id=task_id,
            output_path=output_path,
            remote_title=remote_title,
            error=error,
            next_retry_at=next_retry_at,
        )

    def _chunk_entry(self, file_name: str) -> dict[str, Any]:
        entry = _normalize_chunk_entry(self._chunks.get(file_name))
        self._chunks[file_name] = entry
        return entry

    def _matching_chunk(self, file_name: str, *, content_hash: str) -> dict[str, Any] | None:
        entry = self._chunks.get(file_name)
        if not isinstance(entry, dict):
            return None
        normalized = _normalize_chunk_entry(entry)
        if normalized.get("content_hash") != content_hash:
            return None
        self._chunks[file_name] = normalized
        return normalized

    def _chunk_studio_state(
        self,
        *,
        file_name: str,
        studio_name: str,
        content_hash: str,
    ) -> dict[str, Any] | None:
        entry = self._matching_chunk(file_name, content_hash=content_hash)
        if entry is None:
            return None
        studios = entry.get("studios")
        if not isinstance(studios, dict):
            return None
        studio_state = _normalize_studio_state(studios.get(studio_name))
        if studio_name in studios:
            studios[studio_name] = studio_state
        elif studio_state.get("status") != "pending" or studio_state.get("attempts") != 0:
            studios[studio_name] = studio_state
        else:
            return None
        return studio_state

    def _write(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": CURRENT_STATE_VERSION,
            "notebook_id": self.notebook_id,
            "notebook_title": self.notebook_title,
            "chunks": self._chunks,
            "notebook_studios": self._notebook_studios,
        }
        try:
            self.path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        except OSError as exc:
            raise RunStateError(f"Could not write resume state file {self.path}: {exc}") from exc


def chunk_content_hash(path: Path) -> str:
    try:
        return sha256(path.read_bytes()).hexdigest()
    except OSError as exc:
        raise RunStateError(f"Could not read chunk file for resume hashing: {path}") from exc


def _normalize_chunks(value: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(value, dict):
        return {}
    normalized: dict[str, dict[str, Any]] = {}
    for file_name, entry in value.items():
        if not isinstance(file_name, str):
            continue
        normalized[file_name] = _normalize_chunk_entry(entry)
    return normalized


def _normalize_notebook_studios(value: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(value, dict):
        return {}
    normalized: dict[str, dict[str, Any]] = {}
    for studio_name, entry in value.items():
        if not isinstance(studio_name, str):
            continue
        normalized[studio_name] = _normalize_studio_state(entry)
    return normalized


def _normalize_chunk_entry(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {
            "content_hash": None,
            "source": dict(_EMPTY_SOURCE_STATE),
            "studios": {},
        }

    content_hash = _read_optional_str(value.get("content_hash"))
    source = value.get("source")
    if source is None:
        source = {
            "status": "uploaded" if value.get("source_id") else "pending",
            "source_id": value.get("source_id"),
            "remote_title": value.get("remote_title"),
        }
    studios_raw = value.get("studios")
    studios: dict[str, dict[str, Any]] = {}
    if isinstance(studios_raw, dict):
        for studio_name, studio_entry in studios_raw.items():
            if isinstance(studio_name, str):
                studios[studio_name] = _normalize_studio_state(studio_entry)

    return {
        "content_hash": content_hash,
        "source": _normalize_source_state(source),
        "studios": studios,
    }


def _normalize_source_state(value: Any) -> dict[str, Any]:
    raw = value if isinstance(value, dict) else {}
    source_id = _read_optional_str(raw.get("source_id"))
    status = _read_optional_str(raw.get("status")) or ("uploaded" if source_id else "pending")
    return {
        "status": status,
        "source_id": source_id,
        "remote_title": _read_optional_str(raw.get("remote_title")),
        "attempts": _read_non_negative_int(raw.get("attempts")),
        "last_error": _read_optional_str(raw.get("last_error")) or _read_optional_str(raw.get("error")),
        "updated_at": _read_optional_str(raw.get("updated_at")),
    }


def _normalize_studio_state(value: Any) -> dict[str, Any]:
    raw = value if isinstance(value, dict) else {}
    status = _read_optional_str(raw.get("status")) or "pending"
    task_id = _read_optional_str(raw.get("task_id"))
    artifact_id = _read_optional_str(raw.get("artifact_id"))
    output_path = _read_optional_str(raw.get("output_path"))
    remote_title = _read_optional_str(raw.get("remote_title"))
    attempts = _read_non_negative_int(raw.get("attempts"))
    if attempts == 0 and any(item is not None for item in (task_id, artifact_id, output_path, remote_title)):
        attempts = 1
    return {
        "status": status,
        "task_id": task_id,
        "artifact_id": artifact_id,
        "output_path": output_path,
        "remote_title": remote_title,
        "attempts": attempts,
        "last_error": _read_optional_str(raw.get("last_error")) or _read_optional_str(raw.get("error")),
        "next_retry_at": _read_optional_str(raw.get("next_retry_at")),
        "updated_at": _read_optional_str(raw.get("updated_at")),
    }


def _merge_source_state(
    existing: Any,
    *,
    status: str,
    source_id: str | None = None,
    remote_title: str | None = None,
    last_error: str | None = None,
    attempts: int | None = None,
) -> dict[str, Any]:
    state = _normalize_source_state(existing)
    state["status"] = status
    if source_id is not None:
        state["source_id"] = source_id
    if remote_title is not None or status == "uploaded":
        state["remote_title"] = remote_title
    state["last_error"] = last_error
    state["attempts"] = attempts if attempts is not None else state["attempts"] + 1
    state["updated_at"] = _timestamp_now()
    return state


def _merge_studio_state(
    existing: Any,
    *,
    status: str,
    task_id: str | None = None,
    artifact_id: str | None = None,
    output_path: str | None = None,
    remote_title: str | None = None,
    error: str | None = None,
    attempts: int | None = None,
    next_retry_at: str | None = None,
) -> dict[str, Any]:
    state = _normalize_studio_state(existing)
    state["status"] = status
    if task_id is not None or status == "create_failed":
        state["task_id"] = task_id
    if artifact_id is not None or status == "completed":
        state["artifact_id"] = artifact_id
    if output_path is not None:
        state["output_path"] = output_path
    if remote_title is not None or status == "completed":
        state["remote_title"] = remote_title
    state["last_error"] = error
    state["next_retry_at"] = next_retry_at
    state["attempts"] = attempts if attempts is not None else state["attempts"] + 1
    state["updated_at"] = _timestamp_now()
    return state


def _timestamp_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _read_optional_str(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return str(value)


def _read_non_negative_int(value: Any) -> int:
    if value is None:
        return 0
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return max(0, value)
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0
