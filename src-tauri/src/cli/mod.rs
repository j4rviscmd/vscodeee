/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! CLI argument handling for the `eee` command.
//!
//! Architecture:
//! - [`args`]           — Clap derive definitions for all CLI flags
//! - [`dispatch`]       — Routes parsed args to early-exit, headless, or GUI paths
//! - [`extension_cli`]  — Headless extension management operations
//! - [`completion`]     — Shell completion generation
//! - [`parser`]         — Legacy parser (kept for backward compatibility)
//! - [`uri`]            — Filesystem path to `file:///` URI conversion
//! - [`router`]         — Routes parsed args to window actions

pub mod args;
pub mod completion;
pub mod dispatch;
pub mod extension_cli;
pub mod parser;
pub mod router;
pub mod uri;
