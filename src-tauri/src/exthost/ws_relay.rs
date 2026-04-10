/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! WebSocket ↔ Unix pipe bidirectional byte relay.
//!
//! The renderer (WebView) cannot directly connect to a Unix domain socket.
//! This module creates a local WebSocket server (`127.0.0.1:0`) that acts as
//! a transparent byte relay between the WebSocket connection from TypeScript
//! and the Unix pipe connected to the Extension Host process.
//!
//! The relay is byte-transparent: it does not interpret or modify the VS Code
//! wire protocol — all protocol handling happens in TypeScript via
//! `PersistentProtocol`.

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, UnixStream};

use super::ExtHostError;

/// Result of starting the WebSocket relay.
pub struct WsRelayHandle {
    /// The TCP port the WebSocket server is listening on.
    pub port: u16,
    /// Handle to the relay task (cancel to shut down).
    pub task: tokio::task::JoinHandle<()>,
}

/// Start a WebSocket relay that bridges a browser WebSocket to a Unix stream.
///
/// 1. Binds a TCP listener to `127.0.0.1:0` (OS-assigned port).
/// 2. Accepts exactly one WebSocket connection.
/// 3. Relays bytes bidirectionally between the WebSocket and `unix_stream`.
/// 4. Shuts down when either side closes.
///
/// # Arguments
/// * `unix_stream` — The connected Unix domain socket to the Extension Host.
///
/// # Returns
/// A [`WsRelayHandle`] with the allocated port and task handle.
pub async fn start_ws_relay(unix_stream: UnixStream) -> Result<WsRelayHandle, ExtHostError> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| ExtHostError::Io(e))?;

    let port = listener
        .local_addr()
        .map_err(|e| ExtHostError::Io(e))?
        .port();

    log::info!(
        target: "vscodeee::exthost::ws_relay",
        "WebSocket relay listening on ws://127.0.0.1:{port}"
    );

    let task = tokio::spawn(async move {
        if let Err(e) = relay_loop(listener, unix_stream).await {
            log::error!(
                target: "vscodeee::exthost::ws_relay",
                "Relay error: {e}"
            );
        }
    });

    Ok(WsRelayHandle { port, task })
}

/// Accept exactly one WebSocket connection and relay bytes bidirectionally
/// to/from the Unix stream.
///
/// The relay runs two concurrent tasks (via `tokio::select!`):
/// - **WS → Unix pipe**: Reads binary WebSocket frames and writes raw bytes
///   to the Unix stream. Text, ping, and pong frames are silently ignored.
/// - **Unix pipe → WS**: Reads raw bytes from the Unix stream (64 KB buffer)
///   and sends them as binary WebSocket frames.
///
/// The relay terminates when either direction encounters an error, EOF, or
/// a WebSocket close frame.
async fn relay_loop(
    listener: TcpListener,
    unix_stream: UnixStream,
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

    // Split the Unix stream
    let (mut unix_read, mut unix_write) = tokio::io::split(unix_stream);

    // Relay: WebSocket → Unix pipe
    let ws_to_unix = async {
        let mut count: u64 = 0;
        while let Some(msg) = ws_read.next().await {
            match msg {
                Ok(tokio_tungstenite::tungstenite::Message::Binary(data)) => {
                    count += 1;
                    if count <= 20 || count % 100 == 0 {
                        log::info!(
                            target: "vscodeee::exthost::ws_relay",
                            "WS→pipe #{count}: {len} bytes, first4={first4:?}",
                            len = data.len(),
                            first4 = &data[..std::cmp::min(4, data.len())]
                        );
                    }
                    if unix_write.write_all(&data).await.is_err() {
                        log::error!(target: "vscodeee::exthost::ws_relay", "WS→pipe: write_all failed");
                        break;
                    }
                }
                Ok(tokio_tungstenite::tungstenite::Message::Close(_)) => {
                    log::info!(target: "vscodeee::exthost::ws_relay", "WS→pipe: received Close");
                    break;
                }
                Err(e) => {
                    log::error!(target: "vscodeee::exthost::ws_relay", "WS→pipe: read error: {e}");
                    break;
                }
                _ => {} // Ignore text/ping/pong
            }
        }
        let _ = unix_write.shutdown().await;
    };

    // Relay: Unix pipe → WebSocket
    let unix_to_ws = async {
        let mut buf = vec![0u8; 64 * 1024]; // 64KB buffer
        let mut count: u64 = 0;
        loop {
            match unix_read.read(&mut buf).await {
                Ok(0) => {
                    log::info!(target: "vscodeee::exthost::ws_relay", "pipe→WS: EOF");
                    break;
                }
                Ok(n) => {
                    count += 1;
                    if count <= 20 || count % 100 == 0 {
                        log::info!(
                            target: "vscodeee::exthost::ws_relay",
                            "pipe→WS #{count}: {n} bytes, first4={first4:?}",
                            first4 = &buf[..std::cmp::min(4, n)]
                        );
                    }
                    let msg = tokio_tungstenite::tungstenite::Message::Binary(buf[..n].into());
                    if ws_write.send(msg).await.is_err() {
                        log::error!(target: "vscodeee::exthost::ws_relay", "pipe→WS: send failed");
                        break;
                    }
                }
                Err(e) => {
                    log::error!(target: "vscodeee::exthost::ws_relay", "pipe→WS: read error: {e}");
                    break;
                }
            }
        }
        let _ = ws_write.close().await;
    };

    // Run both directions concurrently; finish when either side closes
    tokio::select! {
        _ = ws_to_unix => {},
        _ = unix_to_ws => {},
    }

    log::info!(
        target: "vscodeee::exthost::ws_relay",
        "Relay connection closed"
    );

    Ok(())
}
