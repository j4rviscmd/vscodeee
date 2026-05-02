/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import path from 'path';
import * as os from 'os';
import * as child_process from 'child_process';
import { dirs } from './dirs.ts';
import { root, stateFile, stateContentsFile, computeState, computeContents, isUpToDate } from './installStateHash.ts';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const rootNpmrcConfigKeys = getNpmrcConfigKeys(path.join(root, '.npmrc'));

/**
 * Logs a message to stdout with an optional directory prefix.
 *
 * When stdout is a TTY, the directory label is rendered in blue using
 * ANSI escape codes for better readability.
 *
 * @param dir - The directory name to display as a prefix tag.
 * @param message - The message to log.
 */
function log(dir: string, message: string) {
	if (process.stdout.isTTY) {
		console.log(`\x1b[34m[${dir}]\x1b[0m`, message);
	} else {
		console.log(`[${dir}]`, message);
	}
}

/**
 * Executes a command synchronously and terminates the process on failure.
 *
 * Logs the full command string before execution. If the process fails to spawn
 * or exits with a non-zero status code, the current process is terminated
 * immediately.
 *
 * @param command - The executable to run.
 * @param args - Arguments passed to the executable.
 * @param opts - Options for `child_process.spawnSync`. `opts.cwd` is used for logging.
 */
function run(command: string, args: string[], opts: child_process.SpawnSyncOptions) {
	log(opts.cwd as string || '.', '$ ' + command + ' ' + args.join(' '));

	const result = child_process.spawnSync(command, args, opts);

	if (result.error) {
		console.error(`ERR Failed to spawn process: ${result.error}`);
		process.exit(1);
	}
	if (result.status !== 0) {
		console.error(`ERR Process exited with code: ${result.status}`);
		process.exit(result.status);
	}
}

/**
 * Spawns a child process asynchronously and collects its combined stdout/stderr output.
 *
 * The child's stdin is ignored and both stdout and stderr are captured into a
 * single string. The promise rejects if the process exits with a non-zero code,
 * including the captured output in the error message.
 *
 * @param command - The executable to run.
 * @param args - Arguments passed to the executable.
 * @param opts - Options for `child_process.spawn`. `stdio` is overridden to pipe
 *   stdout and stderr while ignoring stdin.
 * @returns A promise that resolves with the combined stdout and stderr output.
 * @throws {Error} If the process fails to spawn or exits with a non-zero code.
 */
function spawnAsync(command: string, args: string[], opts: child_process.SpawnOptions): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = child_process.spawn(command, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
		let output = '';
		child.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
		child.stderr?.on('data', (data: Buffer) => { output += data.toString(); });
		child.on('error', reject);
		child.on('close', (code) => {
			if (code !== 0) {
				reject(new Error(`Process exited with code: ${code}\n${output}`));
			} else {
				resolve(output);
			}
		});
	});
}

/**
 * Installs npm dependencies for a given directory, either locally or inside a Docker container.
 *
 * When the `VSCODE_REMOTE_DEPENDENCIES_CONTAINER_NAME` environment variable is set and
 * the directory matches a remote dependency path, the installation is performed inside
 * a Docker container with volume mounts for the source tree, `.netrc`, and `.npmrc`.
 * On ARM64 hosts, QEMU user-mode emulation is enabled via `multiarch/qemu-user-static`
 * before running the container.
 *
 * Otherwise, `npm install` (or the command specified by `npm_command`) is executed
 * locally via {@link spawnAsync}.
 *
 * After installation, prebuilt `@parcel/watcher` modules are removed to avoid
 * native binary compatibility issues.
 *
 * @param dir - The directory path relative to the project root.
 * @param opts - Optional spawn options. When provided, they are merged with
 *   defaults (`env`, `cwd`, `shell: true`).
 */
async function npmInstallAsync(dir: string, opts?: child_process.SpawnOptions): Promise<void> {
	const finalOpts: child_process.SpawnOptions = {
		env: { ...process.env },
		...(opts ?? {}),
		cwd: path.join(root, dir),
		shell: true,
	};

	const command = process.env['npm_command'] || 'install';

	if (process.env['VSCODE_REMOTE_DEPENDENCIES_CONTAINER_NAME'] && /^(.build\/distro\/npm\/)?remote$/.test(dir)) {
		const syncOpts: child_process.SpawnSyncOptions = {
			env: finalOpts.env,
			cwd: root,
			stdio: 'inherit',
			shell: true,
		};
		const userinfo = os.userInfo();
		log(dir, `Installing dependencies inside container ${process.env['VSCODE_REMOTE_DEPENDENCIES_CONTAINER_NAME']}...`);

		if (process.env['npm_config_arch'] === 'arm64') {
			run('sudo', ['docker', 'run', '--rm', '--privileged', 'multiarch/qemu-user-static', '--reset', '-p', 'yes'], syncOpts);
		}
		run('sudo', [
			'docker', 'run',
			'-e', 'GITHUB_TOKEN',
			'-v', `${process.env['VSCODE_HOST_MOUNT']}:/root/vscode`,
			'-v', `${process.env['VSCODE_HOST_MOUNT']}/.build/.netrc:/root/.netrc`,
			'-v', `${process.env['VSCODE_NPMRC_PATH']}:/root/.npmrc`,
			'-w', path.resolve('/root/vscode', dir),
			process.env['VSCODE_REMOTE_DEPENDENCIES_CONTAINER_NAME'],
			'sh', '-c', `\"chown -R root:root ${path.resolve('/root/vscode', dir)} && export PATH="/root/vscode/.build/nodejs-musl/usr/local/bin:$PATH" && npm i -g node-gyp-build && npm ci\"`
		], syncOpts);
		run('sudo', ['chown', '-R', `${userinfo.uid}:${userinfo.gid}`, `${path.resolve(root, dir)}`], syncOpts);
	} else {
		log(dir, 'Installing dependencies...');
		const output = await spawnAsync(npm, command.split(' '), finalOpts);
		if (output.trim()) {
			for (const line of output.trim().split('\n')) {
				if (line) {
				log(dir, line);
			}
			}
		}
	}
	removeParcelWatcherPrebuild(dir);
}

/**
 * Reads an `.npmrc` file in the given directory and applies its configuration to the
 * provided environment object as `npm_config_*` entries.
 *
 * Additionally, this function:
 * - Overrides `npm_config_node_gyp` to point at the bundled `node-gyp` binary.
 * - Sets `npm_config_force_process_config` to `"true"` on macOS for `remote` and
 *   `build` directories, ensuring node-gyp uses the correct Clang configuration
 *   from `process.config`.
 * - For the `build` directory, sets `npm_config_target` and `npm_config_arch`
 *   to match the current Node.js version and architecture for native module
 *   compilation against the Electron target.
 *
 * @param dir - The directory path (relative to the project root) whose `.npmrc`
 *   should be parsed.
 * @param env - The environment object to mutate with npm configuration variables.
 */
function setNpmrcConfig(dir: string, env: NodeJS.ProcessEnv) {
	const npmrcPath = path.join(root, dir, '.npmrc');
	const lines = fs.readFileSync(npmrcPath, 'utf8').split('\n');

	for (const line of lines) {
		const trimmedLine = line.trim();
		if (trimmedLine && !trimmedLine.startsWith('#')) {
			const [key, value] = trimmedLine.split('=');
			env[`npm_config_${key}`] = value.replace(/^"(.*)"$/, '$1');
		}
	}

	// Use our bundled node-gyp version
	env['npm_config_node_gyp'] =
		process.platform === 'win32'
			? path.join(import.meta.dirname, 'gyp', 'node_modules', '.bin', 'node-gyp.cmd')
			: path.join(import.meta.dirname, 'gyp', 'node_modules', '.bin', 'node-gyp');

	// Force node-gyp to use process.config on macOS
	// which defines clang variable as expected. Otherwise we
	// run into compilation errors due to incorrect compiler
	// configuration.
	// NOTE: This means the process.config should contain
	// the correct clang variable. So keep the version check
	// in preinstall sync with this logic.
	// Change was first introduced in https://github.com/nodejs/node/commit/6e0a2bb54c5bbeff0e9e33e1a0c683ed980a8a0f
	if ((dir === 'remote' || dir === 'build') && process.platform === 'darwin') {
		env['npm_config_force_process_config'] = 'true';
	} else {
		delete env['npm_config_force_process_config'];
	}

	if (dir === 'build') {
		env['npm_config_target'] = process.versions.node;
		env['npm_config_arch'] = process.arch;
	}
}

/**
 * Removes prebuilt `@parcel/watcher` modules from `node_modules/@parcel/` to prevent
 * native binary compatibility issues.
 *
 * Parcel ships platform-specific prebuilds under `@parcel/watcher-*` package names.
 * These are deleted so that the JavaScript fallback is used instead, which avoids
 * native module load failures on mismatched platforms.
 *
 * @param dir - The directory path (relative to the project root) to scan for
 *   `node_modules/@parcel/watcher-*` packages.
 */
function removeParcelWatcherPrebuild(dir: string) {
	const parcelModuleFolder = path.join(root, dir, 'node_modules', '@parcel');
	if (!fs.existsSync(parcelModuleFolder)) {
		return;
	}

	const parcelModules = fs.readdirSync(parcelModuleFolder);
	for (const moduleName of parcelModules) {
		if (moduleName.startsWith('watcher-')) {
			const modulePath = path.join(parcelModuleFolder, moduleName);
			fs.rmSync(modulePath, { recursive: true, force: true });
			log(dir, `Removed @parcel/watcher prebuilt module ${modulePath}`);
		}
	}
}

/**
 * Parses an `.npmrc` file and returns all configuration key names.
 *
 * Lines that are empty, whitespace-only, or start with `#` (comments) are skipped.
 * Only the key portion (before the first `=`) is extracted.
 *
 * @param npmrcPath - Absolute path to the `.npmrc` file to parse.
 * @returns An array of configuration key names found in the file.
 *   Returns an empty array if the file does not exist.
 */
function getNpmrcConfigKeys(npmrcPath: string): string[] {
	if (!fs.existsSync(npmrcPath)) {
		return [];
	}
	const lines = fs.readFileSync(npmrcPath, 'utf8').split('\n');
	const keys: string[] = [];
	for (const line of lines) {
		const trimmedLine = line.trim();
		if (trimmedLine && !trimmedLine.startsWith('#')) {
			const eqIndex = trimmedLine.indexOf('=');
			if (eqIndex > 0) {
				keys.push(trimmedLine.substring(0, eqIndex).trim());
			}
		}
	}
	return keys;
}

/**
 * Conditionally copies an environment variable from the current process to a target
 * environment object.
 *
 * If the source variable exists in `process.env`, it is set on the target object.
 * Otherwise, the key is deleted from the target to ensure no stale value remains.
 *
 * @param env - The target environment object to mutate.
 * @param envKey - The key name on the target environment object.
 * @param sourceKey - The key name to read from `process.env`.
 */
function setEnvIfPresent(env: NodeJS.ProcessEnv, envKey: string, sourceKey: string): void {
	if (process.env[sourceKey]) {
		env[envKey] = process.env[sourceKey]!;
	} else {
		delete env[envKey];
	}
}

/**
 * Deletes specified keys from an environment object if they are present in the
 * current process environment.
 *
 * This is used to prevent inherited environment variables from interfering with
 * native module compilation (e.g., `CXXFLAGS`, `CFLAGS`, `LDFLAGS`).
 *
 * @param env - The target environment object to mutate.
 * @param keys - The environment variable keys to conditionally remove.
 */
function deleteEnvIfSet(env: NodeJS.ProcessEnv, ...keys: string[]): void {
	for (const key of keys) {
		if (process.env[key]) { delete env[key]; }
	}
}

/**
 * Removes npm configuration variables inherited from the root `.npmrc` when a
 * directory does not have its own `.npmrc` file.
 *
 * When a sub-directory lacks its own `.npmrc`, npm would inherit configuration
 * from the root. This function clears those inherited `npm_config_*` entries
 * from the environment to ensure clean isolation.
 *
 * @param dir - The directory path (relative to the project root) to check.
 * @param env - The environment object to mutate by deleting inherited config keys.
 */
function clearInheritedNpmrcConfig(dir: string, env: NodeJS.ProcessEnv): void {
	const dirNpmrcPath = path.join(root, dir, '.npmrc');
	if (fs.existsSync(dirNpmrcPath)) {
		return;
	}

	for (const key of rootNpmrcConfigKeys) {
		const envKey = `npm_config_${key.replace(/-/g, '_')}`;
		delete env[envKey];
	}
}

/**
 * Ensures a link exists at `linkPath` pointing to the source specified by
 * `sourceRelativePath`.
 *
 * If the link already exists, no action is taken. Otherwise, the function attempts
 * to create the most appropriate link type based on platform and target type:
 *
 * - **Windows + directory**: Creates a junction point.
 * - **Other platforms**: Creates a symbolic link.
 * - **Windows + file + EPERM fallback**: Creates a hard link (symbolic links may
 *   require elevated privileges on Windows).
 *
 * @param sourceRelativePath - The relative path from `linkPath`'s parent directory
 *   to the source file or directory.
 * @param linkPath - The absolute path where the link should be created.
 * @returns A string indicating the result: `'existing'` if the path already existed,
 *   `'junction'` for a Windows junction, `'symlink'` for a symbolic link, or
 *   `'hard link'` for a hard link.
 * @throws {Error} If link creation fails and the error is not an EPERM that can be
 *   resolved with a hard link.
 */
function ensureAgentHarnessLink(sourceRelativePath: string, linkPath: string): 'existing' | 'junction' | 'symlink' | 'hard link' {
	if (fs.existsSync(linkPath)) {
		return 'existing';
	}

	const sourcePath = path.resolve(path.dirname(linkPath), sourceRelativePath);
	const isDirectory = fs.statSync(sourcePath).isDirectory();

	try {
		if (process.platform === 'win32' && isDirectory) {
			fs.symlinkSync(sourcePath, linkPath, 'junction');
			return 'junction';
		}

		fs.symlinkSync(sourceRelativePath, linkPath, isDirectory ? 'dir' : 'file');
		return 'symlink';
	} catch (error) {
		if (process.platform === 'win32' && !isDirectory && (error as NodeJS.ErrnoException).code === 'EPERM') {
			fs.linkSync(sourcePath, linkPath);
			return 'hard link';
		}

		throw error;
	}
}

/**
 * Executes an array of async tasks with bounded concurrency using a worker-pool pattern.
 *
 * Spawns up to `concurrency` workers that each pull tasks from the shared array
 * via an incrementing index. All errors are collected during execution, and if any
 * occurred, the process is terminated after all tasks complete.
 *
 * @param tasks - An array of async functions to execute.
 * @param concurrency - The maximum number of tasks to run simultaneously.
 *   Clamped to `Math.min(concurrency, tasks.length)`.
 */
async function runWithConcurrency(tasks: (() => Promise<void>)[], concurrency: number): Promise<void> {
	const errors: Error[] = [];
	let index = 0;

	async function worker() {
		while (index < tasks.length) {
			const i = index++;
			try {
				await tasks[i]();
			} catch (err) {
				errors.push(err as Error);
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));

	if (errors.length > 0) {
		for (const err of errors) {
			console.error(err.message);
		}
		process.exit(1);
	}
}

/**
 * Configures local Git settings required for consistent development workflow.
 *
 * Sets the following Git configuration values in the repository:
 * - `pull.rebase` to `merges` -- avoids unnecessary rebases during pulls.
 * - `blame.ignoreRevsFile` to `.git-blame-ignore-revs` -- excludes bulk
 *   formatting commits from `git blame` output.
 */
function configureGitSettings() {
	child_process.execSync('git config pull.rebase merges');
	child_process.execSync('git config blame.ignoreRevsFile .git-blame-ignore-revs');
}

/**
 * Main entry point for the postinstall script.
 *
 * Orchestrates the full dependency installation process:
 *
 * 1. **State check**: If dependencies are already up to date (determined by
 *    {@link isUpToDate}) and `VSCODE_FORCE_INSTALL` is not set, the script
 *    configures Git settings and exits early.
 * 2. **Task classification**: Iterates over all directories defined in {@link dirs}
 *    and categorizes them into:
 *    - **Native tasks** (`build`, `remote`): Require sequential execution to avoid
 *      node-gyp conflicts. Each task configures platform-specific compiler flags
 *      and npm configuration.
 *    - **Parallel tasks**: All other directories are installed concurrently with
 *      bounded concurrency (up to `min(cpuCount, 8)` workers).
 * 3. **Native installs**: Runs native build tasks sequentially.
 * 4. **Parallel installs**: Runs remaining tasks via {@link runWithConcurrency}.
 * 5. **Post-install**: Configures Git settings, writes the installation state
 *    files, creates the `.claude/skills` symlink for the agent harness, and applies
 *    a patch to `@github/copilot-sdk` session.js to fix a missing `.js` extension
 *    in an ESM import.
 */
async function main() {
	if (!process.env['VSCODE_FORCE_INSTALL'] && isUpToDate()) {
		// allow-any-unicode-next-line
		console.log('✅ [postinstall] Dependencies up to date');
		configureGitSettings();
		return;
	}

	const _state = computeState();

	const nativeTasks: (() => Promise<void>)[] = [];
	const parallelTasks: (() => Promise<void>)[] = [];

	for (const dir of dirs) {
		if (dir === '') {
			removeParcelWatcherPrebuild(dir);
			continue; // already executed in root
		}

		if (dir === 'build') {
			nativeTasks.push(() => {
				const env: NodeJS.ProcessEnv = { ...process.env };
				if (process.env['CC']) { env['CC'] = 'gcc'; }
				if (process.env['CXX']) { env['CXX'] = 'g++'; }
				if (process.env['CXXFLAGS']) { env['CXXFLAGS'] = ''; }
				if (process.env['LDFLAGS']) { env['LDFLAGS'] = ''; }
				setNpmrcConfig('build', env);
				return npmInstallAsync('build', { env });
			});
			continue;
		}

		if (/^(.build\/distro\/npm\/)?remote$/.test(dir)) {
			const remoteDir = dir;
			nativeTasks.push(() => {
				const env: NodeJS.ProcessEnv = { ...process.env };
				setEnvIfPresent(env, 'CC', 'VSCODE_REMOTE_CC');
				setEnvIfPresent(env, 'CXX', 'VSCODE_REMOTE_CXX');
				deleteEnvIfSet(env, 'CXXFLAGS', 'CFLAGS', 'LDFLAGS');
				if (process.env['VSCODE_REMOTE_CXXFLAGS']) { env['CXXFLAGS'] = process.env['VSCODE_REMOTE_CXXFLAGS']; }
				if (process.env['VSCODE_REMOTE_LDFLAGS']) { env['LDFLAGS'] = process.env['VSCODE_REMOTE_LDFLAGS']; }
				if (process.env['VSCODE_REMOTE_NODE_GYP']) { env['npm_config_node_gyp'] = process.env['VSCODE_REMOTE_NODE_GYP']; }
				setNpmrcConfig('remote', env);
				return npmInstallAsync(remoteDir, { env });
			});
			continue;
		}

		const taskDir = dir;
		parallelTasks.push(() => {
			const env = { ...process.env };
			clearInheritedNpmrcConfig(taskDir, env);
			return npmInstallAsync(taskDir, { env });
		});
	}

	// Native dirs (build, remote) run sequentially to avoid node-gyp conflicts
	for (const task of nativeTasks) {
		await task();
	}

	// JS-only dirs run in parallel
	const concurrency = Math.min(os.cpus().length, 8);
	log('.', `Running ${parallelTasks.length} npm installs with concurrency ${concurrency}...`);
	await runWithConcurrency(parallelTasks, concurrency);

	configureGitSettings();

	fs.writeFileSync(stateFile, JSON.stringify(_state));
	fs.writeFileSync(stateContentsFile, JSON.stringify(computeContents()));

	// Symlink .claude/ files to their canonical locations to test Claude agent harness
	const claudeDir = path.join(root, '.claude');
	fs.mkdirSync(claudeDir, { recursive: true });

	const agentSkillsSource = path.join(root, '.agents', 'skills');
	if (fs.existsSync(agentSkillsSource)) {
		const claudeSkillsLink = path.join(claudeDir, 'skills');
		const claudeSkillsLinkType = ensureAgentHarnessLink(path.join('..', '.agents', 'skills'), claudeSkillsLink);
		if (claudeSkillsLinkType !== 'existing') {
			log('.', `Created ${claudeSkillsLinkType} .claude/skills -> .agents/skills`);
		}
	}

	// Temporary: patch @github/copilot-sdk session.js to fix ESM import
	// (missing .js extension on vscode-jsonrpc/node). Fixed upstream in v0.1.32.
	// TODO: Remove once @github/copilot-sdk is updated to >=0.1.32
	for (const dir of ['', 'remote']) {
		const sessionFile = path.join(root, dir, 'node_modules', '@github', 'copilot-sdk', 'dist', 'session.js');
		if (fs.existsSync(sessionFile)) {
			const content = fs.readFileSync(sessionFile, 'utf8');
			const patched = content.replace(/from "vscode-jsonrpc\/node"/g, 'from "vscode-jsonrpc/node.js"');
			if (content !== patched) {
				fs.writeFileSync(sessionFile, patched);
				log(dir || '.', 'Patched @github/copilot-sdk session.js (vscode-jsonrpc ESM import fix)');
			}
		}
	}
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
