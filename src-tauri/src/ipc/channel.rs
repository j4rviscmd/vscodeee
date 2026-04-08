/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Channel routing and dispatch for VS Code's IPC protocol.
//!
//! The `ChannelRouter` receives base64-encoded binary messages from the WebView,
//! decodes them, and dispatches to registered channel handlers. Responses are
//! sent back via [`EventBus`](super::event_bus::EventBus).

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use super::event_bus::EventBus;

/// A handler for a single IPC channel.
///
/// Receives raw request bytes and returns raw response bytes.
/// The binary format follows VS Code's VQL-encoded wire protocol.
pub type ChannelHandler = Arc<
    dyn Fn(Vec<u8>) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<u8>> + Send>>
        + Send
        + Sync,
>;

/// Routes incoming IPC messages to registered channel handlers.
///
/// In Phase 1, most channels return "not implemented" responses.
/// As services are migrated to Rust, handlers are registered here.
pub struct ChannelRouter {
    handlers: RwLock<HashMap<String, ChannelHandler>>,
    event_bus: Arc<EventBus>,
}

impl ChannelRouter {
    pub fn new(event_bus: Arc<EventBus>) -> Self {
        Self {
            handlers: RwLock::new(HashMap::new()),
            event_bus,
        }
    }

    /// Register a handler for a named channel.
    pub async fn register(&self, channel_name: &str, handler: ChannelHandler) {
        self.handlers
            .write()
            .await
            .insert(channel_name.to_string(), handler);
    }

    /// Dispatch an incoming message from the WebView.
    ///
    /// The message is base64-encoded binary data. This method decodes it
    /// and routes to the appropriate channel handler. If no handler is
    /// registered, the message is silently dropped.
    ///
    /// **Note**: Phase 1 had an echo router here that re-encoded and
    /// emitted the message back. This was removed because echoing
    /// corrupts VS Code's `ChannelClient`/`ChannelServer` handshake —
    /// the context string and Initialize message get echoed back and
    /// misinterpreted by both sides.
    pub async fn dispatch(&self, window_id: u32, data: &str) {
        let raw = match STANDARD.decode(data) {
            Ok(bytes) => bytes,
            Err(e) => {
                log::error!(target: "vscodeee::ipc::channel", "Failed to decode base64 message: {e}");
                return;
            }
        };

        // TODO(Phase 3): Parse the binary protocol header to extract
        // the channel name, then route to the registered handler.
        // For Phase 2, incoming IPC messages are silently dropped
        // since all services use direct invoke() calls instead.
        eprintln!(
            "[IPC] Received {} bytes from window {} (no channel routing yet, dropping)",
            raw.len(),
            window_id
        );
    }

    pub fn event_bus(&self) -> &Arc<EventBus> {
        &self.event_bus
    }
}

/// Metadata about an IPC message exchange (for logging/debugging).
#[derive(Debug, Serialize, Deserialize)]
pub struct IpcMessageMeta {
    pub window_id: u32,
    pub data_len: usize,
}
