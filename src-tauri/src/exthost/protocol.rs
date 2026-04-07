/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! VS Code wire protocol — 13-byte header framing.
//!
//! Faithfully mirrors the protocol defined in `src/vs/base/parts/ipc/common/ipc.net.ts`.
//! Each message has a 13-byte header followed by a variable-length body:
//!
//! ```text
//! [TYPE: 1 byte][ID: 4 bytes BE][ACK: 4 bytes BE][DATA_LENGTH: 4 bytes BE][DATA: N bytes]
//! ```
//!
//! # TODO: Production (Phase 1-2)
//!
//! In the clean architecture, Rust does NOT parse the wire protocol at all.
//! Instead, a byte-transparent WebSocket↔Pipe relay copies raw bytes between
//! the renderer (TypeScript PersistentProtocol) and the Extension Host.
//! This module will then be used only for optional debug logging.

use std::io;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Wire protocol header length in bytes.
/// Mirrors `ProtocolConstants.HeaderLength` at `ipc.net.ts:283`.
pub const HEADER_LENGTH: usize = 13;

/// Transport-level message types.
/// Mirrors `ProtocolMessageType` at `ipc.net.ts:287-297`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ProtocolMessageType {
    None = 0,
    Regular = 1,
    Control = 2,
    Ack = 3,
    Disconnect = 5,
    ReplayRequest = 6,
    Pause = 7,
    Resume = 8,
    KeepAlive = 9,
}

impl TryFrom<u8> for ProtocolMessageType {
    type Error = String;
    fn try_from(v: u8) -> Result<Self, String> {
        match v {
            0 => Ok(Self::None),
            1 => Ok(Self::Regular),
            2 => Ok(Self::Control),
            3 => Ok(Self::Ack),
            5 => Ok(Self::Disconnect),
            6 => Ok(Self::ReplayRequest),
            7 => Ok(Self::Pause),
            8 => Ok(Self::Resume),
            9 => Ok(Self::KeepAlive),
            _ => Err(format!("Unknown protocol message type: {v}")),
        }
    }
}

/// A single wire protocol message (header + body).
#[derive(Debug)]
pub struct ProtocolMessage {
    pub msg_type: ProtocolMessageType,
    pub id: u32,
    pub ack: u32,
    pub data: Vec<u8>,
}

impl ProtocolMessage {
    /// Create a Regular message (mirrors `PersistentProtocol.send()`).
    pub fn regular(id: u32, ack: u32, data: Vec<u8>) -> Self {
        Self {
            msg_type: ProtocolMessageType::Regular,
            id,
            ack,
            data,
        }
    }
}

/// Read exactly one protocol message from an async reader.
///
/// Mirrors `ProtocolReader.acceptChunk()` at `ipc.net.ts:354-401`.
pub async fn read_message<R: AsyncReadExt + Unpin>(reader: &mut R) -> io::Result<ProtocolMessage> {
    let mut header = [0u8; HEADER_LENGTH];
    reader.read_exact(&mut header).await?;

    let msg_type = ProtocolMessageType::try_from(header[0])
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let id = u32::from_be_bytes([header[1], header[2], header[3], header[4]]);
    let ack = u32::from_be_bytes([header[5], header[6], header[7], header[8]]);
    let data_length = u32::from_be_bytes([header[9], header[10], header[11], header[12]]) as usize;

    let mut data = vec![0u8; data_length];
    if data_length > 0 {
        reader.read_exact(&mut data).await?;
    }

    Ok(ProtocolMessage {
        msg_type,
        id,
        ack,
        data,
    })
}

/// Write one protocol message to an async writer.
///
/// Mirrors `ProtocolWriter.write()` at `ipc.net.ts:460-477`.
pub async fn write_message<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    msg: &ProtocolMessage,
) -> io::Result<()> {
    let mut header = [0u8; HEADER_LENGTH];
    header[0] = msg.msg_type as u8;
    header[1..5].copy_from_slice(&msg.id.to_be_bytes());
    header[5..9].copy_from_slice(&msg.ack.to_be_bytes());
    header[9..13].copy_from_slice(&(msg.data.len() as u32).to_be_bytes());

    writer.write_all(&header).await?;
    if !msg.data.is_empty() {
        writer.write_all(&msg.data).await?;
    }
    writer.flush().await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    #[tokio::test]
    async fn test_roundtrip() {
        let msg = ProtocolMessage::regular(1, 0, vec![0x02]);

        let mut buf = Vec::new();
        write_message(&mut buf, &msg).await.unwrap();

        assert_eq!(buf.len(), HEADER_LENGTH + 1);

        let mut reader = BufReader::new(&buf[..]);
        let decoded = read_message(&mut reader).await.unwrap();

        assert_eq!(decoded.msg_type, ProtocolMessageType::Regular);
        assert_eq!(decoded.id, 1);
        assert_eq!(decoded.ack, 0);
        assert_eq!(decoded.data, vec![0x02]);
    }

    #[tokio::test]
    async fn test_empty_body() {
        let msg = ProtocolMessage {
            msg_type: ProtocolMessageType::Resume,
            id: 0,
            ack: 0,
            data: vec![],
        };

        let mut buf = Vec::new();
        write_message(&mut buf, &msg).await.unwrap();

        assert_eq!(buf.len(), HEADER_LENGTH);
        assert_eq!(buf[0], 8); // Resume = 8

        let mut reader = BufReader::new(&buf[..]);
        let decoded = read_message(&mut reader).await.unwrap();

        assert_eq!(decoded.msg_type, ProtocolMessageType::Resume);
        assert_eq!(decoded.data.len(), 0);
    }
}
