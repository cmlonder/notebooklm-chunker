import { appState, summarizeStudioOutputs, studioIconNames } from "./state.js";
import { matchesQuery, showToast, escapeHtml, applyOfflineIcons } from "./dom.js";
import { prepareStudioView } from "./studio.js";

function artifactKindToStudio(kind) {
  const normalized = String(kind || "").toLowerCase();
  if (normalized.includes("slide")) return "slide_deck";
  if (normalized.includes("flash")) return "flashcards";
  if (normalized.includes("audio") || normalized.includes("podcast")) return "audio";
  if (normalized.includes("quiz")) return "quiz";
  if (normalized.includes("report")) return "report";
  return normalized;
}

function normalizedArtifactStatus(status) {
  if (typeof status === "string" && status.trim()) {
    return status.trim().toLowerCase();
  }
  if (typeof status === "number") {
    const mapped = {
      0: "queued",
      1: "processing",
      2: "processing",
      3: "ready",
      4: "failed",
    };
    return mapped[status] || "ready";
  }
  return "ready";
}

function filteredStudioArtifacts() {
  const query = appState.studioArtifactsSearchQuery;
  return (appState.studioArtifacts || []).filter((item) => {
    if (artifactKindToStudio(item.kind) !== appState.studioArtifactsTab) return false;
    return matchesQuery(item.title, query)
      || matchesQuery(item.kind, query)
      || matchesQuery(item.status, query);
  });
}

async function loadStudioArtifacts(force = false) {
  if (!appState.dashboardNotebookId) {
    appState.studioArtifacts = [];
    return;
  }
  if (appState.studioArtifactsLoading) return;
  if (!force && Array.isArray(appState.studioArtifacts) && appState.studioArtifacts.length > 0) return;
  appState.studioArtifactsLoading = true;
  try {
    const result = await window.electronAPI.runNBLM({
      command: "list-artifacts",
      args: ["--notebook-id", appState.dashboardNotebookId],
    });
    if (result.success) {
      appState.studioArtifacts = JSON.parse(result.output || "[]");
    }
  } catch (error) {
    appState.studioArtifacts = [];
  } finally {
    appState.studioArtifactsLoading = false;
    if (appState.notebookWorkspaceTab === "studios") {
      prepareStudioView();
    }
  }
}

function selectStudioArtifactsTab(studioName) {
  appState.studioArtifactsTab = studioName;
  appState.selectedStudioArtifactIds = new Set();
  prepareStudioView();
}

function toggleStudioArtifactSelection(artifactId) {
  if (appState.deletingStudioArtifacts) return;
  if (appState.selectedStudioArtifactIds.has(artifactId)) {
    appState.selectedStudioArtifactIds.delete(artifactId);
  } else {
    appState.selectedStudioArtifactIds.add(artifactId);
  }
  prepareStudioView();
}

async function deleteSelectedStudioArtifacts() {
  if (!appState.dashboardNotebookId || appState.selectedStudioArtifactIds.size === 0 || appState.deletingStudioArtifacts) return;
  appState.deletingStudioArtifacts = true;
  prepareStudioView();
  try {
    const result = await window.electronAPI.runNBLM({
      command: "delete-artifacts",
      args: [
        "--notebook-id",
        appState.dashboardNotebookId,
        ...Array.from(appState.selectedStudioArtifactIds).flatMap((artifactId) => ["--artifact-id", artifactId]),
      ],
    });
    if (!result.success) {
      throw new Error(result.error || result.output || "Could not delete selected Studio items.");
    }
    appState.selectedStudioArtifactIds = new Set();
    await loadStudioArtifacts(true);
    showToast("Selected Studio items deleted.");
  } catch (error) {
    alert(error.message);
  } finally {
    appState.deletingStudioArtifacts = false;
    prepareStudioView();
  }
}

/* ------------------------------------------------------------------ *
 * Artifact previewer (roadmap B5)
 *
 * Studio outputs are downloaded next to each local run (report.md, quiz.json,
 * flashcards.md, data-table.csv, audio-overview.mp4, slide-deck.pdf, ...). The
 * remote Studio list only carries {id, title, kind, status}; we resolve the
 * matching *local* file from the run-state, read it with electronAPI.readFile,
 * and render it by type inside the shared #preview-modal shell. Nothing is ever
 * fetched over the network — if no local file exists we show a graceful state.
 * ------------------------------------------------------------------ */

const AUDIO_EXTENSIONS = new Set(["mp3", "mp4", "m4a", "wav", "ogg", "aac", "flac"]);
const BINARY_EXTENSIONS = new Set(["pptx", "ppt", "pdf", "png", "jpg", "jpeg", "gif", "webp", "docx", "xlsx", "key", "zip"]);

function artifactFileExtension(filePath) {
  const base = String(filePath || "").split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

// Resolve the local, already-downloaded file for a remote Studio artifact by
// matching studio type + (best-effort) remote title against the run-state of the
// notebook's local lineages. Returns { path, output } or null.
function resolveLocalArtifactPath(artifact, studioName) {
  const notebookId = appState.dashboardNotebookId;
  const projects = (appState.localProjects || []).filter(
    (project) => (project.metadata && project.metadata.notebook_id) === notebookId,
  );
  // Search the currently focused lineage first.
  projects.sort((a, b) => {
    if (a.path === appState.dashboardProjectPath) return -1;
    if (b.path === appState.dashboardProjectPath) return 1;
    return 0;
  });
  const title = String(artifact.title || "").trim().toLowerCase();
  let firstCandidate = null;
  for (const project of projects) {
    const outputs = summarizeStudioOutputs(project.runState || {}).filter(
      (output) => output.studioName === studioName && output.outputPath,
    );
    if (outputs.length === 0) continue;
    if (title) {
      const exact = outputs.find(
        (output) => String(output.remoteTitle || "").trim().toLowerCase() === title,
      );
      if (exact) return { path: exact.outputPath, output: exact };
      const partial = outputs.find((output) => {
        const remote = String(output.remoteTitle || "").trim().toLowerCase();
        return remote && (remote.includes(title) || title.includes(remote));
      });
      if (partial) return { path: partial.outputPath, output: partial };
    }
    if (!firstCandidate) firstCandidate = outputs[0];
  }
  return firstCandidate ? { path: firstCandidate.outputPath, output: firstCandidate } : null;
}

async function localFileExists(filePath) {
  const idx = String(filePath).lastIndexOf("/");
  const dir = idx >= 0 ? filePath.slice(0, idx) : ".";
  const name = idx >= 0 ? filePath.slice(idx + 1) : filePath;
  try {
    const result = await window.electronAPI.readDir(dir);
    return Boolean(result && result.success && Array.isArray(result.files) && result.files.includes(name));
  } catch (error) {
    return false;
  }
}

// --- Small, safe Markdown renderer ------------------------------------------
// escapeHtml() is applied FIRST so every artifact-derived character is inert;
// Markdown control chars (* _ ` # - > [ ]) survive escaping, so formatting is
// then layered onto the already-escaped text. No raw HTML can ever reach innerHTML.
function escapeMarkdown(value) {
  return escapeHtml(String(value == null ? "" : value));
}

function formatInlineMarkdown(escaped) {
  let text = escaped;
  // Inline code first so its contents are shielded from the emphasis passes.
  text = text.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  // Links: only http(s)/mailto are allowed; anything else is left as literal text.
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) =>
    /^(https?:|mailto:)/i.test(url)
      ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : match,
  );
  text = text.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__([^_]+?)__/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*\s][^*]*?)\*/g, "<em>$1</em>");
  text = text.replace(/(^|[\s(])_([^_]+?)_(?=[\s).,!?]|$)/g, "$1<em>$2</em>");
  return text;
}

function markdownToSafeHtml(raw) {
  const lines = escapeMarkdown(raw).split(/\r?\n/);
  const html = [];
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${formatInlineMarkdown(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```/);
    if (fence) {
      flushParagraph();
      const code = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // consume closing fence
      html.push(`<pre class="artifact-code"><code>${code.join("\n")}</code></pre>`);
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushParagraph();
      i += 1;
      continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      html.push("<hr>");
      i += 1;
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      html.push(`<h${level}>${formatInlineMarkdown(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      html.push(`<blockquote>${formatInlineMarkdown(quote.join(" "))}</blockquote>`);
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      flushParagraph();
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i += 1;
      }
      html.push(`<ul>${items.map((item) => `<li>${formatInlineMarkdown(item)}</li>`).join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushParagraph();
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i += 1;
      }
      html.push(`<ol>${items.map((item) => `<li>${formatInlineMarkdown(item)}</li>`).join("")}</ol>`);
      continue;
    }
    paragraph.push(line.trim());
    i += 1;
  }
  flushParagraph();
  return html.join("\n");
}

function inlineMarkdownText(value) {
  return formatInlineMarkdown(escapeMarkdown(value));
}

function renderRawArtifact(content) {
  return `<pre class="artifact-raw">${escapeHtml(String(content == null ? "" : content))}</pre>`;
}

// --- Quiz -------------------------------------------------------------------
function quizOptionText(option) {
  if (option && typeof option === "object") {
    return String(option.text ?? option.option ?? option.label ?? option.value ?? option.answer ?? option.title ?? "");
  }
  return String(option ?? "");
}

function quizOptionMarkedCorrect(option) {
  return Boolean(
    option
      && typeof option === "object"
      && (option.correct === true || option.is_correct === true || option.isCorrect === true || option.correct === "true"),
  );
}

function letterToIndex(value) {
  const single = String(value).trim();
  return /^[A-Za-z]$/.test(single) ? single.toUpperCase().charCodeAt(0) - 65 : -1;
}

function optionMatchesAnswer(optionText, optionIndex, answer) {
  if (answer == null || answer === "") return false;
  const answers = Array.isArray(answer) ? answer : [answer];
  return answers.some((candidate) => {
    if (typeof candidate === "number") return candidate === optionIndex || candidate - 1 === optionIndex;
    if (candidate && typeof candidate === "object") {
      return quizOptionText(candidate).trim().toLowerCase() === String(optionText).trim().toLowerCase();
    }
    const text = String(candidate).trim();
    if (!text) return false;
    if (text.toLowerCase() === String(optionText).trim().toLowerCase()) return true;
    if (/^\d+$/.test(text) && (Number(text) === optionIndex || Number(text) - 1 === optionIndex)) return true;
    const letter = letterToIndex(text);
    return letter >= 0 && letter === optionIndex;
  });
}

function quizAnswerText(answer, options) {
  if (answer == null || answer === "") return "";
  if (Array.isArray(answer)) {
    return answer.map((item) => quizAnswerText(item, options)).filter(Boolean).join(", ");
  }
  if (typeof answer === "object") return quizOptionText(answer);
  const text = String(answer).trim();
  const letter = letterToIndex(text);
  if (letter >= 0 && options[letter] != null) return quizOptionText(options[letter]);
  if (/^\d+$/.test(text)) {
    if (options[Number(text)] != null) return quizOptionText(options[Number(text)]);
    if (options[Number(text) - 1] != null) return quizOptionText(options[Number(text) - 1]);
  }
  return text;
}

function renderQuizArtifact(content) {
  let data;
  try {
    data = JSON.parse(content);
  } catch (error) {
    return renderRawArtifact(content);
  }
  const questions = Array.isArray(data)
    ? data
    : Array.isArray(data && data.questions)
    ? data.questions
    : Array.isArray(data && data.quiz)
    ? data.quiz
    : Array.isArray(data && data.items)
    ? data.items
    : [];
  if (questions.length === 0) return renderRawArtifact(content);
  const items = questions.map((question) => {
    const text = (question && (question.question ?? question.prompt ?? question.text ?? question.title)) ?? "";
    const rawOptions = (question && (question.options ?? question.choices ?? question.answers ?? question.alternatives)) ?? [];
    const options = Array.isArray(rawOptions) ? rawOptions : [];
    const answer = (question
      && (question.answer ?? question.correct ?? question.correctAnswer ?? question.correct_answer
        ?? question.correctOption ?? question.correct_option ?? question.solution
        ?? question.correctIndex ?? question.correct_index)) ?? null;
    const optionsHtml = options
      .map((option, index) => {
        const optionText = quizOptionText(option);
        const correct = quizOptionMarkedCorrect(option) || optionMatchesAnswer(optionText, index, answer);
        return `<li class="artifact-quiz-option${correct ? " is-correct" : ""}">${escapeHtml(optionText)}</li>`;
      })
      .join("");
    const answerText = quizAnswerText(answer, options);
    const explanation = question && (question.explanation ?? question.rationale ?? question.reason);
    return `
      <li class="artifact-quiz-item">
        <p class="artifact-quiz-question">${escapeHtml(String(text))}</p>
        ${optionsHtml ? `<ul class="artifact-quiz-options">${optionsHtml}</ul>` : ""}
        ${answerText ? `<p class="artifact-quiz-answer"><span>Answer:</span> ${escapeHtml(answerText)}</p>` : ""}
        ${explanation ? `<p class="artifact-quiz-explanation">${escapeHtml(String(explanation))}</p>` : ""}
      </li>`;
  });
  return `<ol class="artifact-quiz">${items.join("")}</ol>`;
}

// --- Flashcards -------------------------------------------------------------
function parseFlashcardMarkdown(content) {
  const labelPattern = /^\s*(?:[-*]\s*)?(?:\*\*)?\s*(front|back|q|a|question|answer|term|definition)\s*(?:\*\*)?\s*[:\-–]\s*(.*)$/i;
  const lines = String(content).split(/\r?\n/);
  const cards = [];
  let current = null;
  let sawLabels = false;
  const frontKeys = new Set(["front", "q", "question", "term"]);
  for (const line of lines) {
    const match = line.match(labelPattern);
    if (match) {
      sawLabels = true;
      const value = match[2].trim();
      if (frontKeys.has(match[1].toLowerCase())) {
        if (current && (current.front || current.back)) cards.push(current);
        current = { front: value, back: "" };
      } else {
        if (!current) current = { front: "", back: "" };
        current.back = current.back ? `${current.back}\n${value}` : value;
      }
    } else if (current && line.trim() && !/^\s*[-*_]{3,}\s*$/.test(line)) {
      if (current.back) current.back += `\n${line.trim()}`;
      else if (current.front) current.back = line.trim();
    }
  }
  if (current && (current.front || current.back)) cards.push(current);
  if (sawLabels && cards.length) return cards;

  const blocks = String(content)
    .split(/\n\s*(?:[-*_]{3,})\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (blocks.length > 1) {
    const paired = blocks
      .map((block) => {
        const rows = block.split(/\r?\n/).filter((row) => row.trim());
        return {
          front: (rows[0] || "").replace(/^[-*#>\s]+/, "").trim(),
          back: rows.slice(1).join("\n").trim(),
        };
      })
      .filter((card) => card.front || card.back);
    if (paired.length) return paired;
  }
  return null;
}

function renderFlashcardsArtifact(content, extension) {
  let cards = null;
  const trimmed = String(content).trim();
  if (extension === "json" || trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const data = JSON.parse(content);
      const list = Array.isArray(data)
        ? data
        : Array.isArray(data && data.cards)
        ? data.cards
        : Array.isArray(data && data.flashcards)
        ? data.flashcards
        : [];
      if (list.length) {
        cards = list.map((card) => ({
          front: card && (card.front ?? card.question ?? card.term ?? card.q ?? card.prompt) || "",
          back: card && (card.back ?? card.answer ?? card.definition ?? card.a ?? card.response) || "",
        }));
      }
    } catch (error) {
      cards = null;
    }
  }
  if (!cards) cards = parseFlashcardMarkdown(content);
  if (!cards || cards.length === 0) {
    return `<div class="artifact-markdown">${markdownToSafeHtml(content)}</div>`;
  }
  const rows = cards
    .map(
      (card) => `
      <div class="artifact-flashcard">
        <div class="artifact-flashcard-side">
          <span class="artifact-flashcard-label">Front</span>
          <div class="artifact-flashcard-text">${inlineMarkdownText(card.front)}</div>
        </div>
        <div class="artifact-flashcard-side">
          <span class="artifact-flashcard-label">Back</span>
          <div class="artifact-flashcard-text">${inlineMarkdownText(card.back)}</div>
        </div>
      </div>`,
    )
    .join("");
  return `<div class="artifact-flashcards">${rows}</div>`;
}

// --- CSV / data table -------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const source = String(text);
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => !(entry.length === 1 && entry[0] === ""));
}

function renderCsvArtifact(content) {
  const rows = parseCsv(content);
  if (rows.length === 0) return renderRawArtifact(content);
  const [header, ...body] = rows;
  const head = `<thead><tr>${header.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead>`;
  const bodyHtml = `<tbody>${body
    .map((cells) => `<tr>${header.map((_, index) => `<td>${escapeHtml(cells[index] ?? "")}</td>`).join("")}</tr>`)
    .join("")}</tbody>`;
  return `<div class="artifact-table-wrap"><table class="artifact-table">${head}${bodyHtml}</table></div>`;
}

// --- Audio / binary / empty states ------------------------------------------
function renderAudioArtifact(filePath) {
  const src = `file://${encodeURI(filePath)}`;
  return `
    <div class="artifact-audio">
      <audio controls preload="metadata" src="${escapeHtml(src)}"></audio>
      <p class="artifact-audio-note">Downloaded audio: ${escapeHtml(filePath)}</p>
      <p class="artifact-audio-note">If playback does not start, the file has still been saved to the path above.</p>
    </div>`;
}

function renderBinaryArtifact(filePath, studioName) {
  const name = String(filePath).split("/").pop() || filePath;
  return `
    <div class="artifact-empty">
      <span class="material-symbols-outlined artifact-empty-icon" data-icon-name="${escapeHtml(studioIconNames[studioName] || "description")}">${escapeHtml(studioIconNames[studioName] || "description")}</span>
      <p class="artifact-empty-title">Preview not available for this format</p>
      <p class="artifact-empty-text">${escapeHtml(name)} has been downloaded locally, but this format can't be shown inline. Open it directly from:</p>
      <p class="artifact-empty-path">${escapeHtml(filePath)}</p>
    </div>`;
}

function renderNotDownloadedArtifact(message) {
  return `
    <div class="artifact-empty">
      <span class="material-symbols-outlined artifact-empty-icon" data-icon-name="cloud_upload">cloud_upload</span>
      <p class="artifact-empty-title">Not downloaded locally</p>
      <p class="artifact-empty-text">${escapeHtml(
        message
          || "This Studio output has not been downloaded to your computer yet. Enable “Download outputs” when running Studio jobs to preview it here.",
      )}</p>
    </div>`;
}

function renderArtifactContent(studioName, extension, content) {
  if (studioName === "quiz") return renderQuizArtifact(content);
  if (studioName === "flashcards") return renderFlashcardsArtifact(content, extension);
  if (studioName === "report") return `<div class="artifact-markdown">${markdownToSafeHtml(content)}</div>`;
  if (studioName === "data_table" || extension === "csv") return renderCsvArtifact(content);
  if (extension === "json") return renderQuizArtifact(content);
  if (extension === "md" || extension === "markdown" || extension === "txt" || extension === "") {
    return `<div class="artifact-markdown">${markdownToSafeHtml(content)}</div>`;
  }
  return renderRawArtifact(content);
}

// Open the shared #preview-modal and render an artifact by type.
async function openArtifactPreview(artifact) {
  if (!artifact) return;
  const modal = document.getElementById("preview-modal");
  const title = document.getElementById("preview-modal-title");
  const meta = document.getElementById("preview-modal-meta");
  const body = document.getElementById("preview-modal-body");
  if (!modal || !title || !meta || !body) return;

  const studioName = artifactKindToStudio(artifact.kind);
  const statusLabel = normalizedArtifactStatus(artifact.status);
  title.textContent = artifact.title || "Studio artifact";
  meta.textContent = `${String(artifact.kind || studioName).replace(/_/g, " ")}${statusLabel ? ` · ${statusLabel}` : ""}`;
  body.innerHTML = '<div class="artifact-preview artifact-loading">Loading preview…</div>';
  modal.classList.remove("hidden");

  const setBody = (inner) => {
    body.innerHTML = `<div class="artifact-preview">${inner}</div>`;
    applyOfflineIcons(body);
  };

  const local = resolveLocalArtifactPath(artifact, studioName);
  if (!local || !local.path) {
    setBody(renderNotDownloadedArtifact());
    return;
  }
  const extension = artifactFileExtension(local.path);
  try {
    if (AUDIO_EXTENSIONS.has(extension)) {
      const exists = await localFileExists(local.path);
      setBody(exists ? renderAudioArtifact(local.path) : renderNotDownloadedArtifact());
      return;
    }
    if (BINARY_EXTENSIONS.has(extension)) {
      setBody(renderBinaryArtifact(local.path, studioName));
      return;
    }
    const result = await window.electronAPI.readFile(local.path);
    if (!result || !result.success) {
      setBody(
        renderNotDownloadedArtifact(
          "The local file for this artifact could not be read. It may have been moved or deleted.",
        ),
      );
      return;
    }
    setBody(renderArtifactContent(studioName, extension, result.content));
  } catch (error) {
    setBody(renderNotDownloadedArtifact("Something went wrong while loading this artifact."));
  }
}

// --- Entry point: inject a preview button into each Studio artifact row ------
// The rows themselves are rendered by studio.js (off-limits), so we observe the
// list container and augment freshly rendered rows. Ordering mirrors
// filteredStudioArtifacts(), the same source studio.js maps over.
function buildArtifactPreviewButton(artifact) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "artifact-preview-btn";
  button.title = "Preview artifact";
  button.setAttribute("aria-label", "Preview artifact");
  button.innerHTML = '<span class="material-symbols-outlined" data-icon-name="search">search</span>';
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void openArtifactPreview(artifact);
  });
  return button;
}

function augmentStudioArtifactRows(list) {
  const artifacts = filteredStudioArtifacts();
  const rows = list.querySelectorAll(":scope > div");
  let index = 0;
  rows.forEach((row) => {
    // Empty-state / loading rows have no checkbox and no matching artifact.
    if (!row.querySelector(".prompt-checkbox")) return;
    const artifact = artifacts[index];
    index += 1;
    if (!artifact) return;
    if (row.dataset.artifactPreviewReady === "1") return;
    row.dataset.artifactPreviewReady = "1";
    const actions = document.createElement("div");
    actions.className = "artifact-row-actions";
    const badge = row.lastElementChild;
    if (badge && badge.tagName === "SPAN") {
      row.insertBefore(actions, badge);
      actions.appendChild(badge);
    } else {
      row.appendChild(actions);
    }
    const button = buildArtifactPreviewButton(artifact);
    actions.appendChild(button);
    applyOfflineIcons(button);
  });
}

let artifactPreviewObserver = null;
function initArtifactPreview() {
  const list = document.getElementById("studio-generated-list");
  if (!list || artifactPreviewObserver) return;
  artifactPreviewObserver = new MutationObserver(() => augmentStudioArtifactRows(list));
  artifactPreviewObserver.observe(list, { childList: true });
  augmentStudioArtifactRows(list);
}

export {
  artifactKindToStudio,
  normalizedArtifactStatus,
  filteredStudioArtifacts,
  loadStudioArtifacts,
  selectStudioArtifactsTab,
  toggleStudioArtifactSelection,
  deleteSelectedStudioArtifacts,
  openArtifactPreview,
  initArtifactPreview,
};

// Self-register (app.js is off-limits; other modules use this pattern too).
if (typeof window !== "undefined") {
  window.openArtifactPreview = openArtifactPreview;
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initArtifactPreview, { once: true });
    } else {
      initArtifactPreview();
    }
  }
}
