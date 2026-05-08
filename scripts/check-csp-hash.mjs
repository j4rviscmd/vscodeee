/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
// check-csp-hash.mjs — Verify that the CSP hash in
// webWorkerExtensionHostIframe.html matches the actual SHA-256
// of the inline <script> content.

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

const IFRAME_HTML = join(
	REPO_ROOT,
	'src/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html'
);

let content;
try {
	content = readFileSync(IFRAME_HTML, 'utf-8');
} catch {
	console.error(`ERROR: ${IFRAME_HTML} not found`);
	process.exit(2);
}

const scriptMatch = content.match(/<script>(.*?)<\/script>/s);
if (!scriptMatch) {
	console.error('ERROR: no <script> block found');
	process.exit(2);
}

const computedHash = createHash('sha256')
	.update(scriptMatch[1], 'utf-8')
	.digest('base64');

const cspMatch = content.match(/sha256-([A-Za-z0-9+/=]+)/);
if (!cspMatch) {
	console.error('ERROR: no sha256- hash found in CSP');
	process.exit(2);
}

if (computedHash === cspMatch[1]) {
	console.log('[check-csp-hash] Hash matches');
	process.exit(0);
} else {
	console.error('ERROR: CSP hash mismatch in webWorkerExtensionHostIframe.html');
	console.error(`  Declared in CSP:  sha256-${cspMatch[1]}`);
	console.error(`  Actual (computed): sha256-${computedHash}`);
	console.error('');
	console.error('The inline <script> content was modified without updating the CSP hash.');
	process.exit(1);
}
