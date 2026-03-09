# Story 9: The Command Center (Dashboard & Sidebar)

## Business Need
Users need a central hub to manage their long-term knowledge library. Instead of a linear wizard that starts from scratch every time, the app should remember past projects, allow resuming interrupted syncs, and provide quick access to generated Studio outputs (podcasts, guides).

## UI Elements & Interactions
- **Apple-Style Sidebar (Persistent):**
    - **Top Section:** "New Project" button (Primary action, SF Symbol: `plus.square.fill`).
    - **Main Nav:** "Dashboard" (Home), "My Library" (All Projects), "Studio Gallery" (Generated Files).
    - **Bottom Section:** "System Health" (Doctor status), "Settings", and "User Profile".
- **The Dashboard (Main Area):**
    - **Welcome Hero:** A personalized greeting ("Welcome back, Cemal") with a search bar to find past documents.
    - **Recent Projects Grid/List:** A high-quality list showing:
        - Document Title & Format Icon.
        - Status Badge (e.g., "Refined", "Synced to NotebookLM", "Studio Ready").
        - Date of last activity.
        - Progress Bar (if still in progress).
    - **Quick Stats Cards:** "Total Chunks Created", "Notebooks Synced", "Studio Hours Generated".
- **Interactions:**
    - Clicking a "Recent Project" instantly loads that project's state and takes the user to the appropriate step (e.g., if it was refined but not synced, open the Sync view).

## Designer Notes (Apple Minimalism)
- **Layout Shift:** Move from the current "Top Navigation" to a "Fixed Sidebar" on the left.
- **Vibrancy (Sidebar):** The sidebar should use macOS-style translucency (vibrancy/glassmorphism).
- **Empty State:** If no projects exist, show a beautiful "Start your knowledge journey" illustration with a big "Add your first PDF" button.
- **Typography:** Use large, bold titles for the Dashboard sections to give it a "News" or "Library" feel.
