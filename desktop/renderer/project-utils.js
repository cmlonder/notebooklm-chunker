(function initProjectUtils(globalScope) {
  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function attrArg(value) {
    return escapeHtml(JSON.stringify(value));
  }

  function matchesQuery(text, query) {
    const normalizedQuery = String(query || "").trim().toLowerCase();
    if (!normalizedQuery) return true;
    return String(text || "").toLowerCase().includes(normalizedQuery);
  }

  function slugifyStem(fileName) {
    return String(fileName || "")
      .replace(/\.[^.]+$/, "")
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[_\s]+/g, "-")
      .replace(/-+/g, "-")
      .toLowerCase();
  }

  function nextVersionRawName(baseStem, existingRawNames) {
    const normalized = new Set((existingRawNames || []).map(String));
    const baseName = `${baseStem}-chunks`;
    if (!normalized.has(baseName)) {
      return baseName;
    }
    let index = 1;
    while (normalized.has(`${baseName}-${index}`)) {
      index += 1;
    }
    return `${baseName}-${index}`;
  }

  function parseQuotaBlocks(runState) {
    if (!runState || typeof runState !== "object") {
      return [];
    }
    const blocks = runState.quota_blocks || {};
    return Object.entries(blocks)
      .filter(([, block]) => block && typeof block.blocked_until === "string")
      .map(([studioName, block]) => ({ studioName, blockedUntil: block.blocked_until }));
  }

  function deriveProjectStatus({ manifestEntries, metadata, runState }) {
    const entries = Array.isArray(manifestEntries) ? manifestEntries : [];
    const syncedCount = entries.filter((entry) => entry && entry.synced === true).length;
    const changedCount = entries.filter((entry) => entry && entry.synced !== true).length;
    const blockedStudios = parseQuotaBlocks(runState);

    if (blockedStudios.length > 0) {
      return {
        label: "Quota blocked",
        tone: "amber",
        detail: blockedStudios.map((item) => item.studioName).join(", "),
      };
    }
    if (!metadata || !metadata.notebook_id) {
      return {
        label: entries.length > 0 ? "Local draft" : "Empty draft",
        tone: "slate",
        detail: `${entries.length} chunk${entries.length === 1 ? "" : "s"}`,
      };
    }
    if (entries.length > 0 && changedCount === 0) {
      return {
        label: "Synced",
        tone: "green",
        detail: `${syncedCount} source${syncedCount === 1 ? "" : "s"}`,
      };
    }
    return {
      label: "Needs sync",
      tone: "blue",
      detail: `${changedCount} changed`,
    };
  }

  function buildStudiosToml({
    outputDir,
    notebookId,
    maxParallelChunks,
    studios,
    downloadOutputs,
  }) {
    const lines = [
      "[chunking]",
      `output_dir = ${JSON.stringify(outputDir)}`,
      "",
      "[notebook]",
      `id = ${JSON.stringify(notebookId)}`,
      "",
      "[runtime]",
      `max_parallel_chunks = ${Number(maxParallelChunks || 3)}`,
      `download_outputs = ${downloadOutputs === false ? "false" : "true"}`,
    ];
    for (const [studioName, config] of Object.entries(studios || {})) {
      if (!config || !config.enabled) {
        continue;
      }
      lines.push("", `[studios.${studioName}]`, "enabled = true");
      if (config.perChunk !== false) {
        lines.push("per_chunk = true");
      }
      if (config.maxParallel) {
        lines.push(`max_parallel = ${Number(config.maxParallel)}`);
      }
      if (config.outputDir) {
        lines.push(`output_dir = ${JSON.stringify(config.outputDir)}`);
      }
      if (config.language) {
        lines.push(`language = ${JSON.stringify(config.language)}`);
      }
      if (config.format) {
        lines.push(`format = ${JSON.stringify(config.format)}`);
      }
      if (config.style) {
        lines.push(`style = ${JSON.stringify(config.style)}`);
      }
      if (config.stylePrompt) {
        lines.push(`style_prompt = ${JSON.stringify(config.stylePrompt)}`);
      }
      if (config.orientation) {
        lines.push(`orientation = ${JSON.stringify(config.orientation)}`);
      }
      if (config.detail) {
        lines.push(`detail = ${JSON.stringify(config.detail)}`);
      }
      if (config.length) {
        lines.push(`length = ${JSON.stringify(config.length)}`);
      }
      if (config.downloadFormat) {
        lines.push(`download_format = ${JSON.stringify(config.downloadFormat)}`);
      }
      if (config.quantity) {
        lines.push(`quantity = ${JSON.stringify(config.quantity)}`);
      }
      if (config.difficulty) {
        lines.push(`difficulty = ${JSON.stringify(config.difficulty)}`);
      }
      if (config.prompt) {
        lines.push('prompt = """', String(config.prompt).trim(), '"""');
      }
    }
    lines.push("");
    return lines.join("\n");
  }

  function parseNotebookId(output) {
    const match = String(output || "").match(/Notebook ID:\s*([a-f0-9-]+)/i);
    return match ? match[1].trim() : null;
  }

  // Parse a free-form skip-range string like "1-8, 12, 399-420" into a
  // normalized, sorted, overlap-merged list of inclusive [start, end] pairs.
  // Blank tokens are ignored; malformed tokens (non-numeric, zero/negative,
  // reversed) are dropped or corrected gracefully rather than throwing.
  function parseSkipRanges(input) {
    const source = Array.isArray(input) ? input.join(",") : input;
    const text = String(source == null ? "" : source);
    const ranges = [];
    for (const rawToken of text.split(/[,;\n]+/)) {
      const token = String(rawToken || "").trim();
      if (!token) continue;
      const single = token.match(/^(\d+)$/);
      const pair = token.match(/^(\d+)\s*-\s*(\d+)$/);
      let start;
      let end;
      if (single) {
        start = Number(single[1]);
        end = start;
      } else if (pair) {
        start = Number(pair[1]);
        end = Number(pair[2]);
        if (start > end) {
          const swap = start;
          start = end;
          end = swap;
        }
      } else {
        continue;
      }
      if (!(start >= 1) || !(end >= 1)) continue;
      ranges.push([start, end]);
    }
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const [start, end] of ranges) {
      const last = merged[merged.length - 1];
      if (last && start <= last[1] + 1) {
        last[1] = Math.max(last[1], end);
      } else {
        merged.push([start, end]);
      }
    }
    return merged;
  }

  // Convert normalized [start, end] pairs into `nblm --skip-range` CLI tokens,
  // collapsing single-page ranges to a bare page number ("12" instead of "12-12").
  function skipRangesToArgs(ranges) {
    return (Array.isArray(ranges) ? ranges : []).map(([start, end]) =>
      start === end ? String(start) : `${start}-${end}`,
    );
  }

  // Count the number of distinct pages that will be excluded from a document of
  // `totalPages`, given leading/trailing skip counts and mid-document ranges.
  // Overlaps between the three sources are counted only once.
  function countSkippedPages({ totalPages = 0, skipStart = 0, skipEnd = 0, ranges = [] } = {}) {
    const total = Math.max(0, Math.floor(Number(totalPages) || 0));
    if (total <= 0) return 0;
    const intervals = [];
    const lead = Math.max(0, Math.floor(Number(skipStart) || 0));
    const tail = Math.max(0, Math.floor(Number(skipEnd) || 0));
    if (lead > 0) intervals.push([1, Math.min(lead, total)]);
    if (tail > 0) intervals.push([Math.max(1, total - tail + 1), total]);
    for (const range of Array.isArray(ranges) ? ranges : []) {
      if (!Array.isArray(range)) continue;
      const start = Math.max(1, Math.floor(Number(range[0]) || 0));
      const end = Math.min(total, Math.floor(Number(range[1]) || 0));
      if (start >= 1 && end >= start) intervals.push([start, end]);
    }
    intervals.sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let lastEnd = 0;
    for (const [start, end] of intervals) {
      const from = Math.max(start, lastEnd + 1);
      if (end >= from) {
        covered += end - from + 1;
        lastEnd = end;
      }
    }
    return covered;
  }

  // Remove a leading section-number token (e.g. "4.4.2.13", "1.1", "12)", "3.5 -")
  // from a chunk title. Conservative: only strips when a numbering token is
  // followed by whitespace and real content remains; otherwise returns the input.
  function stripLeadingNumbering(title) {
    const original = String(title == null ? "" : title).trim();
    const stripped = original
      .replace(/^\d+(?:\.\d+)*(?:[.)])?(?:\s*[-–—:.)])?\s+/, "")
      .trim();
    return stripped.length > 0 ? stripped : original;
  }

  const TITLE_SMALL_WORDS = new Set([
    "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "nor",
    "of", "on", "or", "per", "the", "to", "vs", "via", "with",
  ]);

  function capitalizeToken(token) {
    if (!token) return token;
    return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
  }

  // Normalize messy / ALL-CAPS titles to Title Case. Conservative: leaves titles
  // that already contain lowercase letters untouched (to preserve acronyms and
  // intentional casing like "iOS" or "DDD"); only collapses whitespace and
  // title-cases strings that are entirely uppercase.
  function normalizeTitleCase(title) {
    const collapsed = String(title == null ? "" : title).replace(/\s+/g, " ").trim();
    if (!collapsed) return "";
    const letters = collapsed.replace(/[^A-Za-z]/g, "");
    if (letters.length === 0 || /[a-z]/.test(letters)) {
      return collapsed;
    }
    const words = collapsed.split(" ");
    return words
      .map((word, index) => {
        const lower = word.toLowerCase();
        const isEdge = index === 0 || index === words.length - 1;
        if (!isEdge && TITLE_SMALL_WORDS.has(lower)) {
          return lower;
        }
        return word.split("-").map(capitalizeToken).join("-");
      })
      .join(" ");
  }

  const exported = {
    escapeHtml,
    attrArg,
    matchesQuery,
    slugifyStem,
    nextVersionRawName,
    deriveProjectStatus,
    buildStudiosToml,
    parseNotebookId,
    parseSkipRanges,
    skipRangesToArgs,
    countSkippedPages,
    stripLeadingNumbering,
    normalizeTitleCase,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = exported;
  }
  globalScope.projectUtils = exported;
})(typeof globalThis !== "undefined" ? globalThis : window);
