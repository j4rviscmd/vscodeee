/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codee Contributors. All rights reserved.
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

use tokio::net::UnixStream;

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

/// Run the Extension Host handshake protocol over a connected Unix stream.
///
/// Returns `Ok(HandshakeResult)` if the full 4-message exchange completes,
/// or an `ExtHostError` on timeout, protocol violation, or IO error.
pub async fn run_handshake(stream: &mut UnixStream) -> Result<HandshakeResult, ExtHostError> {
    let start = Instant::now();
    let mut messages = Vec::new();
    let mut rust_msg_id: u32 = 0;
    let mut last_exthost_msg_id: u32 = 0;

    let (mut reader, mut writer) = stream.split();

    // Step 1: Wait for Resume (may also get KeepAlive — skip non-Resume)
    // PersistentProtocol sends Resume immediately upon construction (ipc.net.ts:929-931)
    let resume_timeout = tokio::time::Duration::from_secs(30);
    tokio::time::timeout(resume_timeout, async {
        loop {
            let msg = protocol::read_message(&mut reader).await?;
            let log_line = format!(
                "← recv: type={:?} id={} ack={} data_len={}",
                msg.msg_type,
                msg.id,
                msg.ack,
                msg.data.len()
            );
            println!("[exthost] {log_line}");
            messages.push(log_line);

            match msg.msg_type {
                ProtocolMessageType::Resume => {
                    println!("[exthost] ✓ Received Resume");
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
    })
    .await
    .map_err(|_| ExtHostError::Timeout)??;

    // Step 2: Wait for Ready (Regular message with body=[0x02])
    // Sent by connectToRenderer() at extensionHostProcess.ts:393
    let ready_timeout = tokio::time::Duration::from_secs(30);
    tokio::time::timeout(ready_timeout, async {
        loop {
            let msg = protocol::read_message(&mut reader).await?;
            let log_line = format!(
                "← recv: type={:?} id={} ack={} body={:?}",
                msg.msg_type,
                msg.id,
                msg.ack,
                &msg.data[..msg.data.len().min(16)]
            );
            println!("[exthost] {log_line}");
            messages.push(log_line);

            match msg.msg_type {
                ProtocolMessageType::Regular => {
                    last_exthost_msg_id = msg.id;
                    if msg.data.len() == 1 && msg.data[0] == MESSAGE_TYPE_READY {
                        println!("[exthost] ✓ Received Ready (0x02)");
                        return Ok::<(), ExtHostError>(());
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

    // Step 3: Send InitData as a Regular message
    rust_msg_id += 1;
    let init_data_json = init_data::build_minimal_init_data();
    let init_data_bytes = init_data_json.into_bytes();
    let init_msg = ProtocolMessage::regular(rust_msg_id, last_exthost_msg_id, init_data_bytes);
    let log_line = format!(
        "→ send: type=Regular id={} ack={} data_len={}",
        init_msg.id,
        init_msg.ack,
        init_msg.data.len()
    );
    println!("[exthost] {log_line}");
    messages.push(log_line);
    protocol::write_message(&mut writer, &init_msg).await?;
    println!("[exthost] ✓ Sent InitData ({} bytes)", init_msg.data.len());

    // Step 4: Wait for Initialized (Regular message with body=[0x01])
    // Sent by connectToRenderer() at extensionHostProcess.ts:387
    let init_timeout = tokio::time::Duration::from_secs(30);
    tokio::time::timeout(init_timeout, async {
        loop {
            let msg = protocol::read_message(&mut reader).await?;
            let log_line = format!(
                "← recv: type={:?} id={} ack={} body={:?}",
                msg.msg_type,
                msg.id,
                msg.ack,
                &msg.data[..msg.data.len().min(16)]
            );
            println!("[exthost] {log_line}");
            messages.push(log_line);

            match msg.msg_type {
                ProtocolMessageType::Regular => {
                    if msg.data.len() == 1 && msg.data[0] == MESSAGE_TYPE_INITIALIZED {
                        println!("[exthost] ✓ Received Initialized (0x01)");
                        return Ok::<(), ExtHostError>(());
                    }
                    // Could be other Regular messages — skip for PoC
                }
                ProtocolMessageType::KeepAlive | ProtocolMessageType::Ack => continue,
                _ => continue, // Be lenient in PoC
            }
        }
    })
    .await
    .map_err(|_| ExtHostError::Timeout)??;

    let duration = start.elapsed();
    println!(
        "[exthost] ✅ Handshake complete in {}ms",
        duration.as_millis()
    );

    Ok(HandshakeResult {
        messages,
        duration_ms: duration.as_millis() as u64,
    })
}
