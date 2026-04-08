<div align="center">

# VS Codeee

<img src="https://private-user-images.githubusercontent.com/127029311/575099407-08a22768-7403-420a-9eb3-a8348bd7b90a.png?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3NzU2Mzg3MjIsIm5iZiI6MTc3NTYzODQyMiwicGF0aCI6Ii8xMjcwMjkzMTEvNTc1MDk5NDA3LTA4YTIyNzY4LTc0MDMtNDIwYS05ZWIzLWE4MzQ4YmQ3YjkwYS5wbmc_WC1BbXotQWxnb3JpdGhtPUFXUzQtSE1BQy1TSEEyNTYmWC1BbXotQ3JlZGVudGlhbD1BS0lBVkNPRFlMU0E1M1BRSzRaQSUyRjIwMjYwNDA4JTJGdXMtZWFzdC0xJTJGczMlMkZhd3M0X3JlcXVlc3QmWC1BbXotRGF0ZT0yMDI2MDQwOFQwODUzNDJaJlgtQW16LUV4cGlyZXM9MzAwJlgtQW16LVNpZ25hdHVyZT1kZWMxZmUzOWM1ZDk1ZjY1M2Q1NDYxZjI4ZmU3MzVmMWI5YzNjYTA3MDgwZTNhNDk3OWEwNjVhYWY4YWU1ZjFkJlgtQW16LVNpZ25lZEhlYWRlcnM9aG9zdCJ9.kBaQim44lmWhsArbB3A9stskQC-tgNUpB5JgSXcdFOk" alt="VS Codeee Phase 1" width="600">

</div>

**A project to run VSCode with Tauri 2.0**
In the process of gradual migration with Opus 4.6 :robot:

## Purpose

Maintain the current functionality of VSCode while achieving the following:

- **Reduce memory usage**: Electron → Tauri 2.0 (native WebView instead of bundled Chromium)
- **Reduce unnecessary metrics**: Stop sending telemetry to Microsoft
- **Smaller binary size**: ~50% reduction expected without bundled Chromium

---

## Roadmap

> **Current Phase: Phase 2A — Functional File Editing** 🚧

| Phase  | Name                                                             | Goal                                                    |                            Status                             |
| :----: | ---------------------------------------------------------------- | ------------------------------------------------------- | :-----------------------------------------------------------: |
|   0    | [Feasibility Spike](#phase-0-feasibility-spike)                  | Validate Tauri can host VS Code                         | [✅ Complete](https://github.com/j4rviscmd/vscodeee/issues/7) |
|   1    | [Foundation Layer](#phase-1-foundation-layer)                    | Render workbench shell in Tauri WebView                 |  [✅ Complete](https://github.com/j4rviscmd/vscodeee/pull/9)  |
| **2A** | [**Functional File Editing**](#phase-2a-functional-file-editing) | **Open, edit, and save local files**                    |                      **🚧 In Progress**                       |
|   2B   | [Editing Polish](#phase-2b-editing-polish)                       | File watchers, remaining native methods                 |                          📋 Planned                           |
|   3    | [Window Management](#phase-3-window-management)                  | Multi-window, title bar, auxiliary windows              |                          📋 Planned                           |
|   4    | [Native Host Services](#phase-4-native-host-services)            | Dialogs, clipboard, shell, OS integration (~80 methods) |                          📋 Planned                           |
|   5    | [Process Model](#phase-5-process-model)                          | Extension Host, Terminal (PTY), Shared Process          |                          📋 Planned                           |
|   6    | [Platform Features](#phase-6-platform-features)                  | Auto-update, native menus, system tray                  |                          📋 Planned                           |
|   7    | [Build & Packaging](#phase-7-build--packaging)                   | Installers, code signing, CI/CD                         |                          📋 Planned                           |

---

<details>
<summary>Phase Details</summary>

### Phase 0: Feasibility Spike

**Status**: ✅ Complete (GO) — All sub-phases passed. See [Issue #7](https://github.com/j4rviscmd/vscodeee/issues/7).

| Sub-Phase                                  | Result | PR/Issue                                                   |
| ------------------------------------------ | :----: | ---------------------------------------------------------- |
| 0-1: Tauri Project Init                    |   ✅   | [PR #1](https://github.com/j4rviscmd/vscodeee/pull/1)      |
| 0-2: Extension Host Sidecar PoC            |   ✅   | [PR #2](https://github.com/j4rviscmd/vscodeee/pull/2)      |
| 0-3: Custom Protocol (`vscode-file://`)    |   ✅   | [PR #4](https://github.com/j4rviscmd/vscodeee/pull/4)      |
| 0-4: PTY Host (Rust `portable-pty`)        |   ✅   | [PR #3](https://github.com/j4rviscmd/vscodeee/pull/3)      |
| 0-5: BrowserView Alternative Investigation |   ✅   | [Issue #5](https://github.com/j4rviscmd/vscodeee/issues/5) |

### Phase 1: Foundation Layer

**Status**: ✅ Complete — [PR #9](https://github.com/j4rviscmd/vscodeee/pull/9)

Implemented the workbench shell that renders VS Code's full UI inside a Tauri 2.0 WebView with zero fatal errors.

**What was built:**

- Binary IPC protocol (base64-encoded VSBuffer over Tauri invoke/emit)
- 25+ core services registered (File, Storage, Remote, Configuration, etc.)
- Custom `vscode-file://` protocol handler for resource loading
- Tauri-specific platform layer (`tauri-browser/`) with environment, lifecycle, and host services
- 24 files changed, 2658 lines added

### Phase 2A: Functional File Editing

**Status**: 🚧 In Progress

The bridge from "UI renders" to "you can actually edit files." Implements `IFileSystemProvider` with direct Tauri `invoke()` calls — same pattern as `NativeHostService`. IPC binary routing is deferred to Phase 3 (needed for Extension Host, not for file editing).

| Task                       | Description                                      | Depends On | Status |
| -------------------------- | ------------------------------------------------ | ---------- | :----: |
| 2A-0: Pre-work             | Kill IPC echo router + add npm plugin packages   | —          |   📋   |
| 2A-1: Local FileSystem     | Rust fs commands + `TauriDiskFileSystemProvider` | 2A-0       |   📋   |
| 2A-2: UserData Persistence | Settings/state persisted to disk (real OS paths) | 2A-1       |   📋   |
| 2A-3: File Dialogs         | `tauri-plugin-dialog` + `showMessageBox`         | 2A-1       |   📋   |
| 2A-4: NativeHost Methods   | Clipboard, shell, window basics (~8 methods)     | 2A-0       |   📋   |

```text
Architecture:

  TypeScript (WebView)                    Rust (Backend)
  ┌──────────────────────────┐           ┌──────────────────────┐
  │ TauriDiskFileSystemProvider│          │ #[tauri::command]     │
  │ implements IFileSystem-   │─invoke()─▶│ fs_stat, fs_read_file │
  │ Provider                  │          │   ↓ tokio::fs         │
  └──────────────────────────┘           │ Local Disk            │
                                         └──────────────────────┘
```

### Phase 2B: Editing Polish

File watchers (Rust `notify` crate), remaining NativeHostService methods (~30), storage backend improvements.

### Phase 3: Window Management

Replace Electron `BrowserWindow` with Tauri `WebviewWindow`. Multi-window, title bar customization, auxiliary windows.

### Phase 4: Native Host Services

Implement all ~80 methods of `ICommonNativeHostService` using Tauri plugins (dialog, clipboard, shell, OS info, notification, etc.).

### Phase 5: Process Model

Extension Host via Node.js sidecar + named pipe, Terminal via Rust `portable-pty`, Shared Process services.

### Phase 6: Platform Features

Auto-update (`tauri-plugin-updater`), native menus, system tray, drag & drop, platform-specific integrations.

### Phase 7: Build & Packaging

Tauri build pipeline, code signing (macOS/Windows), installers (.dmg, .msi, .AppImage, .deb), CI/CD.

</details>

---

## Architecture

```text
┌──────────────────────────────────────────┐
│           Tauri WebView (Renderer)       │
│  workbench.html + VS Code TypeScript     │
└──────────────┬───────────────────────────┘
               │  invoke / emit (Tauri IPC)
┌──────────────▼───────────────────────────┐
│           Tauri Rust Backend             │
│  • Custom Protocol (vscode-file://)      │
│  • PTY Manager (portable-pty)            │
│  • Window Management                     │
│  • Native Host Services                  │
└──────────────┬───────────────────────────┘
               │  socket / named pipe
┌──────────────▼───────────────────────────┐
│         Node.js Sidecar Processes        │
│  • Extension Host                        │
│  • Shared Process                        │
└──────────────────────────────────────────┘
```

## MVP Excluded Features

The following features depend on Chrome DevTools Protocol (CDP), which has no public API in Tauri's native WebViews (WKWebView / WebView2 / WebKitGTK). They are excluded from the MVP scope.

| Feature                                   | Reason                                     |
| ----------------------------------------- | ------------------------------------------ |
| AI Browser Tools (Copilot web automation) | CDP-dependent (click/drag/type/screenshot) |
| `vscode.BrowserTab` API (proposed)        | CDP-dependent, zero marketplace adoption   |
| Playwright integration                    | CDP-dependent browser automation           |
| Element inspection (`getElementData`)     | CDP-dependent DOM inspection               |
| Console log capture                       | CDP-dependent programmatic console access  |

> [!NOTE]
> These features may be revisited if Tauri adds CDP support in the future, or if alternative approaches become viable.

## Contributing

Issues and PRs are welcome.<br>
もちろん、日本語のコミュニケーション大歓迎です！

## License

MIT License — see [LICENSE](./LICENSE.txt) for details.
