/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IProductConfiguration } from '../../../base/common/product.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/** Service identifier for the product service. */
export const IProductService = createDecorator<IProductService>('productService');

/**
 * Provides read-only access to the product configuration (name, version, commit, etc.)
 * and Tauri-specific extensions such as the extension host runtime label.
 */
export interface IProductService extends Readonly<IProductConfiguration> {

	readonly _serviceBrand: undefined;
	/** Human-readable label for the extension host runtime (e.g. `"Bun 1.2.0"`). */
	extensionHostRuntime?: string;

}

/** JSON Schema URI for VS Code product configuration validation. */
export const productSchemaId = 'vscode://schemas/vscode-product';
