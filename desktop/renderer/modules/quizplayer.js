/* ------------------------------------------------------------------ *
 * Interactive quiz player (roadmap B6)
 *
 * Launched from a quiz artifact via artifacts.js (openQuizPlayer, which resolves
 * the local quiz file, reads it with electronAPI.readFile, and parses it with
 * parseQuizQuestions). The player receives already-normalized questions:
 *
 *   { text, options: [{ text, correct }], correctIndex, answerText, explanation }
 *
 * options is [] for open-ended questions (revealed, but not scored). All
 * question-derived text is escaped with escapeHtml before it touches innerHTML —
 * nothing raw is ever injected. The overlay DOM is built entirely in JS; the only
 * external dependency is quizplayer.css (which the integrator links in index.html).
 * ------------------------------------------------------------------ */

import { escapeHtml, applyOfflineIcons } from "./dom.js";
import { parseQuizQuestions } from "./artifacts.js";

let activeSession = null;

function isScorable(question) {
  return Array.isArray(question.options) && question.options.length > 0;
}

function scorableCount(questions) {
  return questions.reduce((total, question) => total + (isScorable(question) ? 1 : 0), 0);
}

// Build the overlay shell once and cache it on the session.
function buildOverlay() {
  const overlay = document.createElement("div");
  overlay.className = "quizplayer-overlay hidden";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Quiz player");

  const card = document.createElement("div");
  card.className = "quizplayer-card";
  overlay.appendChild(card);

  const header = document.createElement("div");
  header.className = "quizplayer-header";
  header.innerHTML = `
    <div class="quizplayer-heading">
      <h3 class="quizplayer-title"></h3>
      <p class="quizplayer-progress"></p>
    </div>
    <button type="button" class="quizplayer-close" aria-label="Close quiz">
      <span class="material-symbols-outlined" data-icon-name="close">close</span>
    </button>`;
  card.appendChild(header);

  const bar = document.createElement("div");
  bar.className = "quizplayer-progressbar";
  bar.innerHTML = '<div class="quizplayer-progressbar-fill"></div>';
  card.appendChild(bar);

  const body = document.createElement("div");
  body.className = "quizplayer-body";
  card.appendChild(body);

  const footer = document.createElement("div");
  footer.className = "quizplayer-footer";
  footer.innerHTML = `
    <p class="quizplayer-score"></p>
    <button type="button" class="quizplayer-next" disabled>Next</button>`;
  card.appendChild(footer);

  return overlay;
}

function closeSession() {
  const session = activeSession;
  if (!session) return;
  document.removeEventListener("keydown", session.onKeyDown, true);
  if (session.overlay && session.overlay.parentNode) {
    session.overlay.parentNode.removeChild(session.overlay);
  }
  activeSession = null;
}

// --- Question screen --------------------------------------------------------
function renderQuestion(session) {
  const { questions, index } = session;
  const question = questions[index];
  const body = session.body;
  const scorable = isScorable(question);
  session.answered = false;
  session.selectedIndex = -1;

  session.title.textContent = session.quizTitle;
  session.progress.textContent = `Question ${index + 1} of ${questions.length}`;
  session.progressFill.style.width = `${Math.round((index / questions.length) * 100)}%`;
  session.score.textContent = session.correctCount > 0 || session.answeredScorable > 0
    ? `Score: ${session.correctCount}/${session.answeredScorable}`
    : "";

  const optionsHtml = scorable
    ? question.options
        .map(
          (option, optionIndex) => `
          <button type="button" class="quizplayer-option" data-option-index="${optionIndex}">
            <span class="quizplayer-option-key">${optionIndex < 9 ? optionIndex + 1 : "•"}</span>
            <span class="quizplayer-option-text">${escapeHtml(option.text)}</span>
            <span class="quizplayer-option-mark" aria-hidden="true"></span>
          </button>`,
        )
        .join("")
    : `<div class="quizplayer-openended">
         <p class="quizplayer-openended-hint">Open-ended question — reveal the answer when ready.</p>
         <button type="button" class="quizplayer-reveal">Reveal answer</button>
       </div>`;

  body.innerHTML = `
    <p class="quizplayer-question">${escapeHtml(question.text)}</p>
    <div class="quizplayer-options">${optionsHtml}</div>
    <div class="quizplayer-feedback hidden"></div>`;

  session.next.disabled = true;
  session.next.textContent = index + 1 >= questions.length ? "Finish" : "Next";

  if (scorable) {
    body.querySelectorAll(".quizplayer-option").forEach((btn) => {
      btn.addEventListener("click", () => selectOption(session, Number(btn.dataset.optionIndex)));
    });
  } else {
    const reveal = body.querySelector(".quizplayer-reveal");
    if (reveal) reveal.addEventListener("click", () => revealOpenEnded(session));
  }
}

function selectOption(session, optionIndex) {
  if (session.answered) return;
  const question = session.questions[session.index];
  if (!isScorable(question)) return;
  session.answered = true;
  session.selectedIndex = optionIndex;

  const correctIndex = question.correctIndex;
  const isCorrect = optionIndex === correctIndex;
  session.answeredScorable += 1;
  if (isCorrect) session.correctCount += 1;

  const buttons = session.body.querySelectorAll(".quizplayer-option");
  buttons.forEach((btn) => {
    const idx = Number(btn.dataset.optionIndex);
    btn.disabled = true;
    if (idx === correctIndex) btn.classList.add("is-correct");
    if (idx === optionIndex && !isCorrect) btn.classList.add("is-incorrect");
    if (idx === optionIndex) btn.classList.add("is-selected");
  });

  const feedback = session.body.querySelector(".quizplayer-feedback");
  if (feedback) {
    const correctText = correctIndex >= 0 && question.options[correctIndex]
      ? question.options[correctIndex].text
      : question.answerText;
    const parts = [
      `<p class="quizplayer-feedback-status ${isCorrect ? "is-correct" : "is-incorrect"}">${
        isCorrect ? "Correct" : "Incorrect"
      }</p>`,
    ];
    if (!isCorrect && correctText) {
      parts.push(`<p class="quizplayer-feedback-answer"><span>Correct answer:</span> ${escapeHtml(correctText)}</p>`);
    }
    if (question.explanation) {
      parts.push(`<p class="quizplayer-feedback-explanation">${escapeHtml(question.explanation)}</p>`);
    }
    feedback.innerHTML = parts.join("");
    feedback.classList.remove("hidden");
  }

  session.score.textContent = `Score: ${session.correctCount}/${session.answeredScorable}`;
  session.next.disabled = false;
  session.next.focus();
}

function revealOpenEnded(session) {
  if (session.answered) return;
  const question = session.questions[session.index];
  session.answered = true;
  const reveal = session.body.querySelector(".quizplayer-reveal");
  if (reveal) reveal.disabled = true;

  const feedback = session.body.querySelector(".quizplayer-feedback");
  if (feedback) {
    const parts = ['<p class="quizplayer-feedback-status is-neutral">Answer</p>'];
    if (question.answerText) {
      parts.push(`<p class="quizplayer-feedback-answer">${escapeHtml(question.answerText)}</p>`);
    } else {
      parts.push('<p class="quizplayer-feedback-answer">No answer was provided for this question.</p>');
    }
    if (question.explanation) {
      parts.push(`<p class="quizplayer-feedback-explanation">${escapeHtml(question.explanation)}</p>`);
    }
    feedback.innerHTML = parts.join("");
    feedback.classList.remove("hidden");
  }
  session.next.disabled = false;
  session.next.focus();
}

function advance(session) {
  if (!session.answered) return;
  if (session.index + 1 >= session.questions.length) {
    renderSummary(session);
    return;
  }
  session.index += 1;
  renderQuestion(session);
}

// --- Summary screen ---------------------------------------------------------
function renderSummary(session) {
  const total = session.totalScorable;
  const pct = total > 0 ? Math.round((session.correctCount / total) * 100) : 0;
  session.progress.textContent = "Complete";
  session.progressFill.style.width = "100%";
  session.score.textContent = "";

  const headline = total > 0
    ? `You scored ${session.correctCount} out of ${total}`
    : "Quiz complete";
  const subline = total > 0
    ? `${pct}% correct`
    : "This quiz had no scorable questions.";

  session.body.innerHTML = `
    <div class="quizplayer-summary">
      <div class="quizplayer-summary-score" data-pct="${pct}">
        <span class="quizplayer-summary-fraction">${total > 0 ? `${session.correctCount}/${total}` : "—"}</span>
        <span class="quizplayer-summary-pct">${total > 0 ? `${pct}%` : ""}</span>
      </div>
      <p class="quizplayer-summary-headline">${escapeHtml(headline)}</p>
      <p class="quizplayer-summary-subline">${escapeHtml(subline)}</p>
      <div class="quizplayer-summary-actions">
        <button type="button" class="quizplayer-retry">Retry</button>
        <button type="button" class="quizplayer-done">Close</button>
      </div>
    </div>`;

  session.next.disabled = true;
  session.next.classList.add("hidden");

  const retry = session.body.querySelector(".quizplayer-retry");
  const done = session.body.querySelector(".quizplayer-done");
  if (retry) retry.addEventListener("click", () => restart(session));
  if (done) done.addEventListener("click", closeSession);
}

function restart(session) {
  session.index = 0;
  session.correctCount = 0;
  session.answeredScorable = 0;
  session.answered = false;
  session.next.classList.remove("hidden");
  renderQuestion(session);
}

// --- Keyboard navigation (1-9 to pick, Enter for next, Esc to close) --------
function handleKeyDown(session, event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeSession();
    return;
  }
  if (event.key === "Enter") {
    if (!session.next.classList.contains("hidden") && !session.next.disabled) {
      event.preventDefault();
      advance(session);
    }
    return;
  }
  if (/^[1-9]$/.test(event.key) && !session.answered) {
    const question = session.questions[session.index];
    if (!isScorable(question)) return;
    const optionIndex = Number(event.key) - 1;
    if (optionIndex < question.options.length) {
      event.preventDefault();
      selectOption(session, optionIndex);
    }
  }
}

// --- Public entry point -----------------------------------------------------
// `questions` may be an already-normalized array (the usual path, produced by
// artifacts.js) or a raw quiz-JSON string, which we normalize here with the
// shared parser so both callers go through identical key-variant handling.
function launchQuizPlayer(questions, quizTitle) {
  const normalized = typeof questions === "string" ? parseQuizQuestions(questions) : questions;
  const list = Array.isArray(normalized) ? normalized.filter((q) => q && q.text) : [];
  if (list.length === 0) return;

  closeSession();

  const overlay = buildOverlay();
  document.body.appendChild(overlay);

  const session = {
    overlay,
    body: overlay.querySelector(".quizplayer-body"),
    title: overlay.querySelector(".quizplayer-title"),
    progress: overlay.querySelector(".quizplayer-progress"),
    progressFill: overlay.querySelector(".quizplayer-progressbar-fill"),
    score: overlay.querySelector(".quizplayer-score"),
    next: overlay.querySelector(".quizplayer-next"),
    questions: list,
    quizTitle: quizTitle || "Quiz",
    index: 0,
    correctCount: 0,
    answeredScorable: 0,
    totalScorable: scorableCount(list),
    answered: false,
    selectedIndex: -1,
  };
  activeSession = session;

  session.onKeyDown = (event) => handleKeyDown(session, event);
  document.addEventListener("keydown", session.onKeyDown, true);

  overlay.querySelector(".quizplayer-close").addEventListener("click", closeSession);
  session.next.addEventListener("click", () => advance(session));
  // Click on the dimmed backdrop (not the card) closes the player.
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) closeSession();
  });

  applyOfflineIcons(overlay);

  overlay.classList.remove("hidden");
  renderQuestion(session);
}

export { launchQuizPlayer };

// Self-register (app.js is off-limits; other modules use this pattern too).
if (typeof window !== "undefined") {
  window.launchQuizPlayer = launchQuizPlayer;
}
