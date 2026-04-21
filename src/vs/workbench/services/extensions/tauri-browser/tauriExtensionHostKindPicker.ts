/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionKind } from '../../../../platform/environment/common/environment.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ExtensionHostKind, ExtensionRunningPreference, IExtensionHostKindPicker, extensionHostKindToString, extensionRunningPreferenceToString } from '../common/extensionHostKind.js';

/**
 * Extension host kind picker for the Tauri desktop environment.
 *
 * Unlike BrowserExtensionHostKindPicker (which never returns LocalProcess),
 * this picker routes 'workspace' and 'ui' extensions to LocalProcess
 * when installed locally, falling back to LocalWebWorker for 'web' extensions.
 */
export class TauriExtensionHostKindPicker implements IExtensionHostKindPicker {

  constructor(
    @ILogService private readonly _logService: ILogService,
  ) { }

  /**
	 * Pick the extension host kind for a given extension based on its declared
	 * `extensionKind` array, installation location, and running preference.
	 *
	 * Delegates to the static {@link TauriExtensionHostKindPicker.pickRunningLocation}
	 * method and logs the decision.
	 */
  pickExtensionHostKind(extensionId: ExtensionIdentifier, extensionKinds: ExtensionKind[], isInstalledLocally: boolean, isInstalledRemotely: boolean, preference: ExtensionRunningPreference): ExtensionHostKind | null {
    const result = TauriExtensionHostKindPicker.pickRunningLocation(extensionKinds, isInstalledLocally, isInstalledRemotely, preference);
    this._logService.trace(`[TauriKindPicker] pickRunningLocation for ${extensionId.value}, kinds: [${extensionKinds.join(', ')}], local: ${isInstalledLocally}, remote: ${isInstalledRemotely}, pref: ${extensionRunningPreferenceToString(preference)} => ${extensionHostKindToString(result)}`);
    return result;
  }

  /**
	 * Determine the appropriate extension host kind for an extension in the Tauri
	 * desktop environment.
	 *
	 * Routing rules (checked in order for each declared `extensionKind`):
	 * - `'ui'` + locally installed → `LocalProcess`
	 * - `'ui'` + remotely installed → `Remote`
	 * - `'workspace'` + locally installed → `LocalProcess`
	 * - `'workspace'` + remotely installed → `Remote`
	 * - `'web'` + installed → `LocalWebWorker`
	 *
	 * The `preference` parameter influences tie-breaking when multiple locations
	 * are viable. Returns `null` if no suitable host is found.
	 */
  public static pickRunningLocation(extensionKinds: ExtensionKind[], isInstalledLocally: boolean, isInstalledRemotely: boolean, preference: ExtensionRunningPreference): ExtensionHostKind | null {
    const result: ExtensionHostKind[] = [];
    let canRunRemotely = false;

    for (const extensionKind of extensionKinds) {
      if (extensionKind === 'ui' && isInstalledLocally) {
        // 'ui' extensions prefer LocalProcess in Tauri desktop
        if (preference === ExtensionRunningPreference.None || preference === ExtensionRunningPreference.Local) {
          return ExtensionHostKind.LocalProcess;
        } else {
          result.push(ExtensionHostKind.LocalProcess);
        }
      }
      if (extensionKind === 'ui' && isInstalledRemotely) {
        if (preference === ExtensionRunningPreference.Remote) {
          return ExtensionHostKind.Remote;
        } else {
          canRunRemotely = true;
        }
      }
      if (extensionKind === 'workspace' && isInstalledLocally) {
        // 'workspace' extensions run in LocalProcess in Tauri desktop
        if (preference === ExtensionRunningPreference.None || preference === ExtensionRunningPreference.Local) {
          return ExtensionHostKind.LocalProcess;
        } else {
          result.push(ExtensionHostKind.LocalProcess);
        }
      }
      if (extensionKind === 'workspace' && isInstalledRemotely) {
        if (preference === ExtensionRunningPreference.None || preference === ExtensionRunningPreference.Remote) {
          return ExtensionHostKind.Remote;
        } else {
          result.push(ExtensionHostKind.Remote);
        }
      }
      if (extensionKind === 'web' && (isInstalledLocally || isInstalledRemotely)) {
        // 'web' extensions run in LocalWebWorker
        if (preference === ExtensionRunningPreference.None || preference === ExtensionRunningPreference.Local) {
          return ExtensionHostKind.LocalWebWorker;
        } else {
          result.push(ExtensionHostKind.LocalWebWorker);
        }
      }
    }
    if (canRunRemotely) {
      result.push(ExtensionHostKind.Remote);
    }
    return (result.length > 0 ? result[0] : null);
  }
}
