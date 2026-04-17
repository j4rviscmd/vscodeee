/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Off-screen window geometry validation.
//!
//! After `tauri-plugin-window-state` restores saved geometry, the window
//! position may be invalid if the display configuration changed since the
//! last session (e.g. external monitor disconnected). This module provides
//! utilities to detect and correct such cases before the window is shown.

use tauri::Manager;

/// Check whether a logical (DPI-independent) position falls within at least
/// one connected monitor.
fn is_position_on_screen(app: &tauri::AppHandle, x: f64, y: f64) -> bool {
    available_monitors(app).iter().any(|m| {
        let pos = m.position();
        let size = m.size();
        let scale = m.scale_factor();
        let mx = pos.x as f64 / scale;
        let my = pos.y as f64 / scale;
        let mw = size.width as f64 / scale;
        let mh = size.height as f64 / scale;

        x >= mx && x < mx + mw && y >= my && y < my + mh
    })
}

/// Check whether a logical size fits within at least one connected monitor's
/// resolution.
fn fits_on_any_monitor(app: &tauri::AppHandle, width: f64, height: f64) -> bool {
    available_monitors(app).iter().any(|m| {
        let size = m.size();
        let scale = m.scale_factor();
        let mw = size.width as f64 / scale;
        let mh = size.height as f64 / scale;

        width <= mw && height <= mh
    })
}

/// Returns the list of connected monitors, or an empty list when detection
/// fails.
fn available_monitors(app: &tauri::AppHandle) -> Vec<tauri::Monitor> {
    app.available_monitors().unwrap_or_default()
}

/// Ensure a hidden window's geometry is valid before showing it.
///
/// If the restored position is off-screen (e.g. external monitor was
/// disconnected), or the window size exceeds every connected monitor,
/// reposition it centered on the primary monitor.
pub fn ensure_on_screen(window: &tauri::Window) {
    let app = window.app_handle().clone();
    let scale = match window.scale_factor() {
        Ok(s) => s,
        Err(_) => return,
    };

    let pos = match window.outer_position() {
        Ok(p) => p,
        Err(_) => return,
    };

    let size = match window.inner_size() {
        Ok(s) => s,
        Err(_) => return,
    };

    let logical_x = pos.x as f64 / scale;
    let logical_y = pos.y as f64 / scale;
    let logical_w = size.width as f64 / scale;
    let logical_h = size.height as f64 / scale;

    if is_position_on_screen(&app, logical_x, logical_y)
        && fits_on_any_monitor(&app, logical_w, logical_h)
    {
        return;
    }

    log::warn!(
        target: "vscodeee::window::restore_geometry",
        "Window '{}' is off-screen ({logical_x}, {logical_y}, {logical_w}x{logical_h}) — centering on primary monitor",
        window.label()
    );

    // Center on the primary monitor
    if let Some(primary) = app.primary_monitor().ok().flatten() {
        let mon_pos = primary.position();
        let mon_size = primary.size();
        let mon_scale = primary.scale_factor();
        let mx = mon_pos.x as f64 / mon_scale;
        let my = mon_pos.y as f64 / mon_scale;
        let mw = mon_size.width as f64 / mon_scale;
        let mh = mon_size.height as f64 / mon_scale;

        // Clamp size to monitor
        let clamped_w = logical_w.min(mw * 0.9);
        let clamped_h = logical_h.min(mh * 0.9);

        let new_x = mx + (mw - clamped_w) / 2.0;
        let new_y = my + (mh - clamped_h) / 2.0;

        let _ = window.set_size(tauri::LogicalSize::new(clamped_w, clamped_h));
        let _ = window.set_position(tauri::LogicalPosition::new(new_x, new_y));
    }
}
