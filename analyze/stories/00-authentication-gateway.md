# Story 0: Authentication & Account Gateway

## Business Need
NotebookLM requires a valid Google session to accept uploads and generate Studio outputs. Since the entire app revolves around this integration, the user must be "Connected" before they can start any heavy processing. This maps to the `nblm login` command.

## UI Elements & Interactions
- **The "Welcome" Screen:** A beautiful, centered splash screen that appears if the user is not authenticated.
- **"Sign in to NotebookLM" Button:** A large, prominent button that triggers the automated browser login (Playwright).
- **Security Trust Note:** A small, faded text explaining that "Your credentials are never stored locally; we use a secure browser session."
- **Login Status Indicator:** A pulsing "Waiting for Login..." status while the browser window is open.
- **Success State:** Once authenticated, the screen elegantly "dissolves" or slides away to reveal the main Dashboard.

## Designer Notes (Apple Minimalism)
- **Focused Experience:** Do not show any other features (Upload, History, etc.) until the user is logged in. This reduces cognitive load.
- **Visual Warmth:** Use a soft gradient background or a high-quality "Notebook" illustration to make the login feel like the start of a creative process.
- **Feedback:** If the login window is closed without success, show a gentle "Sign-in was cancelled" toast notification.
