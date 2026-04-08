/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tauri workbench host service registration.
 *
 * For Phase 1 we reuse the browser host service, which provides all
 * IHostService methods using standard web APIs. This is appropriate
 * because Tauri's WebView is a browser environment.
 *
 * In later phases, this can be replaced with a Tauri-specific host
 * service that delegates to INativeHostService for native operations.
 */

// Re-export the browser host service registration (registerSingleton side-effect)
import '../browser/browserHostService.js';
