> [!IMPORTANT]
> v0.6.0以下を利用している場合は、自動アップデート機能が実装されていません。
> 手動でv0.7.0以上にアップデートしてください

<div align="center">

# VS Codeee

<img src="./docs/screenshots/workbench_frieren_background.png" alt="VS Codeee">

[English](README.md) | 日本語

[![Windows](https://img.shields.io/badge/Windows-Supported-0078D6?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/j4rviscmd/vscodeee/releases/latest)
[![macOS](https://img.shields.io/badge/macOS-Supported-000000?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/j4rviscmd/vscodeee/releases/latest)
[![Linux](https://img.shields.io/badge/Linux-Supported-FCC624?style=for-the-badge&logo=linux&logoColor=black)](https://github.com/j4rviscmd/vscodeee/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/j4rviscmd/vscodeee/total?style=for-the-badge&logo=github)](https://github.com/j4rviscmd/vscodeee/releases/latest)
[![Latest Release](https://img.shields.io/github/v/release/j4rviscmd/vscodeee?style=for-the-badge&label=Latest&logo=github)](https://github.com/j4rviscmd/vscodeee/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/j4rviscmd/vscodeee/ci.yml?style=for-the-badge&label=CI&logo=githubactions)](https://github.com/j4rviscmd/vscodeee/actions)
[![License](https://img.shields.io/badge/License-MIT-018FF5?style=for-the-badge&logo=opensourceinitiative)](./LICENSE.txt)

## Tauri 2.0 で VSCode を動かすプロジェクト

</div>

## 開発のモチベーション

本家VSCodeは神エディタですが、Electronベースのアーキテクチャはメモリ使用量が多い、また、Neovimmer(`neovim-vscode`)な私にとってtmuxライクな操作性が再現できないことに不満を感じていました。<br>
OSSと言えど、大規模プロジェクトであるため、これまでは手を出せずにいましたが、昨今のLLMは人より賢くvibe-codingであれば、前述した課題間を解決できるのではないかと考え、VSCodeeeを開発することにしました。<br>
本職の片手間で開発しているため、機能の実装やバグ修正が遅れることがありますが、ご了承ください。<br>
バグ報告や機能追加といったissueは歓迎しますので、気軽に投稿してください。

## 目的

VSCode の現在の機能を維持しつつ、以下を実現します：

- **メモリ使用量の削減**: Electron → Tauri 2.0（バンドルされた Chromium の代わりにネイティブ WebView を使用）
- **不要なテレメトリの削減**: Microsoft へのテレメトリ送信を廃止
- **バイナリサイズの縮小**: Chromium をバンドルしない（システム WebView を使用）。拡張機能ホストサポートのため Node.js は引き続きバンドルします
- **透明背景**（実験的）: ネイティブウィンドウの透明性サポート（macOS/Linux）— エディタ越しにデスクトップが見えます
  - 今後のリリースで、ウィンドウ全体の透明化やブラー効果など、さらに高度な外観オプションを検中
  - <img src="./docs/screenshots/settings_transparent.png" alt="透明エディタの設定" width="300">
- [Vimmerのための設定やキーバインドの追加](#vscodeee独自の機能)
- 定期的に本家VSCodeのアップストリームをマージし、最新の機能とセキュリティ修正を維持予定

---

## インストール

| プラットフォーム      | インストーラ                                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS (Apple Silicon) | [`.dmg`](https://github.com/j4rviscmd/vscodeee/releases/latest/download/VSCodeee_macOS_arm64.dmg)                                                                                                           |
| macOS (Intel)         | [`.dmg`](https://github.com/j4rviscmd/vscodeee/releases/latest/download/VSCodeee_macOS_x64.dmg)                                                                                                             |
| Linux                 | [`.AppImage`](https://github.com/j4rviscmd/vscodeee/releases/latest/download/VSCodeee_Linux_x64.AppImage) / [`.deb`](https://github.com/j4rviscmd/vscodeee/releases/latest/download/VSCodeee_Linux_x64.deb) |
| Windows               | [`.exe`](https://github.com/j4rviscmd/vscodeee/releases/latest/download/VSCodeee_Windows_x64-setup.exe)                                                                                                     |

> [!NOTE]
> macOS ビルドはアドホックコード署名を使用しています（Apple 公証なし）。初回起動時は **システム設定 > プライバシーとセキュリティ** で「このまま開く」をクリックしてください。または以下を実行：
>
> ```bash
> xattr -dr com.apple.quarantine "/Applications/VS Codeee.app"
> ```

> [!NOTE]
> 本プロジェクトは主に **macOS** で開発・テストされています。Windows および Linux ビルドも提供していますが、これらのプラットフォームでは検証されていません。
> 問題が発生した場合は、[Issue を作成](https://github.com/j4rviscmd/vscodeee/issues/new?template=bug_report.md)してください。

---

## アーキテクチャ

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/screenshots/vscodeee_architecture_dark.png">
  <img src="./docs/screenshots/vscodeee_architecture_light.png" alt="VSCodeee Architecture">
</picture>

> **Note**: Shared Process（VS Code のギャラリー、同期、テレメトリ用の非表示レンダラー）は VSCodeee では**排除**されています。そのサービスは WebView または Rust バックエンドで直接実装されています — [#88](https://github.com/j4rviscmd/vscodeee/issues/88) を参照。

---

## VSCodeee独自の機能

- tmuxライクなPane操作キーバインド
  - Paneサイズ調整コマンドを実装
    - `vscodeee.workbench.editor.resizePaneRight`
    - `vscodeee.workbench.editor.resizePaneLeft`
    - `vscodeee.workbench.editor.resizePaneUp`
    - `vscodeee.workbench.editor.resizePaneDown`
- エディタグループのプレフィックスにインデックスを表示(tmuxのprefix + `n`向け)
  - `"vscodeee.workbench.editor.editorGroupIndexInTab": true`
- 最小Paneにフォーカスすると自動的に対象Paneが最大化されることを抑制する
  - `"vscodeee.workbench.editor.autoMaximizeOnFocus": false`
  - 本家VSCodeの[issue#85309](https://github.com/microsoft/vscode/issues/85309)

---

## MVP で除外される機能

以下の機能は Chrome DevTools Protocol (CDP) に依存しており、Tauri のネイティブ WebView（WKWebView / WebView2 / WebKitGTK）では公開 API がありません。MVP スコープから除外されています。

| 機能                                     | 理由                                                    |
| ---------------------------------------- | ------------------------------------------------------- |
| AI Browser Tools（Copilot Web 自動化）   | CDP 依存（クリック/ドラッグ/タイプ/スクリーンショット） |
| `vscode.BrowserTab` API（proposed）      | CDP 依存、マーケットプレースでの採用なし                |
| Playwright インテグレーション            | CDP 依存のブラウザ自動化                                |
| 要素インスペクション（`getElementData`） | CDP 依存の DOM インスペクション                         |
| コンソールログキャプチャ                 | CDP 依存のプログラムによるコンソールアクセス            |

以下のネイティブホストサービス機能は MVP 後に延期：

| 機能                          | 理由                                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Microsoft アカウントログイン  | バンドルされている `microsoft-authentication` 拡張機能には `@azure/msal-node` が含まれており動作する可能性がありますが、Tauri 環境では検証されていません。 |
| クライアント資格情報認証      | MVP では認可コードフローのみサポート。クライアント資格情報フロー（`client_id` + `client_secret`）は MVP 後に延期。                                         |
| システムプロキシ解決          | プラットフォーム固有の API（CFNetwork、WinHTTP、libproxy）が必要。`resolve_proxy` コマンドは `None`（直接接続）を返します。                                |
| システム証明書読み込み        | `load_certificates` コマンドは空のリストを返します。拡張機能が各自の証明書読み込みを処理します。                                                           |
| Kerberos 認証                 | `lookupKerberosAuthorization` は `undefined` を返します。Kerberos ライブラリが必要 — エンタープライズ AD 環境外ではほぼ不要。                              |
| ウィンドウスプラッシュ永続化  | `saveWindowSplash` は no-op です。スプラッシュデータは `ISplashStorageService` を通じて `localStorage` で永続化されます。                                  |
| macOS Touch Bar               | Tauri の WebView ではサポートされていません。Touch Bar API メソッドは no-op です。                                                                         |
| macOS タブ管理                | ウィンドウタブ API（`newWindowTab`、`mergeAllWindowTabs` など）は no-op です。                                                                             |
| GPU 情報 / コンテンツトレース | `openGPUInfoWindow`、`openContentTracingWindow`、`startTracing`、`stopTracing` は no-op です。                                                             |
| スクリーンショットキャプチャ  | `getScreenshot` は `undefined` を返します。プラットフォーム固有のスクリーンキャプチャ API が必要です。                                                     |

> [!TIP]
> Tauri が将来的に CDP サポートを追加した場合、または代替アプローチが実現可能になった場合、これらの機能が再検討される可能性があります。

## 既知の制限事項

Electron（バンドルされた Chromium）と Tauri（ネイティブシステム WebView）のアーキテクチャの違いにより、永続的またはプラットフォーム固有の制限があります。

| 機能                      | 制限                                                                                                                                                                                                      | プラットフォーム詳細                                                                                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setBackgroundThrottling` | WebView 内部の JS タイマー/アニメーションのスロットリングは外部から制御不可                                                                                                                               | 全プラットフォーム — `NSProcessInfo.beginActivity()`（macOS）で OS レベルのスロットリングを防げますが、WebView 内部の動作は制御できません。                                                                |
| 設定同期                  | 内蔵の設定同期は利用不可。上流の同期サービスは公式 VS Code ビルド専用にライセンスされています。                                                                                                           | 全プラットフォーム — サードパーティの拡張機能（例: [Settings Sync](https://marketplace.visualstudio.com/items?itemName=Shan.code-settings-sync)）で GitHub Gist 経由で同期する代替手段を使用してください。 |
| リモートトンネル          | 内蔵のリモートトンネルは利用不可。トンネルリレーインフラは Microsoft（Azure Dev Tunnels）がホストしており、サードパーティビルドからはアクセスできません。リモート開発には Remote-SSH を使用してください。 | 全プラットフォーム — 詳細は [#100](https://github.com/j4rviscmd/vscodeee/issues/100) を参照。代替として Remote-SSH が利用可能です（[#185](https://github.com/j4rviscmd/vscodeee/issues/185)）。            |

> [!NOTE]
> このリストは固有のプラットフォーム制限をカバーしています。単にまだ実装されていない機能は個別の GitHub Issue で追跡されています。

## ライセンス

MIT License — 詳細は [LICENSE](./LICENSE.txt) を参照。
