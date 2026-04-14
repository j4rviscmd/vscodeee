# Deprecated: Electron Test Runner

This directory contains the **Electron-based unit test runner** from the upstream
VS Code repository. It is preserved for reference but **must not be used** in the
Tauri build.

## Why deprecated?

The VS Codeee project is migrating from Electron to **Tauri 2.0**. The test
infrastructure here relies on Electron-specific APIs (`BrowserWindow`,
`ipcMain`, `contextBridge`, `webFrame`, etc.) that have no equivalents in Tauri.

## Replacement

Unit tests should be run via the **Node.js test runner** (`test/unit/node/`) or
directly with `scripts/test.sh`. The Tauri WebView runtime is tested through
integration/e2e tests that launch the actual application.

## Removal timeline

This directory can be deleted once a Tauri-native test infrastructure is in
place (Phase 6+ of the migration).

## Files

| File | Purpose |
| --- | --- |
| `index.js` | Electron main process — creates `BrowserWindow`, runs mocha via IPC |
| `preload.js` | Electron preload — exposes `ipcRenderer`, `webFrame`, `process` to renderer |
| `renderer.html` | HTML shell loaded in the Electron renderer for test execution |
| `renderer.js` | Renderer-side mocha bootstrap |
