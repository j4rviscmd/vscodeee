/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Individual PTY instance — wraps a `portable-pty` master/slave pair.
//!
//! Each `PtyInstance` owns:
//! - A writer handle to send data to the shell's stdin
//! - A master handle for resize operations
//! - A background reader thread that emits output via Tauri events
//! - A child process handle for lifecycle management (PID, signals, exit)
//!
//! ## Flow Control
//!
//! Implements ack-based backpressure matching VS Code's `FlowControlConstants`.
//! When unacknowledged chars exceed `HIGH_WATERMARK_CHARS`, the reader thread
//! pauses reading. The frontend sends `acknowledge_terminal` to decrement the
//! counter, and reading resumes when it drops below `LOW_WATERMARK_CHARS`.

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;

use super::autoreply::AutoReplyInterceptor;

/// Flow control watermarks matching VS Code's `FlowControlConstants`.
const HIGH_WATERMARK_CHARS: u64 = 100_000;
const LOW_WATERMARK_CHARS: u64 = 5_000;
/// Sleep duration when the reader is paused (flow control).
const PAUSED_POLL_INTERVAL: Duration = Duration::from_millis(1);
/// Maximum time to stay paused before force-resuming.
/// Prevents deadlock when acks don't arrive (e.g., VS Code's AckDataBufferer
/// chain not yet wired through for the Tauri backend).
const PAUSE_TIMEOUT: Duration = Duration::from_millis(100);

/// Configuration for creating a new PTY instance.
pub struct PtyConfig {
    pub shell: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub id: u32,
    /// Additional environment variables to set in the shell process.
    /// These are overlaid on top of the inherited parent environment.
    pub env: HashMap<String, String>,
}

/// Summary of a running PTY process, used by `list_processes`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSummary {
    /// The PTY instance ID (not the OS PID).
    pub id: u32,
    /// The OS process ID of the shell.
    pub pid: u32,
    /// The shell executable path.
    pub shell: String,
    /// The working directory the shell was started in.
    pub cwd: String,
    /// Whether the child process is still running.
    pub is_alive: bool,
}

/// Shared flow control state between the reader thread and the acknowledge command.
///
/// Uses lock-free atomics for the hot path (reader thread incrementing,
/// acknowledge command decrementing). `Ordering::Relaxed` is sufficient
/// because flow control is approximate — the generous watermark margins
/// absorb any race-induced drift.
struct FlowControlState {
    /// Number of chars sent to the frontend but not yet acknowledged.
    unacknowledged_chars: AtomicU64,
    /// When true, the reader thread should stop reading from the PTY.
    paused: AtomicBool,
}

impl FlowControlState {
    fn new() -> Self {
        Self {
            unacknowledged_chars: AtomicU64::new(0),
            paused: AtomicBool::new(false),
        }
    }
}

/// A running PTY instance with handles for I/O and control.
pub struct PtyInstance {
    /// Writer handle to send data to the shell's stdin.
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    /// Master PTY handle for resize operations.
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    /// Handle to the background reader thread (detached on drop).
    _reader_handle: Option<thread::JoinHandle<()>>,
    /// Child process handle — retained for signal delivery and PID tracking.
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    /// The OS process ID of the child shell.
    pid: u32,
    /// The shell executable path.
    shell: String,
    /// The working directory the shell was started in.
    cwd: String,
    /// One-shot channel sender to activate the reader thread.
    /// `None` after activation (consumed on first call to `activate()`).
    activate_tx: Mutex<Option<std::sync::mpsc::SyncSender<()>>>,
    /// Shared flow control state for reader thread backpressure.
    flow_control: Arc<FlowControlState>,
}

impl Drop for PtyInstance {
    fn drop(&mut self) {
        let pid = self.pid;
        log::info!(target: "vscodeee::pty::instance", "Dropping PTY instance (pid={pid})");

        // 1. Close the writer (sends EOF to the shell's stdin)
        if let Ok(mut writer) = self.writer.lock() {
            *writer = None;
        }

        // 2. Kill the child process if still alive
        #[cfg(unix)]
        {
            // Use libc::kill directly for synchronous termination — the tokio
            // runtime may already be shut down during Drop.
            if self.pid != 0 {
                unsafe {
                    // First try SIGTERM for graceful shutdown
                    libc::kill(self.pid as i32, libc::SIGTERM);
                }
                // Give the process a moment, then SIGKILL if still alive
                std::thread::sleep(std::time::Duration::from_millis(100));
                if let Ok(mut child) = self.child.lock() {
                    if let Ok(None) = child.try_wait() {
                        // Still running — force kill
                        unsafe {
                            libc::kill(self.pid as i32, libc::SIGKILL);
                        }
                    }
                }
            }
        }
        #[cfg(not(unix))]
        {
            if let Ok(mut child) = self.child.lock() {
                let _ = child.kill();
            }
        }

        // 3. Drop the master PTY handle — on Unix this sends SIGHUP to the
        //    child's session, ensuring termination of the process group.
        if let Ok(mut master) = self.master.lock() {
            *master = None;
        }

        log::info!(target: "vscodeee::pty::instance", "PTY instance dropped (pid={pid})");
    }
}

impl PtyInstance {
    /// Spawn a new PTY with the given configuration.
    ///
    /// This creates a pseudo-terminal, spawns the shell process, and starts
    /// a background thread to read output. Output is emitted as Tauri events
    /// (`pty-output-{id}`) to the given app handle.
    ///
    /// # Arguments
    /// * `config` — Shell, working directory, and terminal dimensions
    /// * `app_handle` — Tauri app handle for emitting events
    /// * `auto_reply` — Shared auto-reply interceptor (optional, pass None to disable)
    /// * `on_exit` — Callback invoked once when the reader thread detects shell exit
    pub fn spawn(
        config: PtyConfig,
        app_handle: tauri::AppHandle,
        auto_reply: Option<Arc<AutoReplyInterceptor>>,
        on_exit: Option<Box<dyn FnOnce() + Send>>,
    ) -> Result<Self, String> {
        let pty_system = native_pty_system();

        // Create the PTY pair (master + slave)
        let pair = pty_system
            .openpty(PtySize {
                rows: config.rows,
                cols: config.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open PTY: {e}"))?;

        // Build the shell command
        let mut cmd = CommandBuilder::new(&config.shell);
        cmd.cwd(&config.cwd);
        // Set TERM for proper terminal emulation
        cmd.env("TERM", "xterm-256color");

        // Remove environment variables inherited from the parent process
        // that describe the parent's terminal multiplexer state.
        // Without this, if `cargo tauri dev` runs inside tmux, the child
        // shell's .zshrc/.bashrc sees TMUX as set and skips interactive
        // session pickers (e.g., fzf-based tmux session selectors).
        cmd.env_remove("TMUX");
        cmd.env_remove("TMUX_PANE");

        // Apply additional environment variables from the frontend.
        // These overlay on top of the inherited parent environment.
        for (key, value) in &config.env {
            cmd.env(key, value);
        }

        // Spawn the shell in the slave PTY
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell '{}': {e}", config.shell))?;

        // Get the child PID before dropping the slave
        let pid = child.process_id().unwrap_or(0);

        // Drop the slave — we only interact through the master
        drop(pair.slave);

        let child = Arc::new(Mutex::new(child));

        // Get the writer handle (can only be called once per portable-pty API)
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to take PTY writer: {e}"))?;
        let writer = Arc::new(Mutex::new(Some(writer)));

        // Get the reader handle for output
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;

        let master: Box<dyn MasterPty + Send> = pair.master;
        let master = Arc::new(Mutex::new(Some(master)));

        // Shared flow control state between this instance and the reader thread.
        let flow_control = Arc::new(FlowControlState::new());
        let flow_control_reader = Arc::clone(&flow_control);

        // Start background reader thread
        // The reader blocks on a one-shot channel until activate() is called.
        // This gives the frontend time to register event listeners before any
        // output is emitted, preventing loss of initial shell output (e.g.,
        // interactive prompts from .zshrc like fzf session pickers).
        let pty_id = config.id;
        let writer_for_reply = Arc::clone(&writer);
        let (activate_tx, activate_rx) = std::sync::mpsc::sync_channel::<()>(0);
        let reader_handle = thread::spawn(move || {
            use tauri::Emitter;

            // Wait for activation signal from the frontend.
            // The PTY output is buffered in the kernel's PTY buffer until we read it,
            // so no data is lost during the wait.
            if activate_rx.recv().is_err() {
                log::warn!(target: "vscodeee::pty::instance",
                    "Reader activation channel closed before signal (pty:{pty_id})");
                return;
            }
            log::info!(target: "vscodeee::pty::instance", "Reader activated (pty:{pty_id})");

            let event_name = format!("pty-output-{pty_id}");
            let exit_event_name = format!("pty-exit-{pty_id}");
            let mut buf = [0u8; 8192];
            let mut pause_start: Option<Instant> = None;

            loop {
                // When paused, sleep and periodically check the flag.
                // The kernel PTY buffer provides natural backpressure: as it fills
                // up, the shell process blocks on write.
                if flow_control_reader.paused.load(Ordering::Relaxed) {
                    let now = Instant::now();
                    let start = *pause_start.get_or_insert(now);
                    if now.duration_since(start) > PAUSE_TIMEOUT {
                        flow_control_reader.paused.store(false, Ordering::Relaxed);
                        flow_control_reader
                            .unacknowledged_chars
                            .store(0, Ordering::Relaxed);
                        pause_start = None;
                        log::debug!(target: "vscodeee::pty::instance",
                            "Flow control: force-resumed after timeout (pty:{pty_id})");
                        continue;
                    }
                    thread::sleep(PAUSED_POLL_INTERVAL);
                    continue;
                }

                pause_start = None;

                match std::io::Read::read(&mut reader, &mut buf) {
                    Ok(0) => {
                        log::info!(target: "vscodeee::pty::instance", "Reader EOF (pty:{pty_id})");
                        let _ = app_handle.emit(
                            &exit_event_name,
                            serde_json::json!({ "id": pty_id, "exitCode": 0 }),
                        );
                        break;
                    }
                    Ok(n) => {
                        let data = &buf[..n];

                        // Check auto-reply patterns before emitting
                        if let Some(ref interceptor) = auto_reply {
                            if let Some(reply) = interceptor.check(data) {
                                if let Ok(mut guard) = writer_for_reply.lock() {
                                    if let Some(ref mut w) = *guard {
                                        let _ = w.write_all(reply.as_bytes());
                                        let _ = w.flush();
                                    }
                                }
                            }
                        }

                        let char_count = n as u64;
                        if let Err(e) = app_handle.emit(&event_name, data.to_vec()) {
                            log::error!(target: "vscodeee::pty::instance",
                                "Failed to emit output event (pty:{pty_id}): {e}");
                            break;
                        }

                        // Track unacknowledged chars and check high watermark.
                        let prev = flow_control_reader
                            .unacknowledged_chars
                            .fetch_add(char_count, Ordering::Relaxed);
                        let total = prev + char_count;
                        if total > HIGH_WATERMARK_CHARS {
                            flow_control_reader.paused.store(true, Ordering::Relaxed);
                            log::debug!(target: "vscodeee::pty::instance",
                                "Flow control: paused (pty:{pty_id}, unack:{total})");
                        }
                    }
                    Err(e) => {
                        log::error!(target: "vscodeee::pty::instance",
                            "Reader error (pty:{pty_id}): {e}");
                        let _ = app_handle.emit(
                            &exit_event_name,
                            serde_json::json!({ "id": pty_id, "exitCode": -1 }),
                        );
                        break;
                    }
                }
            }

            // Notify the manager that this PTY has exited so it can clean up.
            if let Some(callback) = on_exit {
                callback();
            }
        });

        log::info!(target: "vscodeee::pty::instance",
            "Spawned PTY {pty_id} (pid={pid}, shell={})", config.shell);

        Ok(Self {
            writer,
            master,
            _reader_handle: Some(reader_handle),
            child,
            pid,
            shell: config.shell,
            cwd: config.cwd,
            activate_tx: Mutex::new(Some(activate_tx)),
            flow_control,
        })
    }

    /// Activate the PTY reader thread, allowing it to start emitting output events.
    ///
    /// This must be called after the frontend has registered event listeners for
    /// `pty-output-{id}` and `pty-exit-{id}`. Calling this before listeners are
    /// registered would cause the same race condition as the old immediate-start
    /// approach.
    ///
    /// Safe to call multiple times — only the first call has an effect.
    pub fn activate(&self) -> Result<(), String> {
        let mut tx = self
            .activate_tx
            .lock()
            .map_err(|_| "Activate lock poisoned".to_string())?;
        if let Some(sender) = tx.take() {
            sender
                .send(())
                .map_err(|_| "Reader thread already terminated".to_string())?;
        }
        // Already activated — no-op
        Ok(())
    }

    /// Acknowledge that the frontend has processed `char_count` characters of output.
    ///
    /// Decrements the unacknowledged char counter. If the reader thread is currently
    /// paused and the counter drops below `LOW_WATERMARK_CHARS`, reading resumes.
    pub fn acknowledge_data(&self, char_count: u64) {
        let prev = self
            .flow_control
            .unacknowledged_chars
            .fetch_sub(char_count, Ordering::Relaxed);
        let current = prev.saturating_sub(char_count);

        // Clamp stored value if fetch_sub underflowed (wraps near u64::MAX)
        if prev < char_count {
            self.flow_control
                .unacknowledged_chars
                .store(0, Ordering::Relaxed);
        }

        if self.flow_control.paused.load(Ordering::Relaxed) && current < LOW_WATERMARK_CHARS {
            self.flow_control.paused.store(false, Ordering::Relaxed);
            log::debug!(target: "vscodeee::pty::instance",
                "Flow control: resumed (unack:{current})");
        }
    }

    /// Get the current flow control state for diagnostics.
    pub fn flow_control_state(&self) -> (u64, bool) {
        (
            self.flow_control
                .unacknowledged_chars
                .load(Ordering::Relaxed),
            self.flow_control.paused.load(Ordering::Relaxed),
        )
    }

    /// Reset the unacknowledged char counter and resume reading.
    ///
    /// Called after terminal replay/reconnect where previously sent data
    /// is effectively acknowledged by the viewport reset.
    // TODO(Phase 3): Wire up from terminal replay path
    #[allow(dead_code)]
    pub fn clear_unacknowledged_chars(&self) {
        self.flow_control
            .unacknowledged_chars
            .store(0, Ordering::Relaxed);
        self.flow_control.paused.store(false, Ordering::Relaxed);
    }

    /// Write data to the PTY (sends to the shell's stdin).
    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| "PTY writer lock poisoned".to_string())?;
        let writer = writer
            .as_mut()
            .ok_or_else(|| "PTY writer already closed".to_string())?;
        writer
            .write_all(data)
            .map_err(|e| format!("PTY write failed: {e}"))?;
        writer
            .flush()
            .map_err(|e| format!("PTY flush failed: {e}"))?;
        Ok(())
    }

    /// Resize the PTY to new dimensions.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let mut master = self
            .master
            .lock()
            .map_err(|_| "PTY master lock poisoned".to_string())?;
        let master = master
            .as_mut()
            .ok_or_else(|| "PTY master already closed".to_string())?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("PTY resize failed: {e}"))
    }

    /// Send a signal to the child process.
    ///
    /// Maps signal names (e.g., "SIGINT", "SIGTERM") to platform-specific
    /// signal numbers. On Unix, uses `libc::kill`. On Windows, uses
    /// `TerminateProcess` for SIGKILL and `Ctrl+C` event for SIGINT.
    pub fn send_signal(&self, signal: &str) -> Result<(), String> {
        let pid = self.pid;
        if pid == 0 {
            return Err("Cannot send signal: no PID".to_string());
        }

        #[cfg(unix)]
        {
            let sig = match signal {
                "SIGINT" => libc::SIGINT,
                "SIGTERM" => libc::SIGTERM,
                "SIGKILL" => libc::SIGKILL,
                "SIGHUP" => libc::SIGHUP,
                "SIGQUIT" => libc::SIGQUIT,
                "SIGUSR1" => libc::SIGUSR1,
                "SIGUSR2" => libc::SIGUSR2,
                _ => return Err(format!("Unsupported signal: {signal}")),
            };
            let ret = unsafe { libc::kill(pid as i32, sig) };
            if ret != 0 {
                return Err(format!(
                    "Failed to send {signal} to pid {pid}: {}",
                    std::io::Error::last_os_error()
                ));
            }
            log::debug!(target: "vscodeee::pty::instance", "Sent {signal} to pid {pid}");
            Ok(())
        }

        #[cfg(target_os = "windows")]
        {
            // On Windows, we can't easily send signals via portable-pty.
            // For SIGKILL, terminate the child. For SIGINT, send Ctrl+C.
            match signal {
                "SIGKILL" | "SIGTERM" => {
                    let mut child = self.child.lock().map_err(|_| "lock poisoned".to_string())?;
                    child
                        .kill()
                        .map_err(|e| format!("Failed to kill process: {e}"))
                }
                "SIGINT" => {
                    // Write Ctrl+C to the PTY
                    self.write(b"\x03")
                }
                _ => Err(format!("Unsupported signal on Windows: {signal}")),
            }
        }
    }

    /// Check if the child process is still alive.
    pub fn is_alive(&self) -> bool {
        if let Ok(mut child) = self.child.lock() {
            match child.try_wait() {
                Ok(Some(_)) => false, // Exited
                Ok(None) => true,     // Still running
                Err(_) => false,      // Error — assume dead
            }
        } else {
            false // Lock poisoned — assume dead
        }
    }

    /// Get the process summary for listing.
    pub fn process_summary(&self, id: u32) -> ProcessSummary {
        ProcessSummary {
            id,
            pid: self.pid,
            shell: self.shell.clone(),
            cwd: self.cwd.clone(),
            is_alive: self.is_alive(),
        }
    }
}
