/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Auto-reply interceptor — monitors PTY output and injects replies for matched patterns.
//!
//! This runs in the Rust reader thread for low latency. When output matches
//! a registered pattern string, the corresponding reply is written back to
//! the PTY automatically.

use std::collections::HashMap;
use std::sync::RwLock;

/// Manages auto-reply patterns across all PTY instances.
///
/// Thread-safe via `RwLock`. The reader thread acquires a read lock to check
/// patterns, while install/uninstall operations acquire a write lock.
pub struct AutoReplyInterceptor {
    replies: RwLock<HashMap<String, String>>,
}

impl AutoReplyInterceptor {
    /// Create a new interceptor with no patterns.
    pub fn new() -> Self {
        Self {
            replies: RwLock::new(HashMap::new()),
        }
    }

    /// Install an auto-reply pattern.
    ///
    /// When PTY output contains `match_str`, `reply` will be sent back.
    pub fn install_reply(&self, match_str: String, reply: String) {
        if let Ok(mut replies) = self.replies.write() {
            log::debug!(target: "vscodeee::pty::autoreply", "Installed auto-reply: match={match_str:?}, reply={reply:?}");
            replies.insert(match_str, reply);
        }
    }

    /// Remove all auto-reply patterns.
    pub fn uninstall_all(&self) {
        if let Ok(mut replies) = self.replies.write() {
            log::debug!(target: "vscodeee::pty::autoreply", "Uninstalled all auto-replies");
            replies.clear();
        }
    }

    /// Check if any registered pattern matches the given output data.
    ///
    /// Returns the reply string for the first matching pattern, if any.
    /// Called from the reader thread for each output chunk.
    ///
    /// **Note:** Only one reply is returned per call even if multiple patterns
    /// match. The iteration order over `HashMap` is non-deterministic, so when
    /// multiple patterns could match the same output, the specific reply is
    /// unpredictable. Install patterns with non-overlapping match strings
    /// if deterministic priority is required.
    pub fn check(&self, output: &[u8]) -> Option<String> {
        if let Ok(replies) = self.replies.read() {
            if replies.is_empty() {
                return None;
            }
            // Convert output to string for matching (lossy for non-UTF8)
            let output_str = String::from_utf8_lossy(output);
            for (pattern, reply) in replies.iter() {
                if output_str.contains(pattern.as_str()) {
                    log::debug!(target: "vscodeee::pty::autoreply", "Auto-reply triggered: pattern={pattern:?}");
                    return Some(reply.clone());
                }
            }
        }
        None
    }
}

impl Default for AutoReplyInterceptor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_no_match_returns_none() {
        let interceptor = AutoReplyInterceptor::new();
        let result = interceptor.check(b"Hello, World!");
        assert!(result.is_none());
    }

    #[test]
    fn test_match_returns_reply() {
        let interceptor = AutoReplyInterceptor::new();
        interceptor.install_reply("Are you sure?".to_string(), "y\r\n".to_string());
        let result = interceptor.check(b"Are you sure? [y/n]");
        assert_eq!(result, Some("y\r\n".to_string()));
    }

    #[test]
    fn test_uninstall_clears_all() {
        let interceptor = AutoReplyInterceptor::new();
        interceptor.install_reply("test".to_string(), "reply".to_string());
        interceptor.uninstall_all();
        let result = interceptor.check(b"test");
        assert!(result.is_none());
    }

    #[test]
    fn test_empty_interceptor_is_fast() {
        let interceptor = AutoReplyInterceptor::new();
        // Should return None immediately without any allocation
        let result = interceptor.check(b"some output data");
        assert!(result.is_none());
    }
}
