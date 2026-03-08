# Story 1: Source Selection & PDF Filtering

## Business Need
Users need to import documents and define what to process. This should feel as simple as dropping a file into a folder.

## UI Elements & Interactions
- **The "Void" Drop Zone:** A large, clean area with a subtle border and an "Add" icon (SF Symbol: `plus.circle` or `doc.badge.plus`).
- **File List Card:** Once dropped, a sleek card showing the file name, size, and a "Format" icon.
- **Progressive Skip Ranges:** Instead of a complex list, a single "Exclude Pages" button that expands into a clean input field for "1-5, 12, 100-110".
- **Floating "Analyze" Button:** A prominent, rounded button that appears only when a valid file is loaded.

## Designer Notes (Apple Minimalism)
- **Glassmorphism:** Use a subtle blur effect for the background if possible.
- **Empty State:** Use a high-quality "Doc" icon and "Drag your file here" text with generous white space.
- **No Clutter:** Hide "Skip Ranges" under an "Options" chevron by default.
