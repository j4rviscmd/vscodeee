<div align="center">

# VS Codeee

<img src="./docs/screenshots/workbench.png" alt="VS Codeee Phase 1">

## A project to run VSCode with Tauri 2.0

</div>

> [!IMPORTANT]
> **MVP Release Target: Late April 2026**<br>
> Want to get notified? Watch this repo (**Watch → Custom → Releases**) to stay updated.

## Purpose

Maintain the current functionality of VSCode while achieving the following:

- **Reduce memory usage**: Electron → Tauri 2.0 (native WebView instead of bundled Chromium)
- **Reduce unnecessary metrics**: Stop sending telemetry to Microsoft
- **Smaller binary size**: ~50% reduction expected without bundled Chromium
- **Transparent background**: Native window transparency support (macOS/Linux) — see the desktop through your editor

---

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/screenshots/vscodeee_architecture_dark.png">
  <img src="./docs/screenshots/vscodeee_architecture_light.png" alt="VSCodeee Architecture">
</picture>

> **Note**: Shared Process (upstream VS Code's hidden renderer for gallery, sync, telemetry) is **eliminated** in VSCodeee. Its services are implemented directly in the WebView or Rust backend — see [#88](https://github.com/j4rviscmd/vscodeee/issues/88).

---

## Roadmap

> **Current Phase: Phase 6 — Platform Features** 🔄

| Phase  | Name                                                         | Goal                                                          |                            Status                             |
| :----: | ------------------------------------------------------------ | ------------------------------------------------------------- | :-----------------------------------------------------------: |
|   0    | [Feasibility Spike](#phase-0-feasibility-spike)              | Validate Tauri can host VS Code                               | [✅ Complete](https://github.com/j4rviscmd/vscodeee/issues/7) |
|   1    | [Foundation Layer](#phase-1-foundation-layer)                | Render workbench shell in Tauri WebView                       |  [✅ Complete](https://github.com/j4rviscmd/vscodeee/pull/9)  |
|   2A   | [Functional File Editing](#phase-2a-functional-file-editing) | Open, edit, and save local files                              | [✅ Complete](https://github.com/j4rviscmd/vscodeee/pull/17)  |
| **2B** | [**Editing Polish**](#phase-2b-editing-polish)               | **File watchers, remaining native methods**                   | [✅ Complete](https://github.com/j4rviscmd/vscodeee/pull/25)  |
|   3A   | [Window Registry](#phase-3-window-management)                | Dynamic window IDs, scoped IPC, multi-window registry         | [✅ Complete](https://github.com/j4rviscmd/vscodeee/pull/31)  |
|   3B   | [Custom Title Bar](#phase-3-window-management)               | Draggable title bar, traffic lights, window controls          | [✅ Complete](https://github.com/j4rviscmd/vscodeee/pull/34)  |
|   3C   | [State Persistence](#phase-3-window-management)              | Window position/size + workspace session restore              | [✅ Complete](https://github.com/j4rviscmd/vscodeee/pull/36)  |
|   3D   | [Lifecycle Close Handshake](#phase-3-window-management)      | Two-phase close for reliable session restore                  | [✅ Complete](https://github.com/j4rviscmd/vscodeee/pull/39)  |
| **4**  | [**Native Host Services**](#phase-4-native-host-services-)   | **Extension scanner, OS theme, native host modularization**   | [✅ Complete](https://github.com/j4rviscmd/vscodeee/pull/48)  |
|   5A   | [Extension Host](#phase-5-process-model)                     | Node.js sidecar + WebSocket ↔ Rust relay ↔ Unix Socket        | [✅ Complete](https://github.com/j4rviscmd/vscodeee/pull/58)  |
| **5B** | [**Terminal PTY**](#phase-5-process-model)                   | **Rust PTY → Tauri IPC → TauriTerminalBackend → Terminal UI** | [✅ Complete](https://github.com/j4rviscmd/vscodeee/pull/105) |
|   5C   | [Shared Process Elimination](#phase-5-process-model)         | Abolish Shared Process; services in WebView/Rust              | [✅ Complete](https://github.com/j4rviscmd/vscodeee/pull/117) |
|   5D   | [Extension ESM Fix](#phase-5-process-model)                  | Fix ESM module resolution for built-in extensions             | [✅ Complete](https://github.com/j4rviscmd/vscodeee/pull/103) |
|   5E   | [Remote-SSH](#phase-5-process-model)                         | SSH remote workspace support via Tauri                        | [✅ Complete](https://github.com/j4rviscmd/vscodeee/pull/193) |
|   6    | [Platform Features](#phase-6-platform-features)              | Editor transparency, native menus, system tray                |                          🔄 In Progress                       |
|   7    | [Build & Packaging](#phase-7-build--packaging)               | Installers, code signing, CI/CD                               |                          📋 Planned                           |

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

**Status**: ✅ Complete — [PR #17](https://github.com/j4rviscmd/vscodeee/pull/17)

The bridge from "UI renders" to "you can actually edit files." Implements `IFileSystemProvider` with direct Tauri `invoke()` calls — same pattern as `NativeHostService`. IPC binary routing is deferred to Phase 3 (needed for Extension Host, not for file editing).

| Task                       | Description                                      | Depends On | Status |
| -------------------------- | ------------------------------------------------ | ---------- | :----: |
| 2A-0: Pre-work             | Kill IPC echo router + add npm plugin packages   | —          |   ✅   |
| 2A-1: Local FileSystem     | Rust fs commands + `TauriDiskFileSystemProvider` | 2A-0       |   ✅   |
| 2A-2: UserData Persistence | Settings/state persisted to disk (real OS paths) | 2A-1       |   ✅   |
| 2A-3: File Dialogs         | `tauri-plugin-dialog` + `showMessageBox`         | 2A-1       |   ✅   |
| 2A-4: NativeHost Methods   | Clipboard, shell, window basics (~8 methods)     | 2A-0       |   ✅   |

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

**Status**: ✅ Complete — See [PR #25](https://github.com/j4rviscmd/vscodeee/pull/25).

| Sub-task                 | Description                                                | Depends on | Status |
| ------------------------ | ---------------------------------------------------------- | ---------- | :----: |
| File Watcher             | Rust `notify` crate + `TauriWatcher` TypeScript bridge     | —          |   ✅   |
| Trash Support            | `trash` crate in `DiskFileSystemProvider`                  | —          |   ✅   |
| New Window (Cmd+Shift+N) | `invoke('open_new_window')` via `TauriWorkspaceProvider`   | —          |   ✅   |
| NativeHost Methods       | `installShellCommand`, `killProcess`, `relaunch`, etc.     | —          |   ✅   |
| Runtime Bug Fixes        | Import strategy, watcher error handling, compilation fixes | —          |   ✅   |

### Phase 3: Window Management

Replace Electron `BrowserWindow` with Tauri `WebviewWindow`. Multi-window, title bar customization, auxiliary windows.

#### Phase 3A: Window Registry ✅

Centralized window management with unique monotonic IDs, `WindowManager` registry, scoped IPC delivery (`emit_to`), and `ITauriWindowService` DI integration. Foundation for all multi-window features.

| Task                     | Description                                              | Status |
| ------------------------ | -------------------------------------------------------- | :----: |
| Rust `window/` module    | state, manager, events, session modules                  |   ✅   |
| WindowManager registry   | Atomic ID generation, RwLock-based HashMap, label→ID map |   ✅   |
| Scoped IPC               | `emit_to(label)` instead of global `app.emit()`          |   ✅   |
| ITauriWindowService      | TS DI service for window lifecycle events                |   ✅   |
| NativeHostService wiring | `getWindows()`, `getWindowCount()`, event listeners      |   ✅   |
| Dynamic window label     | URL query param resolution for multi-window bootstrap    |   ✅   |

#### Phase 3B: Custom Title Bar ✅

Hide OS decorations, implement CSS-based draggable title bar with platform-appropriate window controls. See [PR #34](https://github.com/j4rviscmd/vscodeee/pull/34).

| Task                        | Description                                              | Status |
| --------------------------- | -------------------------------------------------------- | :----: |
| macOS decorations           | `decorations(false)` + `TitleBarStyle::Overlay`          |   ✅   |
| `isTauri` platform flag     | Add to `platform.ts`, gate `getTitleBarStyle()` → CUSTOM |   ✅   |
| Drag region                 | `data-tauri-drag-region` on title bar                    |   ✅   |
| Window controls (Win/Linux) | CSS minimize/maximize/close buttons                      |   ✅   |
| Tauri CSS                   | `titlebarpart.tauri.css` for platform-specific styles    |   ✅   |

#### Phase 3C: State Persistence ✅

Persist window position/size and workspace state across restarts using `tauri-plugin-window-state` and a custom `SessionStore`.

| Task                | Description                                               | Status |
| ------------------- | --------------------------------------------------------- | :----: |
| Window state plugin | `tauri-plugin-window-state` for position/size persistence |   ✅   |
| SessionStore        | `sessions.json` read/write for workspace restoration      |   ✅   |
| Restore on launch   | Re-open same windows with same workspace on restart       |   ✅   |
| Settings reader     | JSONC-aware reader for `window.restoreWindows` setting    |   ✅   |
| 5 restore modes     | Strategy pattern: preserve/all/folders/one/none           |   ✅   |

#### Phase 3D: Lifecycle Close Handshake ✅

Two-phase close handshake between Rust and TypeScript to ensure IndexedDB writes complete before window destruction. Fixes editor tabs not being restored after session restore ([#35](https://github.com/j4rviscmd/vscodeee/issues/35)).

| Task                       | Description                                                | Status |
| -------------------------- | ---------------------------------------------------------- | :----: |
| Rust close gate            | `api.prevent_close()` + emit to TS + 30s timeout           |   ✅   |
| TauriLifecycleService      | Full rewrite extending `AbstractLifecycleService` directly |   ✅   |
| Async veto support         | `fireBeforeShutdown` with async veto + `finalVeto`         |   ✅   |
| Storage flush before close | `storageService.flush(SHUTDOWN)` before `window.destroy()` |   ✅   |
| Rust confirmed/vetoed cmds | `lifecycle_close_confirmed` + `lifecycle_close_vetoed`     |   ✅   |

### Phase 4: Native Host Services ✅

Built-in extension scanning and OS theme detection for the Tauri backend. Modularized the native host Rust code from a single file into a clean module structure. See [PR #48](https://github.com/j4rviscmd/vscodeee/pull/48).

| Task                       | Description                                                                                                      | Status |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- | :----: |
| Built-in extension scanner | Rust `list_builtin_extensions` + TS `TauriBuiltinExtensionsScannerService`                                       |   ✅   |
| OS theme detection         | `TauriHostColorSchemeService` with real-time dark/light switching                                                |   ✅   |
| Native host modularization | Split monolithic `native_host.rs` into 9 sub-modules                                                             |   ✅   |
| OS info methods            | `hostname`, `arch`, `platform`, `release` via `tauri-plugin-os`                                                  |   ✅   |
| Security fixes             | Escape osascript injection, fix IPC param mismatch, cfg(unix) guard                                              |   ✅   |
| ESM build fix              | Per-extension CJS/ESM format in `transpileExtensions()` ([#57](https://github.com/j4rviscmd/vscodeee/issues/57)) |   ✅   |

> **Note**: 94 built-in extensions are scanned and correctly transpiled (31 CJS, 1 ESM). Extension **execution** requires Extension Host (Phase 5). `file://` resource loading is blocked by WebView CSP — see [#47](https://github.com/j4rviscmd/vscodeee/issues/47). SCM provider registration is tracked in [#61](https://github.com/j4rviscmd/vscodeee/issues/61).

### Phase 5: Process Model

Extension Host via Node.js sidecar + named pipe, Terminal via Rust `portable-pty`, Shared Process elimination.

| Sub-task                      | Description                                                                                                                                      |   Status   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | :--------: |
| Extension Host (Node sidecar) | Node.js sidecar + WebSocket ↔ Rust relay ↔ Unix Socket full pipeline (PR [#58](https://github.com/j4rviscmd/vscodeee/pull/58))                   |     ✅     |
| Terminal PTY integration      | Rust `portable-pty` → Tauri IPC → `TauriTerminalBackend` → VS Code Terminal UI (PR [#105](https://github.com/j4rviscmd/vscodeee/pull/105))       |     ✅     |
| Shared Process elimination    | Abolish Shared Process sidecar; implement services directly in WebView/Rust (PR [#117](https://github.com/j4rviscmd/vscodeee/pull/117))          |     ✅     |
| Extension ESM fix             | Fix ESM module resolution for built-in extensions in Extension Host (PR [#103](https://github.com/j4rviscmd/vscodeee/pull/103))                  |     ✅     |
| OAuth authentication          | `tauri-plugin-deep-link` + `TauriURLCallbackProvider` for GitHub OAuth callback flow (PR [#112](https://github.com/j4rviscmd/vscodeee/pull/112)) |     ✅     |
| Remote-SSH                    | Delegate _resolveAuthority + REH server build pipeline + single-instance (PR [#193](https://github.com/j4rviscmd/vscodeee/pull/193), [#202](https://github.com/j4rviscmd/vscodeee/pull/202), [#203](https://github.com/j4rviscmd/vscodeee/pull/203)) |     ✅     |

### Phase 6: Platform Features 🔄

Auto-update, native menus, system tray, editor transparency, platform-specific integrations.

| Sub-task               | Description                                                                                                                    | Status |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ | :----: |
| Auto-update            | `tauri-plugin-updater` + `TauriUpdateService` with GitHub releases endpoint (PR [#135](https://github.com/j4rviscmd/vscodeee/pull/135), [#145](https://github.com/j4rviscmd/vscodeee/pull/145)) |   ✅   |
| Single-instance        | Process-level locking with CLI arg forwarding to existing instance (PR [#203](https://github.com/j4rviscmd/vscodeee/pull/203)) |   ✅   |
| Editor transparency    | Native window transparency + CSS theming for see-through editor                                                                | 📋 Planned |
| Native menus           | Application menu bar via Tauri native menu API                                                                                 | 📋 Planned |
| System tray            | System tray icon and menu for background operation                                                                             | 📋 Planned |

### Phase 7: Build & Packaging

Tauri build pipeline, code signing (macOS/Windows), installers (.dmg, .msi, .AppImage, .deb), CI/CD.

| Sub-task               | Description                                                                                                       |   Status   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- | :--------: |
| CI/CD release pipeline | Cross-platform builds (macOS/Linux/Windows) with auto-release notes (PR [#135](https://github.com/j4rviscmd/vscodeee/pull/135)) | ✅ Complete |
| Code signing (updater) | `TAURI_SIGNING_PRIVATE_KEY` for updater artifact signing                                                          | ✅ Complete |
| ThirdPartyNotices.txt  | Remove Electron deps, add Tauri/Rust dependency licenses ([#27](https://github.com/j4rviscmd/vscodeee/issues/27)) | ✅ Complete |
| LICENSES.chromium.html | Bundled with Electron — not needed for Tauri                                                                      | ✅ Removed |

</details>

---

## MVP Excluded Features

The following features depend on Chrome DevTools Protocol (CDP), which has no public API in Tauri's native WebViews (WKWebView / WebView2 / WebKitGTK). They are excluded from the MVP scope.

| Feature                                   | Reason                                     |
| ----------------------------------------- | ------------------------------------------ |
| AI Browser Tools (Copilot web automation) | CDP-dependent (click/drag/type/screenshot) |
| `vscode.BrowserTab` API (proposed)        | CDP-dependent, zero marketplace adoption   |
| Playwright integration                    | CDP-dependent browser automation           |
| Element inspection (`getElementData`)     | CDP-dependent DOM inspection               |
| Console log capture                       | CDP-dependent programmatic console access  |

The following Native Host Service features are deferred to post-MVP:

| Feature                    | Reason                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Microsoft Account login    | MVP supports GitHub authentication only. Microsoft authentication depends on `@azure/msal-node` and will be implemented post-MVP.  |
| Client credentials auth    | MVP supports authorization code flow only. Client credentials flow (`client_id` + `client_secret`) is deferred to post-MVP.        |
| System proxy resolution    | Requires platform-specific APIs (CFNetwork, WinHTTP, libproxy). The `resolve_proxy` command returns `None` (direct connection).    |
| System certificate loading | The `load_certificates` command returns an empty list. Extensions handle their own cert loading.                                   |
| Kerberos authentication    | `lookupKerberosAuthorization` returns `undefined`. Requires a Kerberos library — rarely needed outside enterprise AD environments. |
| Window splash persistence  | `saveWindowSplash` is a no-op. Splash data is persisted via `localStorage` through `ISplashStorageService` instead.                |
| macOS Touch Bar            | Not supported by Tauri's WebView. The Touch Bar API methods are no-ops.                                                            |
| macOS tab management       | Window tab APIs (`newWindowTab`, `mergeAllWindowTabs`, etc.) are no-ops.                                                           |
| GPU info / content tracing | `openGPUInfoWindow`, `openContentTracingWindow`, `startTracing`, `stopTracing` are no-ops.                                         |
| Screenshot capture         | `getScreenshot` returns `undefined`. Requires platform-specific screen capture APIs.                                               |

> [!TIP]
> These features may be revisited if Tauri adds CDP support in the future, or if alternative approaches become viable.

## Known Limitations

Architectural differences between Electron (bundled Chromium) and Tauri (native system WebView) introduce permanent or platform-specific limitations.

| Feature                   | Limitation                                                                                                            | Platform Details                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setBackgroundThrottling` | WebView internal JS timer/animation throttling cannot be controlled externally                                        | All platforms — `NSProcessInfo.beginActivity()` (macOS) can prevent OS-level throttling, but WebView-internal behavior remains uncontrollable.                                               |
| Settings Sync             | Built-in Settings Sync is unavailable. The upstream sync service is licensed exclusively for official VS Code builds. | All platforms — use third-party extensions (e.g., [Settings Sync](https://marketplace.visualstudio.com/items?itemName=Shan.code-settings-sync)) that sync via GitHub Gist as an alternative. |
| Remote Tunnels            | Built-in Remote Tunnels is unavailable. The tunnel relay infrastructure is hosted by Microsoft (Azure Dev Tunnels) and is not accessible from third-party builds. Use Remote-SSH for remote development instead. | All platforms — see [#100](https://github.com/j4rviscmd/vscodeee/issues/100) for details. Remote-SSH support is tracked in [#185](https://github.com/j4rviscmd/vscodeee/issues/185). |

> [!NOTE]
> This list covers inherent platform limitations. Features that are simply not yet implemented are tracked in individual GitHub Issues.

## Installation

| Platform              | Installer                                                                                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS (Apple Silicon) | [`.dmg`](https://github.com/j4rviscmd/vscodeee/releases/latest/download/VSCodeee_macOS_arm64.dmg)                                                                                                           |
| macOS (Intel)         | [`.dmg`](https://github.com/j4rviscmd/vscodeee/releases/latest/download/VSCodeee_macOS_x64.dmg)                                                                                                             |
| Linux                 | [`.AppImage`](https://github.com/j4rviscmd/vscodeee/releases/latest/download/VSCodeee_Linux_x64.AppImage) / [`.deb`](https://github.com/j4rviscmd/vscodeee/releases/latest/download/VSCodeee_Linux_x64.deb) |
| Windows               | [`.exe`](https://github.com/j4rviscmd/vscodeee/releases/latest/download/VSCodeee_Windows_x64-setup.exe)                                                                                                     |

## Contributing

Issues and PRs are welcome.<br>
もちろん、日本語のコミュニケーション大歓迎です！

## License

MIT License — see [LICENSE](./LICENSE.txt) for details.
