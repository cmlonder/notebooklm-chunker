# Design Brief: NotebookLM Chunker Desktop

## 1. Project Overview
**NotebookLM Chunker** is a professional-grade tool designed to bridge the gap between long-form documents (PDFs, Books, Research Papers) and Google's **NotebookLM**. 

While NotebookLM is powerful, it has strict limits on source length and "context window" size. Our engine intelligently "chunks" these documents—not just by character count, but by **understanding headings, sections, and page structures**—ensuring that every piece uploaded is logically complete and perfectly optimized for AI analysis.

## 2. Design Philosophy: "The Apple Way"
The goal is to hide a complex, multi-stage data pipeline behind a "magical," effortless interface.
- **Minimalism:** If the user doesn't need to see a setting, hide it.
- **Progressive Disclosure:** Start with a "Void" (empty state). Show only the "Drop" zone. Once a file is added, reveal the next step.
- **Visual Breath:** High-contrast typography, generous padding, and a focus on the document content itself.
- **SF Symbols:** Use Apple’s system iconography for a native, trusted feel.
- **State-Driven UI:** The app should feel like a single-screen journey that evolves as the user progresses from "Source" to "Studio."

## 3. The Core Workflow (The Pipeline)
A successful design must guide the user through these four distinct phases:
1.  **Ingestion:** Drag-and-drop a file and define "clean" areas (skipping index/references).
2.  **Structuring:** The engine "slices" the document. The UI shows a preview of these slices (Chunks).
3.  **Synchronization:** Connecting to Google and watching the chunks "flow" into a Notebook.
4.  **Enrichment (Studio):** Generating the "Magic" outputs—Audio Deep Dives, Flashcards, and Briefings.

## 4. Technical Constraints (Hidden under the hood)
- **Engine:** Python-based CLI (`nblm`).
- **UI Framework:** Electron (Desktop).
- **Authentication:** Playwright-based browser automation (requires a "Doctor" view for status).
- **Persistence:** Local `manifest.json` and `.nblm-run-state.json` track progress.

## 5. Visual Identity
- **Primary Color:** Pure White / Subtle Light Gray (macOS system colors).
- **Accent Color:** System Blue (for primary actions) and Soft Orange (for warnings/quotas).
- **Material:** Heavy use of "Vibrancy" (translucent/glass backgrounds) common in modern macOS apps.
- **Typography:** San Francisco (SF Pro). Bold for headers, light/regular for body text.

## 6. How to use the Stories
The accompanying 9 stories (`00-authentication-gateway.md` through `08-error-recovery.md`) provide the specific UI components and interactions required for each screen. Treat them as a **functional roadmap** for the visual mockups.

---
**Goal:** Make the user feel like they are "polishing" their knowledge, not "processing" a file.
