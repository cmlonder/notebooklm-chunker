const test = require("node:test");
const assert = require("node:assert/strict");

const {
  escapeHtml,
  attrArg,
  matchesQuery,
  slugifyStem,
  nextVersionRawName,
  deriveProjectStatus,
  buildStudiosToml,
  STUDIO_OPTIONS,
  normalizeStudioConfig,
  parseNotebookId,
  parseSkipRanges,
  skipRangesToArgs,
  countSkippedPages,
  stripLeadingNumbering,
  normalizeTitleCase,
} = require("../renderer/project-utils.js");

test("slugifyStem creates stable lowercase project stems", () => {
  assert.equal(slugifyStem("Havacılık Domaini.pdf"), "havaclk-domaini");
  assert.equal(slugifyStem("DDD Quickly.pdf"), "ddd-quickly");
});

test("nextVersionRawName increments only when needed", () => {
  assert.equal(nextVersionRawName("ddd-quickly", []), "ddd-quickly-chunks");
  assert.equal(
    nextVersionRawName("ddd-quickly", ["ddd-quickly-chunks"]),
    "ddd-quickly-chunks-1",
  );
  assert.equal(
    nextVersionRawName("ddd-quickly", ["ddd-quickly-chunks", "ddd-quickly-chunks-1"]),
    "ddd-quickly-chunks-2",
  );
});

test("deriveProjectStatus reports synced projects", () => {
  const status = deriveProjectStatus({
    manifestEntries: [{ synced: true }, { synced: true }],
    metadata: { notebook_id: "nb1" },
    runState: {},
  });
  assert.equal(status.label, "Synced");
  assert.equal(status.tone, "green");
});

test("deriveProjectStatus reports quota blocks before sync status", () => {
  const status = deriveProjectStatus({
    manifestEntries: [{ synced: true }],
    metadata: { notebook_id: "nb1" },
    runState: {
      quota_blocks: {
        slide_deck: {
          blocked_until: "2026-03-11T10:00:00Z",
        },
      },
    },
  });
  assert.equal(status.label, "Quota blocked");
  assert.equal(status.detail, "slide_deck");
});

test("buildStudiosToml writes per-chunk studio config", () => {
  const toml = buildStudiosToml({
    outputDir: "./output/demo/chunks",
    notebookId: "nb1",
    maxParallelChunks: 3,
    downloadOutputs: false,
    studios: {
      quiz: {
        enabled: true,
        outputDir: "./output/demo/quizzes",
        quantity: "more",
        difficulty: "hard",
        prompt: "Ask practical questions.",
      },
    },
  });

  assert.match(toml, /\[chunking\]/);
  assert.match(toml, /download_outputs = false/);
  assert.match(toml, /\[studios\.quiz\]/);
  assert.match(toml, /per_chunk = true/);
  assert.match(toml, /quantity = "more"/);
});

test("buildStudiosToml omits per_chunk when disabled explicitly", () => {
  const toml = buildStudiosToml({
    outputDir: "./output/demo/chunks",
    notebookId: "nb1",
    maxParallelChunks: 3,
    downloadOutputs: true,
    studios: {
      report: {
        enabled: true,
        perChunk: false,
        outputDir: "./output/demo/reports",
      },
    },
  });

  assert.match(toml, /\[studios\.report\]/);
  assert.doesNotMatch(toml, /per_chunk = true/);
});

test("normalizeStudioConfig migrates values older builds saved", () => {
  assert.deepEqual(
    normalizeStudioConfig("quiz", { quantity: "more", difficulty: "easier", downloadFormat: "html" }),
    { quantity: "more", difficulty: "easy", downloadFormat: "html" },
  );
  assert.equal(normalizeStudioConfig("flashcards", { difficulty: "default" }).difficulty, "medium");
  assert.equal(normalizeStudioConfig("audio", { format: "conversational" }).format, "deep-dive");
  assert.equal(normalizeStudioConfig("report", { format: "faq" }).format, "study-guide");
});

test("normalizeStudioConfig drops unknown values and keeps other fields", () => {
  const normalized = normalizeStudioConfig("report", {
    enabled: true,
    format: "made-up",
    language: "tr",
    prompt: "Keep it short.",
  });
  assert.deepEqual(normalized, { enabled: true, language: "tr", prompt: "Keep it short." });
});

test("normalizeStudioConfig never pairs a short video with a custom style", () => {
  assert.deepEqual(
    normalizeStudioConfig("video", { format: "short", style: "custom", stylePrompt: "Noir" }),
    { format: "short", style: "auto" },
  );
  assert.deepEqual(
    normalizeStudioConfig("video", { format: "cinematic", style: "custom", stylePrompt: "Noir" }),
    { format: "cinematic", style: "custom", stylePrompt: "Noir" },
  );
});

test("STUDIO_OPTIONS covers every engine Studio type", () => {
  assert.deepEqual(Object.keys(STUDIO_OPTIONS).sort(), [
    "audio",
    "data_table",
    "flashcards",
    "infographic",
    "mind_map",
    "quiz",
    "report",
    "slide_deck",
    "video",
  ]);
  assert.ok(STUDIO_OPTIONS.video.format.includes("short"));
  assert.ok(STUDIO_OPTIONS.report.format.includes("concept-explanation"));
  assert.ok(STUDIO_OPTIONS.mind_map.format.includes("interactive"));
});

test("buildStudiosToml writes only values the engine accepts", () => {
  const toml = buildStudiosToml({
    outputDir: "./output/demo/chunks",
    notebookId: "nb1",
    studios: {
      quiz: { enabled: true, difficulty: "default", quantity: "standard" },
      audio: { enabled: true, format: "conversational" },
    },
  });

  assert.match(toml, /difficulty = "medium"/);
  assert.match(toml, /format = "deep-dive"/);
  assert.doesNotMatch(toml, /conversational|"default"/);
});

test("parseNotebookId extracts notebook id from CLI output", () => {
  assert.equal(parseNotebookId("Notebook ID: abc-123\nUploaded sources: 5"), "abc-123");
  assert.equal(parseNotebookId("no notebook"), null);
});

test("escapeHtml escapes all HTML-sensitive characters", () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="alert('xss')">`),
    "&lt;img src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt;",
  );
  assert.equal(escapeHtml("Tom & Jerry"), "Tom &amp; Jerry");
  assert.equal(escapeHtml("plain text"), "plain text");
});

test("escapeHtml coerces non-strings with String()", () => {
  assert.equal(escapeHtml(42), "42");
  assert.equal(escapeHtml(true), "true");
  assert.equal(escapeHtml(null), "null");
  assert.equal(escapeHtml(undefined), "undefined");
});

test("attrArg produces attribute-safe JS string literals", () => {
  assert.equal(attrArg("plain"), "&quot;plain&quot;");
  assert.equal(attrArg(`a"b'c`), "&quot;a\\&quot;b&#39;c&quot;");
  assert.equal(attrArg("</script><b>"), "&quot;&lt;/script&gt;&lt;b&gt;&quot;");
});

test("matchesQuery does case-insensitive substring matching", () => {
  assert.equal(matchesQuery("Hello World", "world"), true);
  assert.equal(matchesQuery("Hello World", "WORLD"), true);
  assert.equal(matchesQuery("Hello World", "mars"), false);
  assert.equal(matchesQuery("Hello World", "  world  "), true);
});

test("matchesQuery treats empty or missing query as a match", () => {
  assert.equal(matchesQuery("anything", ""), true);
  assert.equal(matchesQuery("anything", "   "), true);
  assert.equal(matchesQuery("anything", null), true);
  assert.equal(matchesQuery("anything", undefined), true);
});

test("matchesQuery handles missing text safely", () => {
  assert.equal(matchesQuery(null, "x"), false);
  assert.equal(matchesQuery(undefined, "x"), false);
  assert.equal(matchesQuery(null, ""), true);
});

test("parseSkipRanges parses ranges and single pages", () => {
  assert.deepEqual(parseSkipRanges("1-8, 12, 399-420"), [[1, 8], [12, 12], [399, 420]]);
  assert.deepEqual(parseSkipRanges("5"), [[5, 5]]);
  assert.deepEqual(parseSkipRanges("1 - 8"), [[1, 8]]);
});

test("parseSkipRanges ignores blanks and empty input", () => {
  assert.deepEqual(parseSkipRanges(""), []);
  assert.deepEqual(parseSkipRanges("   "), []);
  assert.deepEqual(parseSkipRanges(null), []);
  assert.deepEqual(parseSkipRanges(undefined), []);
  assert.deepEqual(parseSkipRanges("1-8, , 12"), [[1, 8], [12, 12]]);
});

test("parseSkipRanges sorts, merges overlaps and adjacency", () => {
  assert.deepEqual(parseSkipRanges("12, 1-8"), [[1, 8], [12, 12]]);
  assert.deepEqual(parseSkipRanges("1-8, 5-10"), [[1, 10]]);
  assert.deepEqual(parseSkipRanges("1-8, 9-10"), [[1, 10]]);
  assert.deepEqual(parseSkipRanges("1-8, 10-12"), [[1, 8], [10, 12]]);
});

test("parseSkipRanges drops malformed tokens and normalizes reversed ranges", () => {
  assert.deepEqual(parseSkipRanges("x-y"), []);
  assert.deepEqual(parseSkipRanges("abc, 1-8"), [[1, 8]]);
  assert.deepEqual(parseSkipRanges("0, -5, 1-8"), [[1, 8]]);
  assert.deepEqual(parseSkipRanges("20-10"), [[10, 20]]);
  assert.deepEqual(parseSkipRanges(["1-8", "12"]), [[1, 8], [12, 12]]);
});

test("skipRangesToArgs collapses single-page ranges to a bare page", () => {
  assert.deepEqual(skipRangesToArgs([[1, 8], [12, 12], [399, 420]]), ["1-8", "12", "399-420"]);
  assert.deepEqual(skipRangesToArgs([]), []);
});

test("countSkippedPages counts a distinct union of skipped pages", () => {
  assert.equal(countSkippedPages({ totalPages: 100, skipStart: 8, skipEnd: 5 }), 13);
  assert.equal(
    countSkippedPages({ totalPages: 100, skipStart: 8, skipEnd: 5, ranges: [[20, 24]] }),
    18,
  );
  // Overlapping lead skip and a mid range are counted once.
  assert.equal(
    countSkippedPages({ totalPages: 100, skipStart: 8, ranges: [[5, 12]] }),
    12,
  );
  // Ranges are clamped to the document bounds.
  assert.equal(countSkippedPages({ totalPages: 10, ranges: [[5, 999]] }), 6);
  assert.equal(countSkippedPages({ totalPages: 0, skipStart: 5 }), 0);
});

test("stripLeadingNumbering removes leading section numbers", () => {
  assert.equal(stripLeadingNumbering("4.4.2.13 Aggregate Roots"), "Aggregate Roots");
  assert.equal(stripLeadingNumbering("1.1 Introduction"), "Introduction");
  assert.equal(stripLeadingNumbering("1. Overview"), "Overview");
  assert.equal(stripLeadingNumbering("12) Getting Started"), "Getting Started");
  assert.equal(stripLeadingNumbering("3.5 - Value Objects"), "Value Objects");
});

test("stripLeadingNumbering is conservative and preserves content", () => {
  assert.equal(stripLeadingNumbering("Domain-Driven Design"), "Domain-Driven Design");
  assert.equal(stripLeadingNumbering("42"), "42");
  assert.equal(stripLeadingNumbering("1.1"), "1.1");
  assert.equal(stripLeadingNumbering("  1.2 Bounded Contexts  "), "Bounded Contexts");
  assert.equal(stripLeadingNumbering(""), "");
});

test("normalizeTitleCase title-cases ALL-CAPS titles", () => {
  assert.equal(normalizeTitleCase("AGGREGATE ROOTS AND VALUE OBJECTS"), "Aggregate Roots and Value Objects");
  assert.equal(normalizeTitleCase("DOMAIN-DRIVEN DESIGN"), "Domain-Driven Design");
  assert.equal(normalizeTitleCase("THE CONTEXT MAP"), "The Context Map");
});

test("normalizeTitleCase leaves mixed-case titles and acronyms untouched", () => {
  assert.equal(normalizeTitleCase("Bounded Contexts"), "Bounded Contexts");
  assert.equal(normalizeTitleCase("iOS Development"), "iOS Development");
  assert.equal(normalizeTitleCase("Using DDD in Practice"), "Using DDD in Practice");
  assert.equal(normalizeTitleCase("  Extra   spaces  here  "), "Extra spaces here");
  assert.equal(normalizeTitleCase(""), "");
});
