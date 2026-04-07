<div align="center">

# VS Codeee

<img src="https://github.com/user-attachments/assets/7981bd25-ecf8-4abd-accc-df3fe3d7f842" alt="VS Codeee Phase 0 Feasibility Spike" width="600">

</div>

**A project to run VSCode with Tauri 2.0**
In the process of gradual migration with Opus4.6 :robot: (2026-04-07)

## Purpose - What we want to do

Maintain the current functionality of VSCode while achieving the following

- Reduce memory usage: Electron to Tauri 2.0
- Reduce unnecessary metrics: Stop sending telemetry to Microsoft

## Migration Status

### Phase 0: Feasibility Spike — ✅ Complete (GO)

All sub-phases passed. See [Issue #7](https://github.com/j4rviscmd/vscodeee/issues/7) for full Go/No-Go evaluation.

| Sub-Phase                                  | Status | PR/Issue                                                   |
| ------------------------------------------ | :----: | ---------------------------------------------------------- |
| 0-1: Tauri Project Init                    |   ✅   | [PR #1](https://github.com/j4rviscmd/vscodeee/pull/1)      |
| 0-2: Extension Host Sidecar PoC            |   ✅   | [PR #2](https://github.com/j4rviscmd/vscodeee/pull/2)      |
| 0-3: Custom Protocol (`vscode-file://`)    |   ✅   | [PR #4](https://github.com/j4rviscmd/vscodeee/pull/4)      |
| 0-4: PTY Host (Rust `portable-pty`)        |   ✅   | [PR #3](https://github.com/j4rviscmd/vscodeee/pull/3)      |
| 0-5: BrowserView Alternative Investigation |   ✅   | [Issue #5](https://github.com/j4rviscmd/vscodeee/issues/5) |

### Current Phase: Phase 1 (Foundation Layer) — 🚧 Planning

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
