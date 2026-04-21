/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * TauriPty — ITerminalChildProcess implementation backed by Rust PTY via Tauri IPC.
 *
 * Each TauriPty instance corresponds to a single Rust PTY instance managed by
 * PtyManager on the Rust side. Communication happens through:
 *   - invoke('create_terminal') → spawn a new PTY
 *   - invoke('write_terminal')  → send input to PTY stdin
 *   - invoke('resize_terminal') → resize PTY dimensions
 *   - invoke('close_terminal')  → close and cleanup PTY
 *   - listen('pty-output-{id}') → receive PTY stdout data
 *   - listen('pty-exit-{id}')   → receive PTY exit notification
 *
 * ## Flow Control
 *
 * Implements VS Code's flow control mechanism via acknowledgeDataEvent().
 * When unacknowledged characters exceed HighWatermarkChars, output is buffered
 * until the client catches up to LowWatermarkChars.
 */

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { FlowControlConstants, ProcessPropertyType, ITerminalLogService, type IProcessDataEvent, type IProcessProperty, type IProcessPropertyMap, type IProcessReadyEvent, type ITerminalChildProcess, type ITerminalLaunchError, type ITerminalLaunchResult } from '../../../../platform/terminal/common/terminal.js';

import { tauriInvoke } from './tauriIpc.js';

/**
 * Subscribe to a Tauri event and return an unlisten function.
 *
 * Uses the Tauri v2 plugin:event system for low-latency event delivery.
 * The returned function must be called to stop receiving events and avoid leaks.
 *
 * @param event - The event name to listen for (e.g., `pty-output-1`)
 * @param handler - Callback invoked with the event payload each time the event fires
 * @returns A promise that resolves to an unlisten function
 * @throws {Error} If the Tauri event system is not available in the current context
 */
function tauriListen(event: string, handler: (payload: unknown) => void): Promise<() => void> {
  const w = globalThis as unknown as {
    __TAURI_INTERNALS__?: {
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise<number>;
    };
  };
  if (w.__TAURI_INTERNALS__?.invoke) {
    // Tauri v2 event listening via plugin:event
    // Use the core event system
    const eventId = w.__TAURI_INTERNALS__.invoke('plugin:event|listen', {
      event,
      target: { kind: 'Any' },
      handler: (globalThis as unknown as { __TAURI_INTERNALS__: { transformCallback: (cb: (event: { payload: unknown }) => void) => number } }).__TAURI_INTERNALS__.transformCallback(
        (ev: { payload: unknown }) => handler(ev.payload),
      ),
    });
    return eventId.then(id => {
      return () => {
        w.__TAURI_INTERNALS__?.invoke('plugin:event|unlisten', { event, eventId: id });
      };
    });
  }
  throw new Error('Tauri event system not available');
}

/**
 * PTY child process implementation backed by the Rust PTY via Tauri IPC.
 *
 * Each instance maps 1:1 to a Rust-side `PtyInstance` managed by `PtyManager`.
 * Output flows from the Rust reader thread as Tauri events (`pty-output-{id}`),
 * and input is sent via Tauri invoke (`write_terminal`).
 *
 * Implements VS Code's flow control protocol: when unacknowledged output
 * exceeds `FlowControlConstants.HighWatermarkChars`, the instance pauses
 * emission and buffers data until the consumer calls `acknowledgeDataEvent`
 * to drain back below `FlowControlConstants.LowWatermarkChars`.
 */
export class TauriPty extends Disposable implements ITerminalChildProcess {
  // The Rust PTY id, assigned after start()
  private _ptyId: number = 0;
  id: number;
  shouldPersist: boolean = false;

  // Flow control state
  private _unacknowledgedCharCount = 0;
  private _isPaused = false;
  private _pendingData: string[] = [];

  // Event unlisten functions
  private _unlistenOutput: (() => void) | undefined;
  private _unlistenExit: (() => void) | undefined;

  // Process properties
  private readonly _properties: IProcessPropertyMap = {
    cwd: '',
    initialCwd: '',
    fixedDimensions: { cols: undefined, rows: undefined },
    title: '',
    shellType: undefined,
    hasChildProcesses: true,
    resolvedShellLaunchConfig: {},
    overrideDimensions: undefined,
    failedShellIntegrationActivation: false,
    usedShellIntegrationInjection: undefined,
    shellIntegrationInjectionFailureReason: undefined,
  };

  // Dimensions tracking
  private _lastDimensions: { cols: number; rows: number } = { cols: -1, rows: -1 };

  /**
	 * Persistent TextDecoder for streaming UTF-8 decoding.
	 *
	 * PTY output arrives in arbitrary-sized chunks (up to 8192 bytes from the
	 * Rust reader thread) that may split multi-byte UTF-8 sequences across chunk
	 * boundaries. Using `{ stream: true }` in each `decode()` call tells the
	 * decoder to buffer any incomplete trailing bytes and prepend them to the
	 * next chunk, preventing U+FFFD replacement characters from appearing.
	 *
	 * This mirrors how node-pty handles UTF-8 internally — the PTY backend
	 * reads raw bytes, and the consumer side is responsible for correct decoding.
	 */
  private readonly _decoder = new TextDecoder('utf-8', { fatal: false });

  // Events
  private readonly _onProcessData = this._register(new Emitter<IProcessDataEvent | string>());
  readonly onProcessData = this._onProcessData.event;
  private readonly _onProcessReady = this._register(new Emitter<IProcessReadyEvent>());
  readonly onProcessReady = this._onProcessReady.event;
  private readonly _onDidChangeProperty = this._register(new Emitter<IProcessProperty>());
  readonly onDidChangeProperty = this._onDidChangeProperty.event;
  private readonly _onProcessExit = this._register(new Emitter<number | undefined>());
  readonly onProcessExit = this._onProcessExit.event;

  constructor(
    id: number,
    private readonly _shell: string,
    private readonly _cwd: string,
    private readonly _cols: number,
    private readonly _rows: number,
    private readonly _env: Record<string, string>,
    private readonly _logService: ITerminalLogService,
  ) {
    super();
    this.id = id;
    this._properties.initialCwd = _cwd;
    this._properties.cwd = _cwd;
    this._lastDimensions = { cols: _cols, rows: _rows };
  }

  /**
	 * Start the PTY process.
	 *
	 * Uses a two-phase startup to prevent race conditions with initial output:
	 * 1. Spawn the PTY via Rust (reader thread is paused)
	 * 2. Register event listeners for output and exit
	 * 3. Activate the reader thread (output starts flowing)
	 *
	 * This ensures that interactive programs started during shell initialization
	 * (e.g., fzf session pickers in .zshrc) have their output captured from
	 * the very first byte.
	 *
	 * @returns `undefined` on success, or an `ITerminalLaunchError` on failure
	 */
  async start(): Promise<ITerminalLaunchError | ITerminalLaunchResult | undefined> {
    try {
      this._logService.trace('TauriPty#start', { id: this.id, shell: this._shell, cwd: this._cwd });

      // Phase 1: Spawn the PTY via Rust (reader thread is paused)
      this._ptyId = await tauriInvoke<number>('create_terminal', {
        shell: this._shell,
        cwd: this._cwd,
        cols: this._cols,
        rows: this._rows,
        env: this._env,
      });

      this._logService.trace('TauriPty#start spawned', { id: this.id, ptyId: this._ptyId });

      // Phase 2: Register event listeners BEFORE activating the reader
      // Listen for output data from the Rust PTY
      this._unlistenOutput = await tauriListen(`pty-output-${this._ptyId}`, (payload: unknown) => {
        // Payload is Vec<u8> from Rust, arrives as number[] in JS.
        // Use the persistent decoder with { stream: true } so that
        // multi-byte UTF-8 sequences split across chunk boundaries are
        // buffered and correctly decoded on the next call, instead of
        // being replaced with U+FFFD replacement characters.
        let data: string;
        if (payload instanceof Uint8Array) {
          data = this._decoder.decode(payload, { stream: true });
        } else if (typeof payload === 'string') {
          data = payload;
        } else if (Array.isArray(payload)) {
          data = this._decoder.decode(new Uint8Array(payload as number[]), { stream: true });
        } else {
          data = String(payload);
        }

        this._handleOutput(data);
      });

      // Listen for exit event
      this._unlistenExit = await tauriListen(`pty-exit-${this._ptyId}`, (payload: unknown) => {
        const exitData = payload as { id: number; exitCode: number } | undefined;
        const exitCode = exitData?.exitCode ?? undefined;
        this._logService.trace('TauriPty#exit', { id: this.id, ptyId: this._ptyId, exitCode });
        this._onProcessExit.fire(exitCode);
      });

      // Phase 3: Activate the reader thread now that listeners are registered.
      // This unblocks the Rust reader thread, which will read all buffered
      // PTY output and emit it as events that we're now ready to receive.
      await tauriInvoke('activate_terminal', { id: this._ptyId });
      this._logService.trace('TauriPty#start activated', { id: this.id, ptyId: this._ptyId });

      // Fire process ready event
      // TODO: Get actual PID from Rust if needed
      this._onProcessReady.fire({
        pid: this._ptyId, // Use pty ID as pseudo-PID
        cwd: this._cwd,
        windowsPty: undefined,
      });

      return undefined; // Success
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._logService.error('TauriPty#start failed', message);
      return { message };
    }
  }

  /**
	 * Handle output data with flow control.
	 */
  private _handleOutput(data: string): void {
    if (this._isPaused) {
      this._pendingData.push(data);
      return;
    }

    this._unacknowledgedCharCount += data.length;
    this._onProcessData.fire(data);

    // Check if we need to pause
    if (this._unacknowledgedCharCount > FlowControlConstants.HighWatermarkChars) {
      this._isPaused = true;
      this._logService.trace('TauriPty#flowControl paused', {
        id: this.id,
        unacknowledgedChars: this._unacknowledgedCharCount,
      });
    }
  }

  /**
	 * Acknowledge that the consumer has processed `charCount` characters of output.
	 *
	 * Decrements the unacknowledged character counter. If the instance is
	 * currently paused and the counter drops below `LowWatermarkChars`,
	 * the instance resumes emitting and flushes any buffered data.
	 *
	 * @param charCount - Number of characters the consumer has processed
	 */
  acknowledgeDataEvent(charCount: number): void {
    this._unacknowledgedCharCount = Math.max(this._unacknowledgedCharCount - charCount, 0);

    // Resume if we've dropped below the low watermark
    if (this._isPaused && this._unacknowledgedCharCount < FlowControlConstants.LowWatermarkChars) {
      this._isPaused = false;
      this._logService.trace('TauriPty#flowControl resumed', {
        id: this.id,
        unacknowledgedChars: this._unacknowledgedCharCount,
      });

      // Flush any buffered data
      const pending = this._pendingData.splice(0);
      for (const data of pending) {
        this._handleOutput(data);
      }
    }
  }

  /**
	 * Send input data to the PTY's stdin.
	 *
	 * No-op if the PTY has not been started yet (`_ptyId === 0`).
	 *
	 * @param data - The string data to send to the shell's stdin
	 */
  input(data: string): void {
    if (this._ptyId === 0) {
      return; // Not started yet
    }
    tauriInvoke('write_terminal', { id: this._ptyId, data }).catch(err => {
      this._logService.error('TauriPty#input failed', err instanceof Error ? err.message : String(err));
    });
  }

  /**
	 * Resize the PTY to the given dimensions.
	 *
	 * Skips the IPC call if the dimensions are unchanged from the last resize.
	 * No-op if the PTY has not been started yet.
	 *
	 * @param cols - New terminal column count
	 * @param rows - New terminal row count
	 */
  resize(cols: number, rows: number): void {
    if (this._ptyId === 0) {
      return; // Not started yet
    }
    if (this._lastDimensions.cols === cols && this._lastDimensions.rows === rows) {
      return; // No change
    }
    this._lastDimensions = { cols, rows };
    tauriInvoke('resize_terminal', { id: this._ptyId, cols, rows }).catch(err => {
      this._logService.error('TauriPty#resize failed', err instanceof Error ? err.message : String(err));
    });
  }

  /**
	 * Shut down the PTY process.
	 *
	 * Sends a close command to the Rust PTY manager. The `immediate` parameter
	 * is accepted for interface compatibility but is not differentiated —
	 * the PTY is always closed immediately.
	 *
	 * @param immediate - Whether to force immediate shutdown (currently unused, always closes immediately)
	 */
  shutdown(immediate: boolean): void {
    if (this._ptyId === 0) {
      return;
    }
    this._logService.trace('TauriPty#shutdown', { id: this.id, ptyId: this._ptyId, immediate });
    tauriInvoke('close_terminal', { id: this._ptyId }).catch(err => {
      this._logService.error('TauriPty#shutdown failed', err instanceof Error ? err.message : String(err));
    });
  }

  /**
	 * Send a signal to the PTY's child process.
	 *
	 * Delegates to the Rust `send_terminal_signal` command.
	 * Supported signals: `SIGINT`, `SIGTERM`, `SIGKILL`, `SIGHUP`, `SIGQUIT`.
	 *
	 * @param signal - The signal name (e.g., `SIGINT`)
	 */
  sendSignal(signal: string): void {
    if (this._ptyId === 0) {
      return;
    }
    this._logService.trace('TauriPty#sendSignal', { id: this.id, ptyId: this._ptyId, signal });
    tauriInvoke('send_terminal_signal', { id: this._ptyId, signal }).catch(err => {
      this._logService.error('TauriPty#sendSignal failed', err instanceof Error ? err.message : String(err));
    });
  }

  /**
	 * Process binary data from the terminal.
	 *
	 * Currently a no-op. Binary data processing is not implemented in this
	 * Tauri PTY backend.
	 *
	 * @param _data - Binary data string (unused)
	 */
  async processBinary(_data: string): Promise<void> {
    // Binary data processing — not typically used in basic scenarios
  }

  /**
	 * Clear the terminal screen by sending ANSI escape sequences.
	 *
	 * Sends `\x1b[2J\x1b[H` (clear screen + move cursor to home position)
	 * to the PTY's stdin. This signals the shell to clear its scrollback buffer.
	 */
  async clearBuffer(): Promise<void> {
    // Send ANSI clear screen sequence via write.
    // xterm.js manages its own buffer, so this signals the shell
    // to clear its scrollback.
    if (this._ptyId !== 0) {
      this.input('\x1b[2J\x1b[H');
    }
  }

  /**
	 * Set the Unicode version for the terminal.
	 *
	 * No-op in this implementation — Unicode version handling is performed
	 * client-side by xterm.js.
	 *
	 * @param _version - Unicode version ('6' or '11'), unused
	 */
  async setUnicodeVersion(_version: '6' | '11'): Promise<void> {
    // No-op — unicode version handling is done client-side by xterm.js
  }

  /**
	 * Get the initial working directory that the shell was launched in.
	 *
	 * @returns The initial CWD string
	 */
  async getInitialCwd(): Promise<string> {
    return this._properties.initialCwd;
  }

  /**
	 * Get the current working directory of the shell process.
	 *
	 * Falls back to the initial CWD if the current CWD has not been updated.
	 *
	 * @returns The current CWD string
	 */
  async getCwd(): Promise<string> {
    return this._properties.cwd || this._properties.initialCwd;
  }

  /**
	 * Refresh and return a process property value.
	 *
	 * Returns the locally cached value without querying the Rust side.
	 *
	 * @typeParam T - The process property type to refresh
	 * @param _property - The property to refresh
	 * @returns The current value of the requested property
	 */
  async refreshProperty<T extends ProcessPropertyType>(_property: T): Promise<IProcessPropertyMap[T]> {
    return this._properties[_property];
  }

  /**
	 * Update a process property and notify listeners.
	 *
	 * Stores the new value in the local property map and fires
	 * `onDidChangeProperty` with the updated property type and value.
	 *
	 * @typeParam T - The process property type to update
	 * @param property - The property to update
	 * @param value - The new value for the property
	 */
  async updateProperty<T extends ProcessPropertyType>(property: T, value: IProcessPropertyMap[T]): Promise<void> {
    (this._properties as unknown as Record<string, unknown>)[property] = value;
    this._onDidChangeProperty.fire({ type: property, value });
  }

  /**
	 * Dispose of the PTY instance.
	 *
	 * Unsubscribes from Tauri output and exit events, closes the Rust PTY
	 * via `close_terminal`, and cleans up all internal state.
	 */
  override dispose(): void {
    // Unlisten from Tauri events
    this._unlistenOutput?.();
    this._unlistenExit?.();

    // Close the PTY if still running
    if (this._ptyId !== 0) {
      tauriInvoke('close_terminal', { id: this._ptyId }).catch(() => { /* ignore errors during dispose */ });
      this._ptyId = 0;
    }

    super.dispose();
  }
}
