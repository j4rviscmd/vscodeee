/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Console Interceptor — forwards all console.* calls to Rust backend via tauri-plugin-log.
 *
 * Architecture:
 *   console.log("hello")
 *     → interceptor serializes args + extracts caller location
 *     → invoke('plugin:log|log', { level, message, location })
 *       → tauri-plugin-log (fern) → stdout (backend terminal)
 *
 * Must be loaded BEFORE any other script that uses console.*.
 * Designed for `withGlobalTauri: true` (window.__TAURI__).
 */

/** Console methods to intercept. */
type ConsoleMethod = 'log' | 'warn' | 'error' | 'info' | 'debug';

/**
 * tauri-plugin-log LogLevel enum values (mirrors Rust `log::Level`).
 *
 * Trace = 1, Debug = 2, Info = 3, Warn = 4, Error = 5
 */
const LEVEL_MAP: Record<ConsoleMethod, number> = {
  debug: 2, // LogLevel.Debug
  log: 3,   // LogLevel.Info
  info: 3,  // LogLevel.Info
  warn: 4,  // LogLevel.Warn
  error: 5, // LogLevel.Error
};

/** Tauri invoke function signature. */
type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Options for the console interceptor. */
interface InterceptorOptions {
  /** Whether to also call the original console method (default: true). */
  passthrough?: boolean;
}

/**
 * Install a console interceptor that forwards all console.* calls
 * to the Rust backend via tauri-plugin-log.
 *
 * @param invoke - The Tauri invoke function (from `window.__TAURI__.core.invoke`)
 * @param options - Interceptor options
 * @returns A dispose function to restore original console methods.
 */
export function installConsoleInterceptor(
  invoke: TauriInvoke,
  options?: InterceptorOptions,
): () => void {
  const passthrough = options?.passthrough ?? true;

  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug,
  };

  /** Extract caller file:line:col from stack trace (V8 format). */
  function getCallerLocation(): string | undefined {
    const stack = new Error().stack;
    if (!stack) { return undefined; }

    const lines = stack.split('\n');
    // Skip: "Error", "getCallerLocation", "createInterceptor.<computed>", then caller
    // Chromium V8: at functionName (file:line:col)
    for (let i = 3; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (!line) { continue; }

      // Skip internal Tauri/plugin frames
      if (line.includes('node_modules') || line.includes('tauri-plugin')) { continue; }

      const match = line.match(/at\s+(?<fn>.*?)\s+\((?<file>.*?):(?<line>\d+):(?<col>\d+)\)/);
      if (match?.groups) {
        return `${match.groups.file}:${match.groups.line}:${match.groups.col}`;
      }

      const matchNoFn = line.match(/at\s+(?<file>.*?):(?<line>\d+):(?<col>\d+)/);
      if (matchNoFn?.groups) {
        return `${matchNoFn.groups.file}:${matchNoFn.groups.line}:${matchNoFn.groups.col}`;
      }
    }
    return undefined;
  }

  /** Serialize arguments to a single string for the log message. */
  function serializeArgs(args: unknown[]): string {
    return args.map(arg => {
      if (arg === null) { return 'null'; }
      if (arg === undefined) { return 'undefined'; }
      if (typeof arg === 'string') { return arg; }
      if (arg instanceof Error) {
        return `${arg.message}\n${arg.stack ?? ''}`;
      }
      try {
        return JSON.stringify(arg, null, 2);
      } catch {
        return String(arg);
      }
    }).join(' ');
  }

  /** Create an interceptor function for a specific console method. */
  function createInterceptor(method: ConsoleMethod) {
    return function (...args: unknown[]) {
      // Pass through to original console (DevTools still works)
      if (passthrough) {
        originalConsole[method].apply(console, args);
      }

      const location = getCallerLocation();
      const message = serializeArgs(args);

      // Fire-and-forget — never await, never throw
      invoke('plugin:log|log', {
        level: LEVEL_MAP[method],
        message,
        location,
      }).catch(() => { });
    };
  }

  // Override console methods
  console.log = createInterceptor('log');
  console.warn = createInterceptor('warn');
  console.error = createInterceptor('error');
  console.info = createInterceptor('info');
  console.debug = createInterceptor('debug');

  // Return dispose function to restore originals
  return () => {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    console.info = originalConsole.info;
    console.debug = originalConsole.debug;
  };
}

// Expose to global scope for inline <script> usage
// eslint-disable-next-line no-restricted-globals
(window as unknown as Record<string, unknown>).installConsoleInterceptor = installConsoleInterceptor;
