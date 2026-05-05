#!/usr/bin/env bash
# Shared retry wrapper for CI steps.
# Usage: source .github/scripts/retry.sh && retry <max_attempts> <command...>
#
# retry - Execute a command with automatic retries on failure.
#
# Runs the given command up to <max_attempts> times. If the command succeeds
# (exits with code 0), returns immediately. On failure, waits 5 seconds
# before the next attempt. If all attempts are exhausted, emits a GitHub
# Actions error annotation and returns 1.
#
# Arguments:
#   $1 - max_attempts  Maximum number of times to run the command (must be >= 1)
#   $2... - command    The command and its arguments to execute
#
# Returns:
#   0 on success, 1 if all attempts fail
#
# Side effects:
#   Prints attempt progress to stdout
#   Emits "::error::" annotation on final failure (consumed by GitHub Actions)
#
# Example:
#   retry 3 npm ci
#   retry 5 curl -fsSL https://example.com/artifact.tar.gz | tar xz
retry() {
  local max=$1 n=1; shift
  while [ $n -le $max ]; do
    echo "Attempt $n/$max: $*"
    if "$@"; then return 0; fi
    n=$((n + 1)) && [ $n -le $max ] && sleep 5
  done
  echo "::error::All $max attempts failed"
  return 1
}
