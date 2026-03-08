# Story 4: NotebookLM Sync & Authentication

## Business Need
Connect to Google/NotebookLM. The goal is to make "Syncing" feel like a background utility, not a chore.

## UI Elements & Interactions
- **Profile Card:** A small, rounded pill in the corner showing the user's avatar or email.
- **The "Magic" Sync Button:** A large "Upload to NotebookLM" button with a loading spinner that fills the button itself.
- **Inline Notebook Selector:** A dropdown that feels like a native macOS menu.
- **Progress Ring:** A sleek circular progress indicator for each chunk in the list.

## Designer Notes (Apple Minimalism)
- **Transitions:** When uploading starts, the UI should smoothly transition to a "Status" view.
- **Minimalist Feedback:** Use small, colored dots for status (Green = Done, Blue = Uploading, Orange = Waiting).
