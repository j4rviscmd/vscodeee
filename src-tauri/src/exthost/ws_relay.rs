/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! WebSocket ↔ IPC pipe bidirectional byte relay.
//!
//! The renderer (WebView) cannot directly connect to a Unix domain socket or
//! Windows named pipe. This module creates a local WebSocket server
//! (`127.0.0.1:0`) that acts as a transparent byte relay between the WebSocket
//! connection from TypeScript and the IPC pipe connected to the Extension Host
//! process.
//!
//! The relay is byte-transparent: it does not interpret or modify the VS Code
//! wire protocol — all protocol handling happens in TypeScript via
//! `PersistentProtocol`.

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::{ExtHostError, IpcStream};

/// Result of starting the WebSocket relay.
pub struct WsRelayHandle {
    /// The TCP port the WebSocket server is listening on.
    pub port: u16,
    /// Handle to the relay task (cancel to shut down).
    pub task: tokio::task::JoinHandle<()>,
}

/// Start a WebSocket relay that bridges a browser WebSocket to an IPC stream.
///
/// 1. Binds a TCP listener to `127.0.0.1:0` (OS-assigned port).
/// 2. Accepts exactly one WebSocket connection.
/// 3. Relays bytes bidirectionally between the WebSocket and `ipc_stream`.
/// 4. Shuts down when either side closes.
///
/// # Arguments
/// * `ipc_stream` — The connected IPC stream to the Extension Host.
///
/// # Returns
/// A [`WsRelayHandle`] with the allocated port and task handle.
pub async fn start_ws_relay(ipc_stream: IpcStream) -> Result<WsRelayHandle, ExtHostError> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(ExtHostError::Io)?;

    let port = listener.local_addr().map_err(ExtHostError::Io)?.port();

    log::info!(
        target: "vscodeee::exthost::ws_relay",
        "WebSocket relay listening on ws://127.0.0.1:{port}"
    );

    let task = tokio::spawn(async move {
        if let Err(e) = relay_loop(listener, ipc_stream).await {
            log::error!(
                target: "vscodeee::exthost::ws_relay",
                "Relay error: {e}"
            );
        }
    });

    Ok(WsRelayHandle { port, task })
}

/// Accept exactly one WebSocket connection and relay bytes bidirectionally
/// to/from the IPC stream.
///
/// The relay runs two concurrent tasks (via `tokio::select!`):
/// - **WS → IPC pipe**: Reads binary WebSocket frames and writes raw bytes
///   to the IPC stream. Text, ping, and pong frames are silently ignored.
/// - **IPC pipe → WS**: Reads raw bytes from the IPC stream (64 KB buffer)
///   and sends them as binary WebSocket frames.
///
/// The relay terminates when either direction encounters an error, EOF, or
/// a WebSocket close frame.
async fn relay_loop(
    listener: TcpListener,
    ipc_stream: IpcStream,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Accept exactly one TCP connection
    let (tcp_stream, addr) = listener.accept().await?;
    log::info!(
        target: "vscodeee::exthost::ws_relay",
        "WebSocket client connected from {addr}"
    );

    // Upgrade to WebSocket
    let ws_stream = tokio_tungstenite::accept_async(tcp_stream).await?;
    let (mut ws_write, mut ws_read) = ws_stream.split();

    // Split the IPC stream
    let (mut ipc_read, mut ipc_write) = tokio::io::split(ipc_stream);

    // Relay: WebSocket → IPC pipe
    let ws_to_ipc = async {
        let mut count: u64 = 0;
        let mut total_bytes: u64 = 0;
        while let Some(msg) = ws_read.next().await {
            match msg {
                Ok(tokio_tungstenite::tungstenite::Message::Binary(data)) => {
                    count += 1;
                    total_bytes += data.len() as u64;
                    if count <= 50 || count.is_multiple_of(100) {
                        log::debug!(
                            target: "vscodeee::exthost::ws_relay",
                            "WS→IPC #{count}: {len} bytes (total={total_bytes})",
                            len = data.len(),
                        );
                    }
                    if let Err(e) = ipc_write.write_all(&data).await {
                        log::error!(target: "vscodeee::exthost::ws_relay", "WS→IPC: write_all failed: {e}");
                        break;
                    }
                    if let Err(e) = ipc_write.flush().await {
                        log::error!(target: "vscodeee::exthost::ws_relay", "WS→IPC: flush failed: {e}");
                        break;
                    }
                }
                Ok(tokio_tungstenite::tungstenite::Message::Close(_)) => {
                    log::info!(target: "vscodeee::exthost::ws_relay", "WS→IPC: received Close (sent {count} msgs, {total_bytes} bytes total)");
                    break;
                }
                Err(e) => {
                    log::error!(target: "vscodeee::exthost::ws_relay", "WS→IPC: read error: {e} (after {count} msgs)");
                    break;
                }
                _ => {} // Ignore text/ping/pong
            }
        }
        log::info!(target: "vscodeee::exthost::ws_relay", "WS→IPC: loop ended, {count} msgs, {total_bytes} bytes total");
        let _ = ipc_write.shutdown().await;
    };

    // Relay: IPC pipe → WebSocket
    let ipc_to_ws = async {
        let mut buf = vec![0u8; 64 * 1024]; // 64KB read buffer
        let mut count: u64 = 0;
        let mut total_bytes: u64 = 0;
        loop {
            match ipc_read.read(&mut buf).await {
                Ok(0) => {
                    log::info!(target: "vscodeee::exthost::ws_relay", "IPC→WS: EOF (sent {count} msgs, {total_bytes} bytes total)");
                    break;
                }
                Ok(n) => {
                    count += 1;
                    total_bytes += n as u64;
                    if count <= 50 || count.is_multiple_of(100) {
                        log::debug!(
                            target: "vscodeee::exthost::ws_relay",
                            "IPC→WS #{count}: {n} bytes (total={total_bytes})",
                        );
                    }
                    let msg = tokio_tungstenite::tungstenite::Message::Binary(buf[..n].into());
                    if let Err(e) = ws_write.send(msg).await {
                        log::error!(target: "vscodeee::exthost::ws_relay", "IPC→WS: send failed: {e} (after {count} msgs)");
                        break;
                    }
                }
                Err(e) => {
                    log::error!(target: "vscodeee::exthost::ws_relay", "IPC→WS: read error: {e} (after {count} msgs)");
                    break;
                }
            }
        }
        log::info!(target: "vscodeee::exthost::ws_relay", "IPC→WS: loop ended, {count} msgs, {total_bytes} bytes total");
        let _ = ws_write.close().await;
    };

    // Run both directions concurrently; finish when either side closes
    tokio::select! {
        _ = ws_to_ipc => {},
        _ = ipc_to_ws => {},
    }

    log::info!(
        target: "vscodeee::exthost::ws_relay",
        "Relay connection closed"
    );

    Ok(())
}
