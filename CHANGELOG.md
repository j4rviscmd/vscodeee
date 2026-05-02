# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.11.0] - 2026-05-02

### Added

- Show shutdown overlay during app closing for better UX feedback
- Show splash screen immediately on Reload Window and quit ([#413](https://github.com/j4rviscmd/vscodeee/pull/413))

### Fixed

- Align bundle.resources path with bundle-node-modules output directory ([#414](https://github.com/j4rviscmd/vscodeee/pull/414))
- Preserve workspace on Reload Window ([#410](https://github.com/j4rviscmd/vscodeee/issues/410))
- Resolve syntax error and EISDIR in bundle-node-modules.mjs ([#407](https://github.com/j4rviscmd/vscodeee/issues/407))
- Use hash-based skip detection in bundle-node-modules ([#406](https://github.com/j4rviscmd/vscodeee/issues/406))
- Use shell comment syntax for unicode suppression in check-csp-hash.sh ([#405](https://github.com/j4rviscmd/vscodeee/issues/405))
- Resolve hygiene check failures by adding filter exclusions

### Changed

- Fix progressive performance degradation
- Skip unnecessary build steps in tauri:dev ([#404](https://github.com/j4rviscmd/vscodeee/issues/404))
- Remove pty-poc standalone terminal PoC (Phase 0-4 artifact no longer needed) ([#401](https://github.com/j4rviscmd/vscodeee/issues/401))

## [0.10.1] - 2026-05-02

### Fixed

- Prevent watermark text selection on splash screen ([00ebdcd](https://github.com/j4rviscmd/vscodeee/commit/00ebdcd))
- Resolve hot exit backup and empty file save issues on reload ([#398](https://github.com/j4rviscmd/vscodeee/pull/398))
- Restore rg binary execute permission stripped by Tauri bundler ([#395](https://github.com/j4rviscmd/vscodeee/pull/395))

## [0.10.0] - 2026-05-02

### Added

- Splash screen with theme-aware colors and spinner overlay for startup UX ([#391](https://github.com/j4rviscmd/vscodeee/pull/391))

## [0.9.1] - 2026-05-01

### Fixed

- Prevent duplicate workspace windows from UI open actions ([#388](https://github.com/j4rviscmd/vscodeee/pull/388))

### Changed

- Skip unchanged file writes to prevent unnecessary Cargo rebuilds ([#387](https://github.com/j4rviscmd/vscodeee/pull/387))

## [0.9.0] - 2026-05-01

### Added

- Implement multi-window quit with proper ShutdownReason handling ([#382](https://github.com/j4rviscmd/vscodeee/pull/382))

### Fixed

- Resolve startup freeze by offloading file I/O and watcher init from main thread
- Correct update download progress bar accumulation bug ([#383](https://github.com/j4rviscmd/vscodeee/pull/383))

## [0.8.0] - 2026-05-01

### Added

- Relax REH version check from commit hash to semver major.minor ([#375](https://github.com/j4rviscmd/vscodeee/pull/375))

### Fixed

- Add IME composition guards to prevent Enter key from triggering actions during Japanese input
- Add event coalescing and NFC normalization to Tauri file watcher ([#373](https://github.com/j4rviscmd/vscodeee/pull/373))
- Replace manual event batching with notify-debouncer-full for reliable file watcher coalescing ([#381](https://github.com/j4rviscmd/vscodeee/pull/381))
- Disable auto-save by default in Tauri desktop environment ([#378](https://github.com/j4rviscmd/vscodeee/pull/378))
- Use full clone in publish workflow preflight for REH diff detection ([#380](https://github.com/j4rviscmd/vscodeee/pull/380))

### Changed

- Disable auto-opening DevTools on debug startup ([#371](https://github.com/j4rviscmd/vscodeee/pull/371))

## [0.7.0] - 2026-04-30

### Added

- Add download progress notification for app updates ([#369](https://github.com/j4rviscmd/vscodeee/pull/369))

### Fixed

- Show progress notification during remote authority resolution ([#370](https://github.com/j4rviscmd/vscodeee/pull/370))
- Pass GITHUB_TOKEN to cross-compile Docker container ([#365](https://github.com/j4rviscmd/vscodeee/pull/365))

### Changed

- Add monaco.d.ts staleness check to prevent REH build failures

## [0.6.0] - 2026-04-29

### Added

- Add DEV@ prefix to window title in development builds

### Fixed

- Prevent IME composition Enter from triggering unintended actions ([#359](https://github.com/j4rviscmd/vscodeee/pull/359))
- Restore missing `hasClipboardImage` in `TauriNativeHostService`
- Handle image-only clipboard gracefully and return PNG from `readImage` ([#354](https://github.com/j4rviscmd/vscodeee/pull/354))
- Enable HTML5 drag-and-drop for editor pane repositioning ([#342](https://github.com/j4rviscmd/vscodeee/pull/342))
- Prevent empty editor group creation when focusing non-existent group index ([#351](https://github.com/j4rviscmd/vscodeee/pull/351))
- Improve empty editor watermark contrast for all color themes ([#350](https://github.com/j4rviscmd/vscodeee/pull/350))

### Changed

- Rename `workbench.editor.autoMaximizeOnFocus` to `vscodeee.workbench.editor.autoMaximizeOnFocus` (Tauri-specific setting now under `vscodeee` prefix)
- Rename `vscodeee.editorGroupIndexInTab` to `vscodeee.workbench.editor.editorGroupIndexInTab`
- Rename `vscodeee.resizeIncrement` to `vscodeee.workbench.editor.resizeIncrement`
- Rename pane resize command IDs to `vscodeee.workbench.editor` namespace
- Fix tab-to-space indentation in tauriDnd.ts
- Regenerate `monaco.d.ts` to fix REH server build ([#361](https://github.com/j4rviscmd/vscodeee/pull/361))

## [0.5.1] - 2026-04-28

### Added

- Add tmux-like directional pane resize commands ([#334](https://github.com/j4rviscmd/vscodeee/pull/334))
- Reduce minimum pane dimensions for tmux-like splits

### Fixed

- Add `generate-notes` dependency to `build-reh` job to prevent 404 errors when uploading REH assets ([#337](https://github.com/j4rviscmd/vscodeee/pull/337))
- Restore terminal editor tabs on app restart ([#344](https://github.com/j4rviscmd/vscodeee/pull/344))
- Resolve draft release lookup failure in CI publish workflow — replace `getReleaseByTag` with `getRelease` by ID across build-reh and upload-stable-assets jobs, add input validation guards, and consolidate `tauri.conf.json` reads ([#345](https://github.com/j4rviscmd/vscodeee/pull/345))
- Add missing `preflight` dependency to `upload-stable-assets` job to fix empty VERSION/TAG env vars ([#348](https://github.com/j4rviscmd/vscodeee/pull/348))

### Changed

- Add Japanese README (README.ja.md) and restructure documentation ([#335](https://github.com/j4rviscmd/vscodeee/pull/335))
- Skip BUNDLED extension dependencies in Phase 2 node_modules bundling — reduces staging node_modules from 66.9MB to 47.5MB (-19.4MB, -29%) ([#330](https://github.com/j4rviscmd/vscodeee/pull/330))
- Exclude unused `@azure` and `@octokit` type packages from bundle ([#328](https://github.com/j4rviscmd/vscodeee/pull/328))
- Parallelize `publish-tauri` and `build-reh` CI jobs for faster releases

## [0.5.0] - 2026-04-28

### Added

- Add editor group index indicator in tab bar ([#326](https://github.com/j4rviscmd/vscodeee/pull/326))

### Fixed

- Restore Supported label in platform badges
- Correct indentation formatting in workbench.contribution.ts for CI hygiene check

### Changed

- Exclude pty-poc from bundle and enable notebook-renderers esbuild bundling
- Add shields.io badges to README header

## [0.4.0] - 2026-04-28

### Added

- Add zoom status bar indicator with per-window zoom support ([#315](https://github.com/j4rviscmd/vscodeee/pull/315))
- Add system font enumeration for `editor.fontFamily` suggestions ([#310](https://github.com/j4rviscmd/vscodeee/pull/310))

### Fixed

- Detect and remove symlink at `src-tauri/node_modules` before bundling ([#314](https://github.com/j4rviscmd/vscodeee/pull/314))
- Disable single-instance plugin in dev builds

### Changed

- Exclude test files from production build (-51MB) ([#317](https://github.com/j4rviscmd/vscodeee/pull/317))
- Add Cargo release profile for binary size optimization ([#313](https://github.com/j4rviscmd/vscodeee/pull/313))
- Exclude unused built-in extensions to reduce bundle size ([#311](https://github.com/j4rviscmd/vscodeee/pull/311))
- Fix ESLint `@stylistic/ts` violations in zoom files ([#316](https://github.com/j4rviscmd/vscodeee/pull/316), [#318](https://github.com/j4rviscmd/vscodeee/pull/318))

## [0.3.1] - 2026-04-27

### Fixed

- Use template-resolved title for Tauri native window title in Alt+Tab — fixes window title not reflecting the active editor name when switching windows via OS window switcher ([#306](https://github.com/j4rviscmd/vscodeee/pull/306))

## [0.3.0] - 2026-04-26

### Added

- Add `workbench.editor.autoMaximizeOnFocus` setting to control whether maximized editor groups auto-restore when a different group receives focus — defaults to `true` (existing behavior), set to `false` to keep groups maximized ([#303](https://github.com/j4rviscmd/vscodeee/pull/303))

### Fixed

- Add `node scripts/bundle-node-modules.mjs` to `tauri:dev` script to fix `resource path 'node_modules' doesn't exist` error during `cargo build` in dev mode ([#302](https://github.com/j4rviscmd/vscodeee/pull/302))

### Changed

- Rename package from `code-oss-dev` to `vscodeee` across the entire codebase — package names, user data folder (`~/.vscode-oss` → `~/.vscodeee`), product display names (`Code - OSS Dev` → `VS Codeee Dev`), URL protocol (`code-oss://` → `vscodeee://`), and all related test fixtures ([#302](https://github.com/j4rviscmd/vscodeee/pull/302))
- Update all `package-lock.json` files to reflect renamed package names

## [0.2.0] - 2026-04-25

### Added

- Implement window zoom via native WebView zoom API — zoom in/out/reset now uses Tauri's native `webview.setZoom()` instead of CSS transform hacks ([#292](https://github.com/j4rviscmd/vscodeee/pull/292))
- Auto-download updates for background checks — when `update.mode` is `default` or `start`, detected updates are downloaded immediately without waiting for manual action, matching original VS Code Electron behavior ([#280](https://github.com/j4rviscmd/vscodeee/pull/280), closes [#277](https://github.com/j4rviscmd/vscodeee/issues/277))
- Replace telemetry packages (`tas-client`, `vscode-tas-client`) with no-op stubs to reduce bundle size by ~80MB and eliminate ESM/CJS incompatibility ([#293](https://github.com/j4rviscmd/vscodeee/pull/293), [#299](https://github.com/j4rviscmd/vscodeee/pull/299))
- Add `tauri-plugin-mcp-bridge` for debug builds to enable Tauri MCP automation

### Fixed

- Use esbuild `dist/` bundles for extension packaging — all 30 extensions with `esbuild.mts` now produce bundled output with dependencies inlined, eliminating `node_modules/` missing errors in production builds ([#300](https://github.com/j4rviscmd/vscodeee/pull/300), fixes [#297](https://github.com/j4rviscmd/vscodeee/issues/297), [#298](https://github.com/j4rviscmd/vscodeee/issues/298))
- Bundle all extension `node_modules` for production builds — extensions and Extension Host now activate correctly without `ERR_MODULE_NOT_FOUND` errors ([#278](https://github.com/j4rviscmd/vscodeee/pull/278))
- Resolve transitive dependencies of core modules (e.g. `@vscode/spdlog` → `mkdirp`, `katex` → `commander`) and bundle full packages so `require()` resolution works at runtime
- Prefer source `extensions/` over `.build/extensions/` in dev mode to avoid stale cached builds ([#290](https://github.com/j4rviscmd/vscodeee/pull/290))
- Resolve extension `node_modules` for dev mode via `NODE_PATH` environment variable ([#282](https://github.com/j4rviscmd/vscodeee/pull/282))
- Improve Extension Host sidecar spawn error handling with early-exit detection, stderr capture, and diagnostic log files
- Set `NODE_PATH` in sidecar to point to bundled `node_modules/`

## [0.1.11] - 2026-04-23

### Fixed

- Switch darwin-x64 REH runner from `macos-13` to `macos-latest` to avoid runner exhaustion ([#275](https://github.com/j4rviscmd/vscodeee/pull/275))

## [0.1.10] - 2026-04-23

### Fixed

- Fix 5 TypeScript compilation errors hidden behind prior NLS failure ([#272](https://github.com/j4rviscmd/vscodeee/pull/272))
  - Add `@ts-nocheck` to `pty-poc/src/terminal.ts` for missing `@xterm/addon-fit`
  - Cast `ScriptedMockAgent` destructuring to `any` in `agentHostServerMain.ts`
  - Add `as any` casts for mangler-renamed property access in `terminalInstance.test.ts`

## [0.1.9] - 2026-04-22

### Fixed

- Fix NLS build error: replace variable reference in `localize()` first argument with callback pattern in `shellCommandActions.ts` ([#270](https://github.com/j4rviscmd/vscodeee/pull/270))

## [0.1.8] - 2026-04-22

### Fixed

- Limit mangler worker threads to 1 via `MANGLER_MAX_WORKERS=1` to prevent OOM during REH server builds ([#268](https://github.com/j4rviscmd/vscodeee/pull/268))

## [0.1.0] - 2026-04-20

### Added

- Initial release of VS Codeee — VS Code fork powered by Tauri 2.0
- Tauri desktop builds for macOS (arm64/x64), Windows (x64), Linux (x64)
- REH (Remote Extension Host) server builds for Linux (x64/arm64/armhf) and macOS (arm64/x64)
- Custom title bar with Tauri drag regions
- Extension Host sidecar process management
- IPC bridge between Tauri backend and VS Code frontend
- Tauri-native file watcher, encryption, and window services
