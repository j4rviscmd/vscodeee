/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! VS Codee デスクトップアプリケーションのエントリポイント。
//!
//! リリースビルドでは `windows_subsystem = "windows"` により
//! Windowsでのコンソールウィンドウ表示を抑制する。

/// アプリケーションのメインエントリポイント。
///
/// [`vscodee_lib::run()`] に処理を委譲し、Tauriアプリケーションを起動する。
fn main() {
    vscodee_lib::run()
}
