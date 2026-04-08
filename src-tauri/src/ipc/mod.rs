/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! IPC infrastructure for VS Code's binary message-passing protocol over Tauri.
//!
//! This module bridges the WebView ↔ Rust communication layer, implementing
//! the same binary wire protocol that VS Code uses between Electron's renderer
//! and main processes.
//!
//! ## Architecture
//!
//! ```text
//! WebView (TypeScript)          Rust Backend
//! ┌────────────────────┐       ┌──────────────────┐
//! │ TauriIPCClient     │──────►│ ipc_message cmd  │
//! │  └ Protocol.send() │invoke │  └ ChannelRouter  │
//! │                    │       │     └ dispatch()  │
//! │ Protocol.onMessage │◄──────│ EventBus.emit()  │
//! └────────────────────┘ event └──────────────────┘
//! ```

pub mod channel;
pub mod event_bus;
