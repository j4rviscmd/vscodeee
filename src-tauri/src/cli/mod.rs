/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! CLI argument handling for single-instance arg forwarding.
//!
//! When a second VS Codeee process starts, `tauri-plugin-single-instance` forwards
//! the CLI arguments to the primary instance. This module:
//!
//! - [`parser`] — Parses raw CLI args into a structured [`ParsedCli`]
//! - [`uri`]    — Converts filesystem paths to `file:///` URIs
//! - [`router`] — Routes parsed args to window actions (focus or open)

pub mod parser;
pub mod router;
pub mod uri;
