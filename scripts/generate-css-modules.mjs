/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Generate a JSON manifest of all CSS module paths in the transpiled output.
//
// This is needed because Tauri embeds frontendDist assets into the binary,
// making them inaccessible via filesystem scanning at runtime. The manifest
// is bundled as a Tauri resource so `list_css_modules` can read it in built apps.

import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, relative, sep } from 'path';

function collectCssFiles(dir, root, result) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			collectCssFiles(fullPath, root, result);
		} else if (entry.name.endsWith('.css')) {
			result.push(relative(root, fullPath).split(sep).join('/'));
		}
	}
}

const modules = [];
collectCssFiles('out', 'out', modules);
modules.sort();
const content = JSON.stringify(modules);
const destPath = 'src-tauri/css-modules.json';
let skipped = false;
try {
	const existing = readFileSync(destPath, 'utf8');
	if (existing === content) {
		// allow-any-unicode-next-line
		console.log(`✅ [generate-css-modules] Unchanged (${modules.length} entries)`);
		skipped = true;
	}
} catch { /* file doesn't exist yet */ }
if (!skipped) {
	writeFileSync(destPath, content);
	console.log(`Generated css-modules.json with ${modules.length} entries`);
}
