"""Convert NotebookLM flashcard output into an Anki ``.apkg`` deck.

A NotebookLM flashcards artifact is downloaded by the uploader in one of a few
shapes (see ``notebooklm/_artifact/formatters.py``):

* JSON: ``{"title": ..., "cards": [{"front": ..., "back": ...}]}``
* Markdown: ``## Card N`` blocks with ``**Q:**`` / ``**A:**`` lines separated
  by ``---``.

This module reads those (and reasonable key variants such as ``question`` /
``answer``, ``term`` / ``definition``, ``q`` / ``a``, ``f`` / ``b``) and writes
a genuinely valid Anki ``.apkg`` file using only the standard library.

An ``.apkg`` is a zip archive containing a ``collection.anki2`` SQLite database
(Anki schema version 11) plus a ``media`` manifest. We build a single "Basic"
note type with ``Front`` / ``Back`` fields and one card template per note.

Output is deterministic when a fixed ``timestamp`` (and optional ``seed``) is
supplied, which keeps tests reproducible.
"""

from __future__ import annotations

import hashlib
import json
import random
import re
import sqlite3
import tempfile
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

__all__ = [
    "Flashcard",
    "AnkiExportError",
    "load_flashcards",
    "collect_flashcards",
    "build_apkg",
    "write_apkg_from_paths",
]

# Field separator used inside Anki ``notes.flds``.
_FIELD_SEP = "\x1f"

# Base-91 alphabet used by Anki for note GUIDs.
_BASE91 = (
    "abcdefghijklmnopqrstuvwxyz"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "0123456789"
    "!#$%&()*+,-./:;<=>?@[]^_`{|}~"
)

# Accepted (front-key, back-key) aliases for dict-shaped cards, in priority order.
_KEY_ALIASES: tuple[tuple[str, str], ...] = (
    ("front", "back"),
    ("question", "answer"),
    ("term", "definition"),
    ("q", "a"),
    ("f", "b"),
    ("prompt", "response"),
)

_HTML_TAG_RE = re.compile(r"<[^>]+>")


class AnkiExportError(Exception):
    """Raised when flashcard input cannot be parsed or exported."""


@dataclass(frozen=True, slots=True)
class Flashcard:
    """A single front/back flashcard."""

    front: str
    back: str
    tags: tuple[str, ...] = field(default_factory=tuple)


# --------------------------------------------------------------------------- #
# Input parsing
# --------------------------------------------------------------------------- #


def _clean(value: object) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _card_from_dict(entry: dict) -> Flashcard | None:
    """Build a :class:`Flashcard` from a dict using known key aliases."""

    lowered = {str(k).lower(): v for k, v in entry.items()}
    for front_key, back_key in _KEY_ALIASES:
        if front_key in lowered or back_key in lowered:
            front = _clean(lowered.get(front_key))
            back = _clean(lowered.get(back_key))
            if front or back:
                tags = _coerce_tags(lowered.get("tags"))
                return Flashcard(front=front, back=back, tags=tags)
    return None


def _coerce_tags(value: object) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        return tuple(part for part in value.replace(",", " ").split() if part)
    if isinstance(value, (list, tuple)):
        return tuple(_clean(item) for item in value if _clean(item))
    return ()


def _cards_from_json(data: object) -> list[Flashcard]:
    """Extract cards from parsed JSON of a few possible shapes."""

    entries: object
    if isinstance(data, dict):
        for key in ("cards", "flashcards", "items"):
            if isinstance(data.get(key), list):
                entries = data[key]
                break
        else:
            # A single card object, e.g. {"front": ..., "back": ...}.
            single = _card_from_dict(data)
            return [single] if single else []
    elif isinstance(data, list):
        entries = data
    else:
        return []

    cards: list[Flashcard] = []
    for entry in entries:  # type: ignore[union-attr]
        if isinstance(entry, dict):
            card = _card_from_dict(entry)
            if card:
                cards.append(card)
        elif isinstance(entry, (list, tuple)) and len(entry) >= 2:
            front, back = _clean(entry[0]), _clean(entry[1])
            if front or back:
                cards.append(Flashcard(front=front, back=back))
    return cards


def _strip_qa_prefix(line: str) -> str:
    # Remove a leading "**Q:**" / "**A:**" (or "Q:" / "A:") marker.
    stripped = re.sub(r"^\s*\*{0,2}\s*[QAqa]\s*[:\-.]\s*\*{0,2}\s*", "", line)
    return stripped.strip()


def _cards_from_markdown(text: str) -> list[Flashcard]:
    """Parse NotebookLM flashcard markdown (``**Q:**`` / ``**A:**`` blocks)."""

    cards: list[Flashcard] = []
    front: str | None = None
    back_lines: list[str] = []

    def flush() -> None:
        nonlocal front, back_lines
        if front is not None:
            back = "\n".join(back_lines).strip()
            if front or back:
                cards.append(Flashcard(front=front.strip(), back=back))
        front = None
        back_lines = []

    mode: str | None = None
    for raw in text.splitlines():
        line = raw.rstrip()
        q_match = re.match(r"^\s*\*{0,2}\s*[Qq]\s*[:\-.]", line)
        a_match = re.match(r"^\s*\*{0,2}\s*[Aa]\s*[:\-.]", line)
        if q_match:
            flush()
            front = _strip_qa_prefix(line)
            mode = "q"
        elif a_match:
            back_lines = [_strip_qa_prefix(line)]
            mode = "a"
        elif re.match(r"^\s*(---+|## |# )", line):
            # Card / section boundary.
            if mode == "a":
                flush()
            mode = None
        elif mode == "a":
            back_lines.append(line)
        elif mode == "q" and front is not None and line.strip():
            front = (front + "\n" + line).strip()
    flush()
    return cards


def load_flashcards(path: Path) -> list[Flashcard]:
    """Load flashcards from a single ``.json``, ``.md``, or ``.txt`` file."""

    path = Path(path)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:  # pragma: no cover - defensive
        raise AnkiExportError(f"Cannot read flashcard file: {path}") from exc

    suffix = path.suffix.lower()
    if suffix == ".json":
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise AnkiExportError(f"Invalid JSON in flashcard file: {path}") from exc
        return _cards_from_json(data)

    if suffix in {".md", ".markdown", ".txt", ""}:
        return _cards_from_markdown(text)

    # Unknown extension: try JSON first, then fall back to markdown.
    try:
        return _cards_from_json(json.loads(text))
    except json.JSONDecodeError:
        return _cards_from_markdown(text)


def _iter_input_files(path: Path) -> list[Path]:
    if path.is_dir():
        files = [
            child
            for child in sorted(path.iterdir())
            if child.is_file() and child.suffix.lower() in {".json", ".md", ".markdown", ".txt"}
        ]
        if not files:
            raise AnkiExportError(f"No flashcard files (.json/.md/.txt) found in: {path}")
        return files
    if path.is_file():
        return [path]
    raise AnkiExportError(f"Flashcard input not found: {path}")


def collect_flashcards(inputs: list[Path] | Path) -> list[Flashcard]:
    """Load and concatenate flashcards from files and/or directories."""

    if isinstance(inputs, (str, Path)):
        inputs = [Path(inputs)]

    cards: list[Flashcard] = []
    for entry in inputs:
        for file_path in _iter_input_files(Path(entry)):
            cards.extend(load_flashcards(file_path))
    return cards


# --------------------------------------------------------------------------- #
# .apkg generation
# --------------------------------------------------------------------------- #


def _guid(num: int) -> str:
    """Encode a non-negative integer as an Anki-style base-91 string."""

    if num <= 0:
        return _BASE91[0]
    chars: list[str] = []
    base = len(_BASE91)
    while num > 0:
        num, rem = divmod(num, base)
        chars.append(_BASE91[rem])
    return "".join(reversed(chars))


def _field_checksum(text: str) -> int:
    """Anki field checksum: first 8 hex digits of the sha1 of the stripped field."""

    stripped = _HTML_TAG_RE.sub("", text)
    digest = hashlib.sha1(stripped.encode("utf-8")).hexdigest()
    return int(digest[:8], 16)


_SCHEMA = """
CREATE TABLE col (
    id integer primary key,
    crt integer not null,
    mod integer not null,
    scm integer not null,
    ver integer not null,
    dty integer not null,
    usn integer not null,
    ls integer not null,
    conf text not null,
    models text not null,
    decks text not null,
    dconf text not null,
    tags text not null
);
CREATE TABLE notes (
    id integer primary key,
    guid text not null,
    mid integer not null,
    mod integer not null,
    usn integer not null,
    tags text not null,
    flds text not null,
    sfld integer not null,
    csum integer not null,
    flags integer not null,
    data text not null
);
CREATE TABLE cards (
    id integer primary key,
    nid integer not null,
    did integer not null,
    ord integer not null,
    mod integer not null,
    usn integer not null,
    type integer not null,
    queue integer not null,
    due integer not null,
    ivl integer not null,
    factor integer not null,
    reps integer not null,
    lapses integer not null,
    left integer not null,
    odue integer not null,
    odid integer not null,
    flags integer not null,
    data text not null
);
CREATE TABLE revlog (
    id integer primary key,
    cid integer not null,
    usn integer not null,
    ease integer not null,
    ivl integer not null,
    lastIvl integer not null,
    factor integer not null,
    time integer not null,
    type integer not null
);
CREATE TABLE graves (
    usn integer not null,
    oid integer not null,
    type integer not null
);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);
"""

_MODEL_CSS = (
    ".card {\n"
    " font-family: arial;\n"
    " font-size: 20px;\n"
    " text-align: center;\n"
    " color: black;\n"
    " background-color: white;\n"
    "}\n"
)

_LATEX_PRE = (
    "\\documentclass[12pt]{article}\n"
    "\\special{papersize=3in,5in}\n"
    "\\usepackage[utf8]{inputenc}\n"
    "\\usepackage{amssymb,amsmath}\n"
    "\\pagestyle{empty}\n"
    "\\setlength{\\parindent}{0in}\n"
    "\\begin{document}\n"
)
_LATEX_POST = "\\end{document}"


def _build_models(model_id: int, deck_id: int, model_mod: int) -> dict:
    return {
        str(model_id): {
            "id": model_id,
            "name": "Basic",
            "type": 0,
            "mod": model_mod,
            "usn": -1,
            "sortf": 0,
            "did": deck_id,
            "tmpls": [
                {
                    "name": "Card 1",
                    "ord": 0,
                    "qfmt": "{{Front}}",
                    "afmt": "{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}",
                    "bqfmt": "",
                    "bafmt": "",
                    "did": None,
                    "bfont": "",
                    "bsize": 0,
                }
            ],
            "flds": [
                {
                    "name": "Front",
                    "ord": 0,
                    "sticky": False,
                    "rtl": False,
                    "font": "Arial",
                    "size": 20,
                    "media": [],
                },
                {
                    "name": "Back",
                    "ord": 1,
                    "sticky": False,
                    "rtl": False,
                    "font": "Arial",
                    "size": 20,
                    "media": [],
                },
            ],
            "css": _MODEL_CSS,
            "latexPre": _LATEX_PRE,
            "latexPost": _LATEX_POST,
            "latexsvg": False,
            "req": [[0, "any", [0]]],
            "tags": [],
            "vers": [],
        }
    }


def _build_decks(deck_id: int, deck_name: str, deck_mod: int) -> dict:
    common = {
        "collapsed": False,
        "browserCollapsed": False,
        "newToday": [0, 0],
        "revToday": [0, 0],
        "lrnToday": [0, 0],
        "timeToday": [0, 0],
        "dyn": 0,
        "extendNew": 0,
        "extendRev": 0,
        "conf": 1,
        "usn": -1,
        "desc": "",
    }
    return {
        "1": {"id": 1, "name": "Default", "mod": deck_mod, **common},
        str(deck_id): {"id": deck_id, "name": deck_name, "mod": deck_mod, **common},
    }


def _build_dconf(deck_mod: int) -> dict:
    return {
        "1": {
            "id": 1,
            "name": "Default",
            "mod": deck_mod,
            "usn": -1,
            "maxTaken": 60,
            "autoplay": True,
            "timer": 0,
            "replayq": True,
            "new": {
                "bury": False,
                "delays": [1.0, 10.0],
                "initialFactor": 2500,
                "ints": [1, 4, 0],
                "order": 1,
                "perDay": 20,
            },
            "rev": {
                "bury": False,
                "ease4": 1.3,
                "ivlFct": 1.0,
                "maxIvl": 36500,
                "perDay": 200,
                "hardFactor": 1.2,
            },
            "lapse": {
                "delays": [10.0],
                "leechAction": 1,
                "leechFails": 8,
                "minInt": 1,
                "mult": 0.0,
            },
            "dyn": False,
        }
    }


def _build_conf(model_id: int) -> dict:
    return {
        "nextPos": 1,
        "estTimes": True,
        "activeDecks": [1],
        "sortType": "noteFld",
        "timeLim": 0,
        "sortBackwards": False,
        "addToCur": True,
        "curDeck": 1,
        "newBury": True,
        "newSpread": 0,
        "dueCounts": True,
        "curModel": str(model_id),
        "collapseTime": 1200,
    }


def build_apkg(
    flashcards: list[Flashcard],
    output_path: Path,
    *,
    deck_name: str = "NotebookLM Flashcards",
    timestamp: float | None = None,
    seed: int | None = None,
) -> Path:
    """Write ``flashcards`` to a valid Anki ``.apkg`` at ``output_path``.

    Args:
        flashcards: Cards to include (must be non-empty).
        output_path: Destination ``.apkg`` path.
        deck_name: Name of the generated Anki deck.
        timestamp: Optional fixed epoch seconds for deterministic output.
        seed: Optional RNG seed for deterministic note GUIDs.

    Returns:
        The resolved output path.
    """

    if not flashcards:
        raise AnkiExportError("No flashcards to export.")

    output_path = Path(output_path)
    now = float(timestamp) if timestamp is not None else time.time()
    now_ms = int(now * 1000)
    now_s = int(now)
    rng = random.Random(seed if seed is not None else now_ms)

    model_id = now_ms
    deck_id = now_ms + 1

    conf = _build_conf(model_id)
    models = _build_models(model_id, deck_id, now_s)
    decks = _build_decks(deck_id, deck_name, now_s)
    dconf = _build_dconf(now_s)

    with tempfile.TemporaryDirectory() as tmp_dir:
        db_path = Path(tmp_dir) / "collection.anki2"
        conn = sqlite3.connect(str(db_path))
        try:
            conn.executescript(_SCHEMA)
            conn.execute(
                "INSERT INTO col VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    1,
                    now_s,
                    now_ms,
                    now_ms,
                    11,
                    0,
                    0,
                    0,
                    json.dumps(conf),
                    json.dumps(models),
                    json.dumps(decks),
                    json.dumps(dconf),
                    json.dumps({}),
                ),
            )

            note_base = now_ms
            card_base = now_ms + 500_000
            for index, card in enumerate(flashcards):
                note_id = note_base + index
                card_id = card_base + index
                flds = card.front + _FIELD_SEP + card.back
                sfld = _HTML_TAG_RE.sub("", card.front)
                csum = _field_checksum(card.front)
                guid = _guid(rng.getrandbits(64))
                tags = ""
                if card.tags:
                    tags = " " + " ".join(card.tags) + " "

                conn.execute(
                    "INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        note_id,
                        guid,
                        model_id,
                        now_s,
                        -1,
                        tags,
                        flds,
                        sfld,
                        csum,
                        0,
                        "",
                    ),
                )
                conn.execute(
                    "INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        card_id,
                        note_id,
                        deck_id,
                        0,          # ord
                        now_s,      # mod
                        -1,         # usn
                        0,          # type (new)
                        0,          # queue (new)
                        index + 1,  # due (position)
                        0,          # ivl
                        0,          # factor
                        0,          # reps
                        0,          # lapses
                        0,          # left
                        0,          # odue
                        0,          # odid
                        0,          # flags
                        "",         # data
                    ),
                )
            conn.commit()
        finally:
            conn.close()

        output_path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.write(db_path, "collection.anki2")
            archive.writestr("media", json.dumps({}))

    return output_path


def write_apkg_from_paths(
    inputs: list[Path] | Path,
    output_path: Path,
    *,
    deck_name: str = "NotebookLM Flashcards",
    timestamp: float | None = None,
    seed: int | None = None,
) -> tuple[Path, int]:
    """Load flashcards from ``inputs`` and write an ``.apkg``.

    Returns a ``(output_path, card_count)`` tuple.
    """

    cards = collect_flashcards(inputs)
    if not cards:
        raise AnkiExportError("No flashcards found in the provided input.")
    result = build_apkg(
        cards,
        output_path,
        deck_name=deck_name,
        timestamp=timestamp,
        seed=seed,
    )
    return result, len(cards)
