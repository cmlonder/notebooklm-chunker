# NotebookLM Chunker Desktop

Desktop application for NotebookLM Chunker built with Electron.

## Prerequisites

1. **Node.js** (v18 or higher)
2. **notebooklm-chunker CLI** must be installed and available in PATH:
   ```bash
   pip install notebooklm-chunker
   ```

## Development

```bash
# Install dependencies
cd desktop
npm install

# Run in development mode
npm run dev
```

## Build

```bash
# Build for current platform
npm run build

# Build for specific platform
npm run build:mac
npm run build:win
npm run build:linux
```

## Features

- 📄 **Visual PDF Selection** - Drag & drop or browse
- ⚙️ **Easy Configuration** - GUI for all chunking settings
- 🎯 **Studio Selection** - Choose which outputs to generate
- 📊 **Real-time Progress** - See what's happening
- 📝 **Live Logs** - Terminal output in the app
- 🎨 **Dark Theme** - Easy on the eyes

## Architecture

```
desktop/
├── src/
│   ├── main.js       # Electron main process
│   └── preload.js    # IPC bridge
├── renderer/
│   ├── index.html    # UI
│   ├── styles.css    # Styling
│   └── app.js        # Frontend logic
└── package.json
```

## How It Works

1. User selects PDF and configures settings in the UI
2. App generates a temporary TOML config file
3. Spawns `nblm` CLI process with the config
4. Streams output to the UI in real-time
5. Shows progress and completion status

## Distribution

Built apps will be in `desktop/dist/`:
- **macOS**: `.dmg` and `.zip`
- **Windows**: `.exe` installer and portable
- **Linux**: `.AppImage` and `.deb`

## License

MIT
