from __future__ import annotations

import json
import sqlite3
import tempfile
import zipfile
from pathlib import Path
from unittest import TestCase

from notebooklm_chunker.anki import (
    AnkiExportError,
    Flashcard,
    build_apkg,
    collect_flashcards,
    load_flashcards,
    write_apkg_from_paths,
)

_FIXED_TS = 1_700_000_000.0


def _open_apkg_db(apkg_path: Path, extract_dir: Path) -> sqlite3.Connection:
    with zipfile.ZipFile(apkg_path) as archive:
        names = set(archive.namelist())
        assert "collection.anki2" in names
        assert "media" in names
        archive.extractall(extract_dir)
    return sqlite3.connect(str(extract_dir / "collection.anki2"))


class LoadFlashcardsTests(TestCase):
    def test_loads_notebooklm_json_shape(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "flashcards.json"
            path.write_text(
                json.dumps(
                    {
                        "title": "Demo",
                        "cards": [
                            {"front": "What is X?", "back": "X is a thing."},
                            {"front": "Define Y", "back": "Y is another."},
                        ],
                    }
                ),
                encoding="utf-8",
            )
            cards = load_flashcards(path)

        self.assertEqual(len(cards), 2)
        self.assertEqual(cards[0], Flashcard(front="What is X?", back="X is a thing."))
        self.assertEqual(cards[1].front, "Define Y")

    def test_loads_key_variants(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cards.json"
            path.write_text(
                json.dumps(
                    [
                        {"question": "Q1", "answer": "A1"},
                        {"term": "T2", "definition": "D2"},
                        {"q": "Q3", "a": "A3"},
                        {"f": "F4", "b": "B4"},
                    ]
                ),
                encoding="utf-8",
            )
            cards = load_flashcards(path)

        self.assertEqual([c.front for c in cards], ["Q1", "T2", "Q3", "F4"])
        self.assertEqual([c.back for c in cards], ["A1", "D2", "A3", "B4"])

    def test_loads_notebooklm_markdown(self) -> None:
        markdown = (
            "# Flashcards\n\n"
            "## Card 1\n\n"
            "**Q:** What is the capital of France?\n\n"
            "**A:** Paris\n\n"
            "---\n\n"
            "## Card 2\n\n"
            "**Q:** 2 + 2?\n\n"
            "**A:** 4\n\n"
            "---\n"
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "flashcards.md"
            path.write_text(markdown, encoding="utf-8")
            cards = load_flashcards(path)

        self.assertEqual(len(cards), 2)
        self.assertEqual(cards[0].front, "What is the capital of France?")
        self.assertEqual(cards[0].back, "Paris")
        self.assertEqual(cards[1].back, "4")

    def test_collect_from_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            (base / "a.json").write_text(
                json.dumps({"cards": [{"front": "A", "back": "1"}]}), encoding="utf-8"
            )
            (base / "b.md").write_text(
                "## Card 1\n\n**Q:** B\n\n**A:** 2\n", encoding="utf-8"
            )
            cards = collect_flashcards(base)

        fronts = sorted(c.front for c in cards)
        self.assertEqual(fronts, ["A", "B"])


class BuildApkgTests(TestCase):
    def _sample_cards(self) -> list[Flashcard]:
        return [
            Flashcard(front="What is X?", back="X is a thing."),
            Flashcard(front="Define Y", back="Y is another."),
            Flashcard(front="Tagged?", back="Yes", tags=("chapter1",)),
        ]

    def test_builds_valid_apkg_with_notes_and_cards(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "deck.apkg"
            build_apkg(
                self._sample_cards(),
                out,
                deck_name="My Deck",
                timestamp=_FIXED_TS,
                seed=42,
            )
            self.assertTrue(out.exists())
            self.assertTrue(zipfile.is_zipfile(out))

            extract_dir = Path(directory) / "extracted"
            extract_dir.mkdir()
            conn = _open_apkg_db(out, extract_dir)
            try:
                note_rows = conn.execute(
                    "SELECT id, mid, flds, sfld, csum, tags FROM notes ORDER BY id"
                ).fetchall()
                card_rows = conn.execute(
                    "SELECT id, nid, did, ord, type, queue FROM cards ORDER BY id"
                ).fetchall()
                col_row = conn.execute(
                    "SELECT ver, models, decks, conf FROM col"
                ).fetchone()
            finally:
                conn.close()

        self.assertEqual(len(note_rows), 3)
        self.assertEqual(len(card_rows), 3)

        # Fields joined by the unit separator, sort field is the front.
        first_flds = note_rows[0][2]
        self.assertIn("\x1f", first_flds)
        self.assertEqual(first_flds.split("\x1f"), ["What is X?", "X is a thing."])
        self.assertEqual(note_rows[0][3], "What is X?")
        self.assertIsInstance(note_rows[0][4], int)

        # Tag stored with surrounding spaces (Anki convention).
        self.assertIn("chapter1", note_rows[2][5])

        # Every card is a "new" card (type 0, queue 0) and links to its note.
        note_ids = {row[0] for row in note_rows}
        for card in card_rows:
            self.assertIn(card[1], note_ids)
            self.assertEqual(card[3], 0)  # ord
            self.assertEqual(card[4], 0)  # type new
            self.assertEqual(card[5], 0)  # queue new

        # Collection metadata is schema v11 and the deck/model are registered.
        ver, models_json, decks_json, conf_json = col_row
        self.assertEqual(ver, 11)
        models = json.loads(models_json)
        decks = json.loads(decks_json)
        self.assertTrue(any(m["name"] == "Basic" for m in models.values()))
        self.assertTrue(any(d["name"] == "My Deck" for d in decks.values()))
        # Cards belong to the named deck, not the default deck.
        named_deck_ids = {
            int(k) for k, d in decks.items() if d["name"] == "My Deck"
        }
        self.assertTrue(all(card[2] in named_deck_ids for card in card_rows))

    def test_deterministic_output_with_fixed_timestamp_and_seed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            out_a = Path(directory) / "a.apkg"
            out_b = Path(directory) / "b.apkg"
            cards = self._sample_cards()
            build_apkg(cards, out_a, timestamp=_FIXED_TS, seed=7)
            build_apkg(cards, out_b, timestamp=_FIXED_TS, seed=7)

            with zipfile.ZipFile(out_a) as za:
                db_a = za.read("collection.anki2")
            with zipfile.ZipFile(out_b) as zb:
                db_b = zb.read("collection.anki2")

        self.assertEqual(db_a, db_b)

    def test_empty_cards_raise(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "deck.apkg"
            with self.assertRaises(AnkiExportError):
                build_apkg([], out)

    def test_write_apkg_from_paths_end_to_end(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            src = base / "flashcards.json"
            src.write_text(
                json.dumps(
                    {"cards": [{"front": "Hello", "back": "World"}]}
                ),
                encoding="utf-8",
            )
            out = base / "deck.apkg"
            result_path, count = write_apkg_from_paths(
                [src], out, deck_name="E2E", timestamp=_FIXED_TS, seed=1
            )
            self.assertEqual(result_path, out)
            self.assertEqual(count, 1)

            extract_dir = base / "extracted"
            extract_dir.mkdir()
            conn = _open_apkg_db(out, extract_dir)
            try:
                flds = conn.execute("SELECT flds FROM notes").fetchone()[0]
            finally:
                conn.close()
        self.assertEqual(flds.split("\x1f"), ["Hello", "World"])
