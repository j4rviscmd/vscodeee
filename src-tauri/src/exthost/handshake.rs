/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Extension Host handshake state machine.
//!
//! Orchestrates the Ready→InitData→Initialized exchange over the connected socket.
//!
//! Sequence (mirrors `connectToRenderer()` at `extensionHostProcess.ts:332-395`):
//! 1. Read `Resume` — PersistentProtocol sends this immediately upon construction
//! 2. Read `Ready` (body=`[0x02]`) — ExtHost signals it's ready for init data
//! 3. Write `InitData` (body=JSON) — Rust sends minimal IExtensionHostInitData
//! 4. Read `Initialized` (body=`[0x01]`) — ExtHost confirms handshake complete
//!
//! # TODO: Production (Phase 1-2)
//!
//! In the clean architecture, the handshake is handled entirely by the TypeScript
//! `TauriLocalProcessExtensionHost` via `PersistentProtocol` over WebSocket.
//! This Rust-side handshake implementation becomes unnecessary (or debug-only).

use std::time::Instant;

use tokio::io::{AsyncRead, AsyncWrite};

use super::protocol::{self, ProtocolMessage, ProtocolMessageType};
use super::{init_data, ExtHostError};

/// Result of a successful handshake.
pub struct HandshakeResult {
    /// Human-readable log of each message exchanged.
    pub messages: Vec<String>,
    /// Total handshake duration in milliseconds.
    pub duration_ms: u64,
}

/// Application-level message types carried inside Regular transport messages.
/// Mirrors `MessageType` at `extensionHostProtocol.ts:104-108`.
const MESSAGE_TYPE_INITIALIZED: u8 = 0x01;
const MESSAGE_TYPE_READY: u8 = 0x02;

/// Handshake timeout for each protocol step (seconds).
const HANDSHAKE_TIMEOUT_SECS: u64 = 30;

/// Run the Extension Host handshake protocol over a connected IPC stream.
///
/// Returns `Ok(HandshakeResult)` if the full 4-message exchange completes,
/// or an `ExtHostError` on timeout, protocol violation, or IO error.
pub async fn run_handshake<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
) -> Result<HandshakeResult, ExtHostError> {
    let start = Instant::now();
    let mut messages = Vec::new();
    let mut rust_msg_id: u32 = 0;
    let mut last_exthost_msg_id: u32 = 0;

    let (mut reader, mut writer) = stream.split();

    // Step 1: Wait for Resume (may also get KeepAlive — skip non-Resume)
    // PersistentProtocol sends Resume immediately upon construction (ipc.net.ts:929-931)
    wait_for_resume(&mut reader, &mut messages).await?;

    // Step 2: Wait for Ready (Regular message with body=[0x02])
    // Sent by connectToRenderer() at extensionHostProcess.ts:393
    last_exthost_msg_id = wait_for_ready(&mut reader, &mut messages).await?;

    // Step 3: Send InitData as a Regular message
    rust_msg_id += 1;
    let init_data_json = init_data::build_minimal_init_data();
    let init_data_bytes = init_data_json.into_bytes();
    let init_msg = ProtocolMessage::regular(rust_msg_id, last_exthost_msg_id, init_data_bytes);
    let log_line = format!(
        "send: type=Regular id={} ack={} data_len={}",
        init_msg.id,
        init_msg.ack,
        init_msg.data.len()
    );
    log::debug!(target: "vscodeee::exthost::handshake", "{log_line}");
    messages.push(log_line);
    protocol::write_message(&mut writer, &init_msg).await?;
    log::info!(target: "vscodeee::exthost::handshake", "Sent InitData ({} bytes)", init_msg.data.len());

    // Step 4: Wait for Initialized (Regular message with body=[0x01])
    // Sent by connectToRenderer() at extensionHostProcess.ts:387
    wait_for_initialized(&mut reader, &mut messages).await?;

    let duration = start.elapsed();
    log::info!(
        target: "vscodeee::exthost::handshake",
        "Handshake complete in {}ms",
        duration.as_millis()
    );

    Ok(HandshakeResult {
        messages,
        duration_ms: duration.as_millis() as u64,
    })
}

/// Read one message from the stream and log it, returning the message.
async fn read_and_log<S: AsyncRead + AsyncWrite + Unpin>(
    reader: &mut tokio::io::ReadHalf<S>,
    messages: &mut Vec<String>,
    detail: &str,
) -> Result<ProtocolMessage, ExtHostError> {
    let msg = protocol::read_message(reader).await?;
    let truncated = &msg.data[..msg.data.len().min(16)];
    let log_line = format!(
        "recv: type={:?} id={} ack={} {detail}={truncated:?}",
        msg.msg_type, msg.id, msg.ack
    );
    log::debug!(target: "vscodeee::exthost::handshake", "{log_line}");
    messages.push(log_line);
    Ok(msg)
}

/// Step 1: Wait for a Resume message, skipping KeepAlive frames.
async fn wait_for_resume<S: AsyncRead + AsyncWrite + Unpin>(
    reader: &mut tokio::io::ReadHalf<S>,
    messages: &mut Vec<String>,
) -> Result<(), ExtHostError> {
    tokio::time::timeout(
        tokio::time::Duration::from_secs(HANDSHAKE_TIMEOUT_SECS),
        async {
            loop {
                let msg = read_and_log(reader, messages, "data_len").await?;
                match msg.msg_type {
                    ProtocolMessageType::Resume => {
                        log::info!(target: "vscodeee::exthost::handshake", "Received Resume");
                        return Ok::<(), ExtHostError>(());
                    }
                    ProtocolMessageType::KeepAlive => continue,
                    other => {
                        return Err(ExtHostError::Protocol(format!(
                            "Expected Resume, got {other:?}"
                        )));
                    }
                }
            }
        },
    )
    .await
    .map_err(|_| ExtHostError::Timeout)??;
    Ok(())
}

/// Step 2: Wait for a Ready message (Regular with body=[0x02]), skipping
/// KeepAlive and Ack frames. Returns the ExtHost's last message ID.
async fn wait_for_ready<S: AsyncRead + AsyncWrite + Unpin>(
    reader: &mut tokio::io::ReadHalf<S>,
    messages: &mut Vec<String>,
) -> Result<u32, ExtHostError> {
    let msg_id = tokio::time::timeout(tokio::time::Duration::from_secs(HANDSHAKE_TIMEOUT_SECS), async {
        loop {
            let msg = read_and_log(reader, messages, "body").await?;
            match msg.msg_type {
                ProtocolMessageType::Regular => {
                    if msg.data.len() == 1 && msg.data[0] == MESSAGE_TYPE_READY {
                        log::info!(target: "vscodeee::exthost::handshake", "Received Ready (0x02)");
                        return Ok::<u32, ExtHostError>(msg.id);
                    }
                    return Err(ExtHostError::Protocol(format!(
                        "Expected Ready body [0x02], got {:?}",
                        msg.data
                    )));
                }
                ProtocolMessageType::KeepAlive | ProtocolMessageType::Ack => continue,
                other => {
                    return Err(ExtHostError::Protocol(format!(
                        "Expected Regular(Ready), got {other:?}"
                    )));
                }
            }
        }
    })
    .await
    .map_err(|_| ExtHostError::Timeout)??;
    Ok(msg_id)
}

/// Step 4: Wait for an Initialized message (Regular with body=[0x01]),
/// skipping KeepAlive, Ack, and other non-matching frames.
async fn wait_for_initialized<S: AsyncRead + AsyncWrite + Unpin>(
    reader: &mut tokio::io::ReadHalf<S>,
    messages: &mut Vec<String>,
) -> Result<(), ExtHostError> {
    tokio::time::timeout(tokio::time::Duration::from_secs(HANDSHAKE_TIMEOUT_SECS), async {
        loop {
            let msg = read_and_log(reader, messages, "body").await?;
            match msg.msg_type {
                ProtocolMessageType::Regular => {
                    if msg.data.len() == 1 && msg.data[0] == MESSAGE_TYPE_INITIALIZED {
                        log::info!(target: "vscodeee::exthost::handshake", "Received Initialized (0x01)");
                        return Ok::<(), ExtHostError>(());
                    }
                    // Could be other Regular messages — skip for PoC
                }
                _ => continue, // Be lenient: skip KeepAlive, Ack, etc.
            }
        }
    })
    .await
    .map_err(|_| ExtHostError::Timeout)??;
    Ok(())
}
