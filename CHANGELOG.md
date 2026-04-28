# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
