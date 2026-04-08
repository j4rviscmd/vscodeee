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
    /// The message is base64-encoded binary data. This method decodes it,
    /// passes it to the appropriate channel handler, and sends the response
    /// back via the EventBus.
    pub async fn dispatch(&self, window_id: u32, data: &str) {
        let raw = match STANDARD.decode(data) {
            Ok(bytes) => bytes,
            Err(e) => {
                log::error!(target: "vscodeee::ipc::channel", "Failed to decode base64 message: {e}");
                return;
            }
        };

        // For Phase 1, we echo back the message as-is to establish the
        // bidirectional transport. As channels are implemented, this will
        // route to specific handlers based on the channel name extracted
        // from the binary protocol header.
        let response = STANDARD.encode(&raw);
        self.event_bus.emit_to_window(window_id, &response).await;
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
