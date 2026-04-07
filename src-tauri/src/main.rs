/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! VS Codeee デスクトップアプリケーションのエントリポイント。
//!
//! リリースビルドでは `windows_subsystem = "windows"` により
//! Windowsでのコンソールウィンドウ表示を抑制する。

/// アプリケーションのメインエントリポイント。
///
/// [`vscodeee_lib::run()`] に処理を委譲し、Tauriアプリケーションを起動する。
fn main() {
    vscodeee_lib::run()
}
