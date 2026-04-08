/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Logging configuration — tauri-plugin-log with AI-agent-readable format.
//!
//! All log output (Rust-side `log::*!` macros and WebView console interception)
//! converges through the same pipeline and is written to stdout with a consistent
//! format that is easy for AI agents to parse:
//!
//! ```text
//! [2026-04-08T12:34:56.789Z][INFO][vscodeee::pty::manager] Created PTY instance 1
//! [2026-04-08T12:34:56.789Z][ERROR][webview:terminal.ts:100:5] write error: ...
//! ```

use tauri_plugin_log::{Target, TargetKind};

/// Build the configured `tauri-plugin-log` instance.
///
/// # Log format
///
/// `[ISO8601+ms][LEVEL][TARGET] MESSAGE`
///
/// - **ISO8601+ms**: UTC, sortable, unambiguous
/// - **LEVEL**: TRACE / DEBUG / INFO / WARN / ERROR
/// - **TARGET**: Rust module path (`vscodeee::pty::manager`) or
///   webview caller location (`webview:index.html:221:13`)
pub fn build_plugin() -> tauri_plugin_log::Builder {
    tauri_plugin_log::Builder::new()
        .targets([
            // All logs go to backend terminal (AI-agent readable)
            Target::new(TargetKind::Stdout),
        ])
        .format(log_format)
        // Default level: Info and above
        .level(log::LevelFilter::Info)
        // Allow Debug for our own modules when RUST_LOG is set
        .level_for("vscodeee", log::LevelFilter::Debug)
        // WebView console logs at Trace level (capture everything)
        .level_for("webview", log::LevelFilter::Trace)
}

/// Custom log format optimized for AI-agent readability.
///
/// Output: `[YYYY-MM-DDTHH:MM:SS.mmmZ][LEVEL][target] message`
fn log_format(
    out: tauri_plugin_log::fern::FormatCallback,
    message: &std::fmt::Arguments,
    record: &log::Record,
) {
    use time::macros::format_description;

    let timestamp = time::OffsetDateTime::now_utc();
    // SAFETY: format_description! is const, cannot fail at runtime
    let fmt =
        format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z");
    let ts_str = timestamp
        .format(&fmt)
        .unwrap_or_else(|_| "????-??-??T??:??:??.???Z".to_string());

    out.finish(format_args!(
        "[{}][{}][{}] {}",
        ts_str,
        record.level(),
        record.target(),
        message,
    ));
}
