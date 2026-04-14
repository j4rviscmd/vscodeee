/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Native host commands — split into domain-specific submodules.
//!
//! This module re-exports all commands so that `lib.rs` can reference them
//! as `commands::native_host::<command_name>`.

pub mod clipboard;
pub mod error;
pub mod lifecycle;
pub mod misc;
pub mod network;
pub mod os;
pub mod power;
pub mod screenshot;
pub mod shell;
pub mod window;

pub use clipboard::*;
pub use lifecycle::*;
pub use misc::*;
pub use network::*;
pub use os::*;
pub use power::*;
pub use screenshot::*;
pub use shell::*;
pub use window::*;
