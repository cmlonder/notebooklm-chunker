from __future__ import annotations

import io
import json
import tempfile
import textwrap
from contextlib import redirect_stdout
from pathlib import Path
from unittest import TestCase

from notebooklm_chunker.cli import main


def _run_inspect_tree(source: Path) -> dict:
    stdout = io.StringIO()
    with redirect_stdout(stdout):
        exit_code = main(["inspect", str(source), "--tree"])
    assert exit_code == 0
    return json.loads(stdout.getvalue())


class InspectTreeTests(TestCase):
    def _sample(self, directory: str) -> Path:
        source = Path(directory) / "book.md"
        source.write_text(
            textwrap.dedent(
                """
                # Chapter 1

                Intro paragraph with enough words to survive chunking here.

                ## Section 1.1

                Nested body text for the first subsection of the document.

                ## Section 1.2

                More nested body text for the second subsection right here.

                # Chapter 2

                Second chapter body paragraph with a reasonable word count too.
                """
            ).strip()
            + "\n",
            encoding="utf-8",
        )
        return source

    def test_tree_shape_is_nested_by_level(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            payload = _run_inspect_tree(self._sample(directory))

        self.assertIn("tree", payload)
        self.assertIn("chunk_count", payload)
        self.assertIsInstance(payload["chunk_count"], int)
        self.assertGreaterEqual(payload["chunk_count"], 1)

        tree = payload["tree"]
        self.assertIsInstance(tree, list)
        titles = [node["title"] for node in tree]
        self.assertEqual(titles, ["Chapter 1", "Chapter 2"])

        chapter_one = tree[0]
        for key in ("title", "level", "start_page", "end_page", "chunk_ids", "children"):
            self.assertIn(key, chapter_one)
        self.assertEqual(chapter_one["level"], 1)

        child_titles = [child["title"] for child in chapter_one["children"]]
        self.assertEqual(child_titles, ["Section 1.1", "Section 1.2"])
        for child in chapter_one["children"]:
            self.assertEqual(child["level"], 2)
            self.assertIsInstance(child["chunk_ids"], list)

    def test_tree_does_not_break_default_and_chunks_keys(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = self._sample(directory)
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                exit_code = main(["inspect", str(source), "--chunks", "--tree"])
            self.assertEqual(exit_code, 0)
            payload = json.loads(stdout.getvalue())

        # --chunks output is preserved alongside the new tree payload.
        self.assertIn("chunks", payload)
        self.assertIn("count", payload["chunks"])
        self.assertIn("tree", payload)
        self.assertIn("pages", payload)
