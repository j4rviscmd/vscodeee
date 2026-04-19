/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Tauri commands for OS-native window transparency (Level 3).
//!
//! These commands enable/disable the platform-specific window transparency
//! effects via Tauri's `WindowEffectsConfig`. On macOS this uses the
//! vibrancy system (NSVisualEffectView), on Windows it uses Mica/Acrylic.
//!
//! **macOS requirement**: `macOSPrivateApi: true` in tauri.conf.json
//! and `transparent: true` on the window configuration.

use serde::Deserialize;
use tauri::window::{Effect, EffectState, EffectsBuilder};

/// Parameters for set_native_transparency command.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTransparencyParams {
    /// Whether to enable or disable native transparency.
    pub enabled: bool,
    /// The effect type to apply (auto, mica, acrylic, vibrancy, none).
    pub effect: String,
}

/// Enable or disable OS-native window transparency.
///
/// This applies platform-specific window effects using Tauri's window
/// effects API. The effect is applied immediately but may require a
/// window restart for full visual consistency.
///
/// # Arguments
///
/// * `params.enabled` - `true` to enable, `false` to disable transparency
/// * `params.effect` - Effect type: "auto", "mica", "acrylic", "vibrancy", "none"
///
/// # Platform Support
///
/// - **macOS**: Uses `NSVisualEffectView` vibrancy (requires Private API)
/// - **Windows 11**: Mica or Acrylic
/// - **Windows 10**: Acrylic only
/// - **Linux**: Not yet supported (returns Ok without applying)
#[tauri::command]
pub async fn set_native_transparency(
    window: tauri::Window,
    params: NativeTransparencyParams,
) -> Result<(), String> {
    if !params.enabled {
        // Clear all effects by setting an empty config
        window
            .set_effects(EffectsBuilder::new().build())
            .map_err(|e| format!("Failed to clear window effects: {e}"))?;
        log::info!(
            target: "vscodeee::transparency",
            "Native transparency disabled"
        );
        return Ok(());
    }

    let effect = resolve_effect(&params.effect);

    let effects = EffectsBuilder::new()
        .effects(vec![effect])
        .state(EffectState::Active)
        .build();

    window
        .set_effects(effects)
        .map_err(|e| format!("Failed to set window effects: {e}"))?;

    log::info!(
        target: "vscodeee::transparency",
        "Native transparency enabled: effect={}",
        params.effect
    );

    Ok(())
}

/// Resolve the effect string to a platform-appropriate Tauri Effect.
fn resolve_effect(effect_str: &str) -> Effect {
    match effect_str {
        "mica" => Effect::Mica,
        "acrylic" => Effect::Acrylic,
        "vibrancy" => {
            // macOS vibrancy - use Sidebar for a semi-transparent look
            #[cfg(target_os = "macos")]
            {
                Effect::Sidebar
            }
            #[cfg(not(target_os = "macos"))]
            {
                Effect::Acrylic
            }
        }
        "none" => Effect::Mica, // Fallback, will be cleared by enabled=false path
        _ => {
            // "auto" and any unknown strings: auto-detect the best effect
            #[cfg(target_os = "macos")]
            {
                Effect::Sidebar
            }
            #[cfg(target_os = "windows")]
            {
                // Mica is preferred on Windows 11, Acrylic on Windows 10
                Effect::Mica
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                // Linux: Tabbed is generally the most widely supported
                Effect::Tabbed
            }
        }
    }
}
