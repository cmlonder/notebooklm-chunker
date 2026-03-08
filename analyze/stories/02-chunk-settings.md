# Story 2: Chunking Strategy & Intelligence

## Business Need
Configure how the document is sliced. We want to avoid "Control Panel Fatigue" by using smart defaults.

## UI Elements & Interactions
- **The "Smart Mode" Toggle:** A primary switch that hides all sliders and uses the engine's best-guess defaults.
- **Elegant Sliders:** Thin, rounded sliders for "Target Length" (maps to `chunking.target_pages`).
- **Segmented Control:** A "Preset" selector: [Concise] [Balanced] [Detailed].
- **Live Label:** A tiny, faded text at the bottom: "This will create approximately 12 chunks."

## Designer Notes (Apple Minimalism)
- **San Francisco Typography:** Use different weights (Bold for labels, Regular for descriptions).
- **Subtle Feedback:** Sliders should have a smooth animation.
- **Hidden Complexity:** Place "Words per Page" and "Min/Max" under an "Advanced" collapsible section.
