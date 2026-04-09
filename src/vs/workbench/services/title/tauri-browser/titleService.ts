/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { TauriTitleService } from '../../../tauri-browser/parts/titlebar/titlebarPart.js';
import { ITitleService } from '../browser/titleService.js';

registerSingleton(ITitleService, TauriTitleService, InstantiationType.Eager);
