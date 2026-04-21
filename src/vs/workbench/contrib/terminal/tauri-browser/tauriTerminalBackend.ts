/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * TauriTerminalBackend — ITerminalBackend implementation for Tauri.
 *
 * Bridges VS Code's terminal infrastructure with the Rust PTY backend
 * via Tauri IPC. Registered as a terminal backend via the
 * TerminalBackendRegistry.
 *
 * ## Architecture
 *
 * ```
 * VS Code Terminal UI (xterm.js)
 *   | ITerminalBackend (TauriTerminalBackend)
 *   | ITerminalChildProcess (TauriPty)
 * Tauri IPC
 *   |
 * Rust PTY Manager (portable-pty)
 * ```
 */

import { DeferredPromise } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { OperatingSystem, type IProcessEnvironment } from '../../../../base/common/platform.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ICrossVersionSerializedTerminalState, ITerminalBackend, ITerminalBackendRegistry, ITerminalChildProcess, ITerminalLogService, ITerminalProcessOptions, ITerminalProfile, ITerminalsLayoutInfo, ITerminalsLayoutInfoById, ProcessPropertyType, TerminalExtensions, TerminalIcon, TitleEventSource, type IPtyHostLatencyMeasurement, type IProcessPropertyMap, type IShellLaunchConfig } from '../../../../platform/terminal/common/terminal.js';
import { IProcessDetails } from '../../../../platform/terminal/common/terminalProcess.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { BaseTerminalBackend } from '../browser/baseTerminalBackend.js';
import { TauriPty } from './tauriPty.js';
import { TauriPtyHostController } from './tauriPtyHostController.js';
import { IConfigurationResolverService } from '../../../services/configurationResolver/common/configurationResolver.js';
import { IHistoryService } from '../../../services/history/common/history.js';
import { IStatusbarService } from '../../../services/statusbar/browser/statusbar.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ITerminalInstanceService } from '../browser/terminal.js';
import { PerformanceMark } from '../../../../base/common/performance.js';
import { TauriAutoReply } from './tauriAutoReply.js';
import { TauriTerminalStateService } from './tauriTerminalStateService.js';
import { tauriInvoke } from './tauriIpc.js';

/** Process summary returned by the Rust `list_terminals` command. */
interface RustProcessSummary {
  id: number;
  pid: number;
  shell: string;
  cwd: string;
  isAlive: boolean;
}

/** Detected shell profile returned by the Rust `detect_shells` command. */
interface RustDetectedShell {
  profileName: string;
  path: string;
  isDefault: boolean;
}

/**
 * Registers the TauriTerminalBackend when running in a Tauri environment.
 */
export class TauriTerminalBackendContribution implements IWorkbenchContribution {
  static readonly ID = 'tauriTerminalBackend';

  constructor(
    @IInstantiationService instantiationService: IInstantiationService,
    @ITerminalInstanceService terminalInstanceService: ITerminalInstanceService,
  ) {
    // Only register when Tauri IPC is available
    const w = globalThis as unknown as {
      __TAURI_INTERNALS__?: unknown;
    };
    if (!w.__TAURI_INTERNALS__) {
      return;
    }

    const backend = instantiationService.createInstance(TauriTerminalBackend);
    Registry.as<ITerminalBackendRegistry>(TerminalExtensions.Backend).registerTerminalBackend(backend);
    terminalInstanceService.didRegisterBackend(backend);
  }
}

// Counter for assigning unique terminal child process IDs
let nextTerminalId = 1;

/**
 * Terminal backend implementation that bridges VS Code's terminal infrastructure
 * with the Rust PTY backend via Tauri IPC.
 *
 * Registered with the `TerminalBackendRegistry` by `TauriTerminalBackendContribution`.
 * Manages PTY lifecycle, shell profile detection, terminal state persistence,
 * auto-reply pattern management, and process listing.
 *
 * This is a local-only backend (`remoteAuthority` is `undefined`).
 * Connection is considered immediate since Tauri IPC is in-process.
 */
class TauriTerminalBackend extends BaseTerminalBackend implements ITerminalBackend {
  readonly remoteAuthority: string | undefined = undefined; // Local terminal — no remote authority

  private readonly _whenConnected = new DeferredPromise<void>();
  get whenReady(): Promise<void> { return this._whenConnected.p; }
  setReady(): void { this._whenConnected.complete(); }

  private readonly _onDidRequestDetach = this._register(new Emitter<{ requestId: number; workspaceId: string; instanceId: number }>());
  readonly onDidRequestDetach = this._onDidRequestDetach.event;

  private readonly _tauriPtyHostController: TauriPtyHostController;

  // Active PTY instances for property/title/icon tracking
  private readonly _ptys: Map<number, TauriPty> = new Map();

  // Title and icon tracking (in-memory, used by listProcesses)
  private readonly _titles = new Map<number, { title: string; titleSource: TitleEventSource }>();
  private readonly _icons = new Map<number, { icon: TerminalIcon; color?: string }>();

  // Pending command IDs for shell integration persistence
  private readonly _pendingCommands = new Map<number, { commandLine: string; commandId: string }>();

  // Auto-reply manager
  private readonly _autoReply: TauriAutoReply;

  // Terminal state persistence
  private _stateService: TauriTerminalStateService | undefined;

  constructor(
    @ITerminalLogService logService: ITerminalLogService,
    @IHistoryService historyService: IHistoryService,
    @IConfigurationResolverService configurationResolverService: IConfigurationResolverService,
    @IStatusbarService statusBarService: IStatusbarService,
    @IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
  ) {
    const ptyHostController = new TauriPtyHostController();
    super(ptyHostController, logService, historyService, configurationResolverService, statusBarService, workspaceContextService);
    this._tauriPtyHostController = ptyHostController;

    this._autoReply = new TauriAutoReply(logService);

    // Initialize state service with workspace ID
    const workspaceId = workspaceContextService.getWorkspace().id;
    this._stateService = new TauriTerminalStateService(workspaceId, logService);

    // Signal that the backend is connected
    this._onPtyHostConnected.fire();
  }

  /**
	 * Create a new terminal child process (PTY instance).
	 *
	 * Determines the shell executable from `shellLaunchConfig.executable` or
	 * falls back to the system default shell. Resolves the working directory
	 * and spawns a `TauriPty` instance.
	 *
	 * @param shellLaunchConfig - Shell launch configuration (executable, cwd, etc.)
	 * @param cwd - Default working directory if not specified in `shellLaunchConfig`
	 * @param cols - Initial terminal column count
	 * @param rows - Initial terminal row count
	 * @returns A new `ITerminalChildProcess` backed by the Rust PTY
	 */
  async createProcess(
    shellLaunchConfig: IShellLaunchConfig,
    cwd: string,
    cols: number,
    rows: number,
    _unicodeVersion: '6' | '11',
    env: IProcessEnvironment,
    _options: ITerminalProcessOptions,
    _shouldPersist: boolean,
  ): Promise<ITerminalChildProcess> {
    const id = nextTerminalId++;

    // Determine the shell executable
    let shell = shellLaunchConfig.executable;
    if (!shell) {
      shell = await this.getDefaultSystemShell();
    }

    // Determine the working directory
    const resolvedCwd = typeof shellLaunchConfig.cwd === 'string'
      ? shellLaunchConfig.cwd
      : shellLaunchConfig.cwd?.fsPath ?? cwd;

    // Build environment: merge provided env with shell-specific overrides.
    // The env object from VS Code's terminal infrastructure already includes
    // TERM_PROGRAM, COLORTERM, LANG, and other terminal-specific vars.
    const terminalEnv: Record<string, string> = {};

    // Variables inherited from the parent process that should NOT be
    // forwarded to the PTY shell because they describe the parent's
    // terminal multiplexer state, not the new PTY session's state.
    // If TMUX/TMUX_PANE are forwarded, the shell's .zshrc/.bashrc
    // believes it is already inside a tmux session and skips interactive
    // session pickers (e.g., fzf-based tmux session selectors).
    const envBlocklist = new Set([
      'TMUX',
      'TMUX_PANE',
    ]);

    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined && value !== null && !envBlocklist.has(key)) {
        terminalEnv[key] = value;
      }
    }
    // Override TERM_PROGRAM to identify as vscodeee
    terminalEnv['TERM_PROGRAM'] = 'vscodeee';

    this._logService.trace('TauriTerminalBackend#createProcess', { id, shell, cwd: resolvedCwd, cols, rows });

    const pty = new TauriPty(id, shell, resolvedCwd, cols, rows, terminalEnv, this._logService);
    this._ptys.set(id, pty);
    return pty;
  }

  /**
	 * Attach to an existing terminal process.
	 *
	 * Not yet implemented. Planned for Phase 6 persistence revival.
	 *
	 * @param _id - The terminal process ID to attach to
	 * @returns Always `undefined` (not implemented)
	 */
  async attachToProcess(_id: number): Promise<ITerminalChildProcess | undefined> {
    // TODO(Phase 6): Implement process attachment for full persistence revival
    this._logService.trace('TauriTerminalBackend#attachToProcess (not implemented)', { id: _id });
    return undefined;
  }

  /**
	 * Attach to a revived terminal process after a window reload.
	 *
	 * Not yet implemented. Planned for Phase 6 persistence revival.
	 *
	 * @param _id - The terminal process ID to revive
	 * @returns Always `undefined` (not implemented)
	 */
  async attachToRevivedProcess(_id: number): Promise<ITerminalChildProcess | undefined> {
    // TODO(Phase 6): Implement process revival for full persistence revival
    this._logService.trace('TauriTerminalBackend#attachToRevivedProcess (not implemented)', { id: _id });
    return undefined;
  }

  /**
	 * List all running terminal processes.
	 *
	 * Queries the Rust `list_terminals` command and enriches each summary
	 * with in-memory title and icon data tracked by this backend.
	 *
	 * @returns Array of process details for all active PTY instances
	 */
  async listProcesses(): Promise<IProcessDetails[]> {
    try {
      const summaries = await tauriInvoke<RustProcessSummary[]>('list_terminals');
      return summaries.map(s => {
        const title = this._titles.get(s.id);
        const icon = this._icons.get(s.id);
        return {
          id: s.id,
          pid: s.pid,
          title: title?.title ?? '',
          titleSource: title?.titleSource ?? TitleEventSource.Process,
          cwd: s.cwd,
          workspaceId: '',
          workspaceName: '',
          isOrphan: false,
          icon: icon?.icon,
          color: icon?.color,
          fixedDimensions: undefined,
          environmentVariableCollections: undefined,
          shellIntegrationNonce: '',
          hasChildProcesses: false,
        };
      });
    } catch (e) {
      this._logService.error('TauriTerminalBackend#listProcesses failed', e instanceof Error ? e.message : String(e));
      return [];
    }
  }

  /**
	 * Measure IPC latency between the frontend and the PTY backend.
	 *
	 * Tauri IPC runs in-process, so latency is reported as 0ms.
	 *
	 * @returns A single-element array with the `tauri-ipc` latency measurement
	 */
  async getLatency(): Promise<IPtyHostLatencyMeasurement[]> {
    // Tauri IPC latency is negligible (in-process)
    return [{ label: 'tauri-ipc', latency: 0 }];
  }

  /**
	 * Get the default system shell path.
	 *
	 * Queries the Rust `get_default_shell` command. Falls back to `/bin/zsh`
	 * (macOS default) if the command fails.
	 *
	 * @param _osOverride - Optional OS override (currently unused, delegates to Rust)
	 * @returns The default shell path
	 */
  async getDefaultSystemShell(_osOverride?: OperatingSystem): Promise<string> {
    try {
      const shell = await tauriInvoke<string>('get_default_shell');
      return shell;
    } catch {
      // Fallback: try to determine from platform
      return '/bin/zsh'; // macOS default
    }
  }

  /**
	 * Detect available shell profiles on the system.
	 *
	 * Queries the Rust `detect_shells` command which scans known shell paths
	 * and checks executability. Falls back to a single default shell entry
	 * if detection fails.
	 *
	 * @param _profiles - Existing profiles (currently unused, delegates to Rust detection)
	 * @param _defaultProfile - Default profile configuration (currently unused)
	 * @param _includeDetectedProfiles - Whether to include auto-detected profiles
	 * @returns Array of detected terminal profiles
	 */
  async getProfiles(_profiles: unknown, _defaultProfile: unknown, _includeDetectedProfiles?: boolean): Promise<ITerminalProfile[]> {
    try {
      const shells = await tauriInvoke<RustDetectedShell[]>('detect_shells');
      return shells.map(s => ({
        profileName: s.profileName,
        path: s.path,
        isDefault: s.isDefault,
      }));
    } catch (e) {
      this._logService.error('TauriTerminalBackend#getProfiles failed', e instanceof Error ? e.message : String(e));
      // Fallback: return default shell only
      try {
        const defaultShell = await this.getDefaultSystemShell();
        const shellName = defaultShell.split('/').pop() ?? 'shell';
        return [{
          profileName: shellName,
          path: defaultShell,
          isDefault: true,
        }];
      } catch {
        return [];
      }
    }
  }

  /**
	 * Convert a WSL path between Unix and Windows formats.
	 *
	 * WSL is not applicable in the Tauri environment, so this returns
	 * the original path unchanged.
	 *
	 * @param original - The path to convert
	 * @param _direction - Conversion direction (unused)
	 * @returns The original path unchanged
	 */
  async getWslPath(original: string, _direction: 'unix-to-win' | 'win-to-unix'): Promise<string> {
    // WSL is not applicable in Tauri
    return original;
  }

  /**
	 * Get the process environment variables.
	 *
	 * Queries the Rust `get_environment` command which returns
	 * `std::env::vars()` from the native process.
	 *
	 * @returns The process environment as a key-value map
	 */
  async getEnvironment(): Promise<IProcessEnvironment> {
    try {
      return await tauriInvoke<IProcessEnvironment>('get_environment');
    } catch {
      return {};
    }
  }

  /**
	 * Get the shell-specific environment variables.
	 *
	 * Delegates to `getEnvironment()` since the Tauri backend does not
	 * differentiate between process and shell environments.
	 *
	 * @returns The process environment as a key-value map
	 */
  async getShellEnvironment(): Promise<IProcessEnvironment | undefined> {
    return this.getEnvironment();
  }

  /**
	 * Persist terminal layout information for the current workspace.
	 *
	 * Serializes the layout info to JSON and delegates to the Rust
	 * `persist_terminal_layout` command for file-based storage.
	 *
	 * @param layoutInfo - Terminal layout info keyed by terminal ID, or undefined to clear
	 */
  async setTerminalLayoutInfo(layoutInfo?: ITerminalsLayoutInfoById): Promise<void> {
    if (!layoutInfo || !this._stateService) {
      return;
    }
    try {
      await this._stateService.saveLayoutInfo(JSON.stringify(layoutInfo));
    } catch (e) {
      this._logService.error('TauriTerminalBackend#setTerminalLayoutInfo failed', e instanceof Error ? e.message : String(e));
    }
  }

  /**
	 * Update the tracked title for a terminal instance.
	 *
	 * Stores the title in-memory for use in `listProcesses` responses.
	 *
	 * @param id - The terminal instance ID
	 * @param title - The new terminal title
	 * @param titleSource - Source of the title change (process, sequence, or API)
	 */
  async updateTitle(id: number, title: string, titleSource: TitleEventSource): Promise<void> {
    this._titles.set(id, { title, titleSource });
  }

  /**
	 * Update the tracked icon for a terminal instance.
	 *
	 * Stores the icon in-memory for use in `listProcesses` responses.
	 *
	 * @param id - The terminal instance ID
	 * @param _userInitiated - Whether the icon change was user-initiated (unused)
	 * @param icon - The terminal icon
	 * @param color - Optional icon color
	 */
  async updateIcon(id: number, _userInitiated: boolean, icon: TerminalIcon, color?: string): Promise<void> {
    this._icons.set(id, { icon, color });
  }

  /**
	 * Track the next shell command for shell integration persistence.
	 *
	 * Stores the command line and command ID in-memory. The actual command
	 * detection is handled by the xterm.js shell integration addon via
	 * OSC 633 sequences.
	 *
	 * @param id - The terminal instance ID
	 * @param commandLine - The command line text
	 * @param commandId - The unique command identifier from shell integration
	 */
  async setNextCommandId(id: number, commandLine: string, commandId: string): Promise<void> {
    // Store for persistence. The xterm-side shellIntegrationAddon handles
    // the actual command detection via OSC 633 sequences.
    this._pendingCommands.set(id, { commandLine, commandId });
  }

  /**
	 * Load persisted terminal layout info for the current workspace.
	 *
	 * Also attempts to load and revive persisted terminal buffer state.
	 * If buffer state is found, it is deserialized and the persisted
	 * state is cleared after reading (one-shot restoration).
	 *
	 * @returns The parsed terminal layout info, or undefined if none exists
	 */
  async getTerminalLayoutInfo(): Promise<ITerminalsLayoutInfo | undefined> {
    if (!this._stateService) {
      return undefined;
    }

    try {
      // Load persisted buffer state and revive if present
      const bufferStateStr = await this._stateService.loadBufferState();
      if (bufferStateStr) {
        const revivedState = this._deserializeTerminalState(bufferStateStr);
        if (revivedState && revivedState.length > 0) {
          this._logService.trace('TauriTerminalBackend#getTerminalLayoutInfo revived state', { count: revivedState.length });
          // Clear the persisted state after reading (one-shot restoration)
          await this._stateService.saveBufferState('');
        }
      }

      // Load layout info
      const layoutStr = await this._stateService.loadLayoutInfo();
      if (layoutStr) {
        try {
          return JSON.parse(layoutStr);
        } catch {
          this._logService.warn('TauriTerminalBackend#getTerminalLayoutInfo failed to parse layout info');
        }
      }
    } catch (e) {
      this._logService.error('TauriTerminalBackend#getTerminalLayoutInfo failed', e instanceof Error ? e.message : String(e));
    }

    return undefined;
  }

  /**
	 * Get performance marks for the terminal backend startup.
	 *
	 * Currently returns an empty array — no performance instrumentation
	 * is collected in the Tauri backend.
	 *
	 * @returns An empty array
	 */
  async getPerformanceMarks(): Promise<PerformanceMark[]> {
    return [];
  }

  /**
	 * Reduce the reconnection grace time.
	 *
	 * No-op in the Tauri backend since there is no reconnection mechanism
	 * (Tauri IPC is in-process and always available).
	 */
  async reduceConnectionGraceTime(): Promise<void> {
    // No-op — no reconnection grace time in Tauri
  }

  /**
	 * Request detaching a terminal instance from its current host.
	 *
	 * Not yet implemented. Planned for Phase 6 detached terminal support.
	 *
	 * @param _workspaceId - The workspace ID
	 * @param _instanceId - The terminal instance ID to detach
	 * @returns Always `undefined` (not implemented)
	 */
  async requestDetachInstance(_workspaceId: string, _instanceId: number): Promise<IProcessDetails | undefined> {
    // TODO(Phase 6): Implement for detached terminal support
    return undefined;
  }

  /**
	 * Accept a reply to a previously requested terminal detach.
	 *
	 * Not yet implemented. Planned for Phase 6 detached terminal support.
	 *
	 * @param _requestId - The detach request ID
	 * @param _persistentProcessId - The persistent process ID from the reply
	 */
  async acceptDetachInstanceReply(_requestId: number, _persistentProcessId?: number): Promise<void> {
    // TODO(Phase 6): Implement for detached terminal support
  }

  /**
	 * Persist terminal state for all active PTY instances.
	 *
	 * Serializes active terminal IDs into an `ICrossVersionSerializedTerminalState`
	 * and delegates to the Rust `persist_terminal_state` command.
	 * Currently persists only basic metadata; full shell integration state
	 * capture is planned for Phase 6.
	 */
  async persistTerminalState(): Promise<void> {
    if (!this._stateService) {
      return;
    }

    try {
      // Serialize active terminals
      const state = Array.from(this._ptys.keys()).map(id => ({
        id,
        // TODO(Phase 6): Capture actual shell integration state, CWD, etc.
        shell: '',
        cwd: '',
      }));

      // TODO(Phase 6): Use proper ISerializedTerminalState[] with full fields
      // (shellIntegrationState, cwd, initialCwd, capabilities, etc.)
      const serialized: ICrossVersionSerializedTerminalState = {
        version: 1,
        state: state as unknown as ICrossVersionSerializedTerminalState['state'],
      };

      await this._stateService.saveBufferState(JSON.stringify(serialized));
      this._logService.trace('TauriTerminalBackend#persistTerminalState saved', { count: state.length });
    } catch (e) {
      this._logService.error('TauriTerminalBackend#persistTerminalState failed', e instanceof Error ? e.message : String(e));
    }
  }

  /**
	 * Install an auto-reply pattern for all terminal instances.
	 *
	 * When terminal output contains `match`, `reply` will be sent back
	 * automatically. Delegates to the Rust `AutoReplyInterceptor`.
	 *
	 * @param match - The pattern string to match in terminal output
	 * @param reply - The text to send back when the pattern matches
	 */
  async installAutoReply(match: string, reply: string): Promise<void> {
    await this._autoReply.install(match, reply);
  }

  /**
	 * Remove all auto-reply patterns from all terminal instances.
	 *
	 * Delegates to the Rust `AutoReplyInterceptor`.
	 */
  async uninstallAllAutoReplies(): Promise<void> {
    await this._autoReply.uninstallAll();
  }

  /**
	 * Update a process property on a specific terminal instance.
	 *
	 * Looks up the `TauriPty` by ID and delegates to its `updateProperty` method.
	 * No-op if the terminal instance is not found.
	 *
	 * @typeParam T - The process property type to update
	 * @param id - The terminal instance ID
	 * @param property - The property to update
	 * @param value - The new value for the property
	 */
  async updateProperty<T extends ProcessPropertyType>(id: number, property: T, value: IProcessPropertyMap[T]): Promise<void> {
    const pty = this._ptys.get(id);
    if (pty) {
      await pty.updateProperty(property, value);
    }
  }

  /**
	 * Dispose of the backend and all associated resources.
	 *
	 * Clears all tracked PTY instances, titles, icons, pending commands,
	 * and disposes the PTY host controller.
	 */
  override dispose(): void {
    this._ptys.clear();
    this._titles.clear();
    this._icons.clear();
    this._pendingCommands.clear();
    this._tauriPtyHostController.dispose();
    super.dispose();
  }
}

// Register the TauriTerminalBackendContribution as a workbench contribution
registerWorkbenchContribution2(TauriTerminalBackendContribution.ID, TauriTerminalBackendContribution, WorkbenchPhase.AfterRestored);
