/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Tauri commands for the VS Code binary IPC protocol.
//!
//! These commands handle the WebView ↔ Rust message-passing transport.
//! Messages are base64-encoded `VSBuffer` payloads that match VS Code's
//! wire protocol exactly.

use std::sync::Arc;

use crate::ipc::channel::ChannelRouter;

/// Handle an incoming IPC message from the WebView.
///
/// The TypeScript `TauriMessagePassingProtocol.send()` calls this command
/// with a base64-encoded binary payload. The `ChannelRouter` decodes and
/// dispatches it to the appropriate handler.
#[tauri::command]
pub async fn ipc_message(
    window_id: u32,
    data: String,
    router: tauri::State<'_, Arc<ChannelRouter>>,
) -> Result<(), String> {
    router.dispatch(window_id, &data).await;
    Ok(())
}

/// Perform the IPC handshake for a window.
///
/// Called once per window during `TauriIPCClient` initialization.
/// Returns the window ID to confirm the connection is established.
#[tauri::command]
pub async fn ipc_handshake(window_id: u32) -> Result<u32, String> {
    log::info!(target: "vscodeee::commands::ipc_channel", "Handshake for window {window_id}");
    Ok(window_id)
}
