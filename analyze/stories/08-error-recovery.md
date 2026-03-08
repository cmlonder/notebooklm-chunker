# Story 8: Error Recovery & Quota Management

## Business Need
Handling failures gracefully. Errors should feel like "helpful suggestions," not "scary warnings."

## UI Elements & Interactions
- **Non-Intrusive Toasts:** Small notifications that slide in from the top or bottom.
- **The "Fix" Modal:** A clean, centered dialog with two clear options: [Try Again] [Cancel].
- **"Smart Split" Button:** A specific action on a failed chunk that looks like a "Magic Wand" icon.

## Designer Notes (Apple Minimalism)
- **Avoid Alert Red:** Use a softer "Warning" orange unless it's a critical crash.
- **Simplified Language:** "We couldn't upload Chunk #5. Should we try again?" instead of "Socket Error: 403".
