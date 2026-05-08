/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
import { execSync } from 'child_process';
import { rmSync } from 'fs';

const steps = [
	{ cmd: ['npm', 'install'] },
	{ cmd: ['node', 'scripts/check-csp-hash.mjs'] },
	{ cmd: ['node', 'scripts/download-bun.mjs'] },
	{ cmd: ['node', 'scripts/bundle-node-modules.mjs'] },
	{ cmd: ['node', 'build/next/index.ts', 'transpile'] },
	{ cmd: ['node', 'build/next/index.ts', 'transpile-extensions'] },
	{ cmd: ['node', 'build/next/index.ts', 'package-extensions'] },
	{ fn: () => rmSync('.build/extensions/node_modules', { recursive: true, force: true }), label: 'rm .build/extensions/node_modules' },
	{ cmd: ['node', 'scripts/generate-css-modules.mjs'] },
	{ cmd: ['npx', 'tauri', 'dev'] },
];

for (const step of steps) {
	if (step.fn) {
		console.log(`\n> ${step.label}`);
		step.fn();
		continue;
	}
	const cmd = step.cmd.join(' ');
	console.log(`\n> ${cmd}`);
	try {
		execSync(cmd, { stdio: 'inherit' });
	} catch {
		console.error(`\nX Failed: ${cmd}`);
		process.exit(1);
	}
}
