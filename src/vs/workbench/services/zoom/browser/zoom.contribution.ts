/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWindowZoomService } from '../common/zoom.js';
import { WindowZoomService } from './zoomService.js';

// Register WindowZoomService as a delayed singleton so it is only instantiated on first use.
registerSingleton(IWindowZoomService, WindowZoomService, InstantiationType.Delayed);
