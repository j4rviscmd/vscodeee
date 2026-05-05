#!/usr/bin/env bash
#----------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root for license information.
#----------------------------------------------------------
#
# check-csp-hash.sh — Verify that the CSP hash in webWorkerExtensionHostIframe.html
# matches the actual SHA-256 of the inline <script> content.
#
# Exit codes:
#   0 — hash matches
#   1 — hash mismatch (prints expected vs actual)
#   2 — file not found or other error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Resolve repo root: scripts/ is one level below repo root
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

IFRAME_HTML="$REPO_ROOT/src/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html"

if [ ! -f "$IFRAME_HTML" ]; then
    echo "ERROR: $IFRAME_HTML not found" >&2
    exit 2
fi

# Compute the SHA-256 hash of the inline <script> content.
# The browser computes the hash over the FULL text between <script> and </script>,
# including leading/trailing whitespace and newlines. We use Python to extract the
# content and hash it because the extraction logic is non-trivial in pure shell.
# The file path is passed via sys.argv to avoid shell-injection issues with paths
# containing special characters.
COMPUTED_HASH=$(python3 -c "
import hashlib, base64, re, sys

filepath = sys.argv[1]
with open(filepath, 'r') as f:
    content = f.read()

match = re.search(r'<script>(.*?)</script>', content, re.DOTALL)
if not match:
    print('ERROR: no <script> block found', file=sys.stderr)
    sys.exit(2)

script_text = match.group(1)
sha = hashlib.sha256(script_text.encode('utf-8')).digest()
print(base64.b64encode(sha).decode('ascii'))
" "$IFRAME_HTML") || {
    echo "ERROR: failed to compute hash" >&2
    exit 2
}

# Extract the hash currently declared in the CSP meta tag.
CSP_HASH=$(python3 -c "
import re, sys

filepath = sys.argv[1]
with open(filepath, 'r') as f:
    content = f.read()

match = re.search(r'sha256-([A-Za-z0-9+/=]+)', content)
if not match:
    print('ERROR: no sha256- hash found in CSP', file=sys.stderr)
    sys.exit(2)

print(match.group(1))
" "$IFRAME_HTML") || {
    echo "ERROR: failed to extract CSP hash" >&2
    exit 2
}

# Compare
if [ "$COMPUTED_HASH" = "$CSP_HASH" ]; then
# allow-any-unicode-next-line
    echo "✅ [check-csp-hash] Hash matches"
    exit 0
else
    echo "ERROR: CSP hash mismatch in webWorkerExtensionHostIframe.html" >&2
    echo "  Declared in CSP:  sha256-$CSP_HASH" >&2
    echo "  Actual (computed): sha256-$COMPUTED_HASH" >&2
    echo "" >&2
    echo "The inline <script> content was modified without updating the CSP hash." >&2
    echo "Update the sha256- value in the script-src directive to match the computed hash." >&2
    exit 1
fi
