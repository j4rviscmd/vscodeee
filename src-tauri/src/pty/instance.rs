/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Individual PTY instance — wraps a `portable-pty` master/slave pair.
//!
//! Each `PtyInstance` owns:
//! - A writer handle to send data to the shell's stdin
//! - A master handle for resize operations
//! - A background reader thread that emits output via Tauri events
//! - A child process handle for lifecycle management

use std::io::Write;
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

/// Configuration for creating a new PTY instance.
pub struct PtyConfig {
    pub shell: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub id: u32,
}

/// A running PTY instance with handles for I/O and control.
pub struct PtyInstance {
    /// Writer handle to send data to the shell's stdin.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// Master PTY handle for resize operations.
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    /// Handle to the background reader thread (joined on drop).
    _reader_handle: Option<thread::JoinHandle<()>>,
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
    pub fn spawn(config: PtyConfig, app_handle: tauri::AppHandle) -> Result<Self, String> {
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

        // Spawn the shell in the slave PTY
        let mut _child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell '{}': {e}", config.shell))?;

        // Drop the slave — we only interact through the master
        drop(pair.slave);

        // Get the writer handle (can only be called once per portable-pty API)
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to take PTY writer: {e}"))?;
        let writer = Arc::new(Mutex::new(writer));

        // Get the reader handle for output
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;

        let master: Box<dyn MasterPty + Send> = pair.master;
        let master = Arc::new(Mutex::new(master));

        // Start background reader thread
        let pty_id = config.id;
        let reader_handle = thread::spawn(move || {
            use tauri::Emitter;

            let event_name = format!("pty-output-{pty_id}");
            let mut buf = [0u8; 8192];

            loop {
                match std::io::Read::read(&mut reader, &mut buf) {
                    Ok(0) => {
                        // EOF — PTY closed
                        println!("[pty:{pty_id}] Reader EOF");
                        let _ = app_handle.emit(
                            &format!("pty-exit-{pty_id}"),
                            serde_json::json!({ "id": pty_id, "exitCode": 0 }),
                        );
                        break;
                    }
                    Ok(n) => {
                        // Emit the output data as a Tauri event.
                        // We send raw bytes as a Vec<u8> for binary safety
                        // (xterm.js handles UTF-8 and escape sequences).
                        let data = buf[..n].to_vec();
                        if let Err(e) = app_handle.emit(&event_name, data) {
                            eprintln!("[pty:{pty_id}] Failed to emit output event: {e}");
                            break;
                        }
                    }
                    Err(e) => {
                        eprintln!("[pty:{pty_id}] Reader error: {e}");
                        let _ = app_handle.emit(
                            &format!("pty-exit-{pty_id}"),
                            serde_json::json!({ "id": pty_id, "exitCode": -1 }),
                        );
                        break;
                    }
                }
            }
        });

        Ok(Self {
            writer,
            master,
            _reader_handle: Some(reader_handle),
        })
    }

    /// Write data to the PTY (sends to the shell's stdin).
    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| "PTY writer lock poisoned".to_string())?;
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
        let master = self
            .master
            .lock()
            .map_err(|_| "PTY master lock poisoned".to_string())?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("PTY resize failed: {e}"))
    }
}
