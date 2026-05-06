/*---------------------------------------------------------------------------------------------
*  Copyright (c) Microsoft Corporation. All rights reserved.
*  Licensed under the MIT License. See License.txt in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import { localize } from "../../../../nls.js";
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from "../../../../platform/configuration/common/configurationRegistry.js";
import { Registry } from "../../../../platform/registry/common/platform.js";
import { registerWorkbenchContribution2, WorkbenchPhase } from "../../../common/contributions.js";
import { CursorAutoHideController } from "./cursorAutoHide.js";


// Cursor auto-hide contribution
registerWorkbenchContribution2(CursorAutoHideController.ID, CursorAutoHideController, WorkbenchPhase.AfterRestored);

// Cursor auto-hide configuration
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration)
    .registerConfiguration({
        "id": "vscodeee",
        "title": localize("vscodeeeConfigurationTitle", "VS Codeee"),
        "type": "object",
        "properties": {
            "vscodeee.cursorAutoHide.enabled": {
                "type": "boolean",
                "default": true,
                "description": localize("cursorAutoHideEnabled", "Controls whether the mouse cursor is automatically hidden after a period of inactivity.")
            },
            "vscodeee.cursorAutoHide.delay": {
                "type": "number",
                "default": 3000,
                "minimum": 500,
                "maximum": 60000,
                "description": localize("cursorAutoHideDelay", "Controls the delay in milliseconds before the mouse cursor is hidden after inactivity.")
            }
        }
    })
