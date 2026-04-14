#!/usr/bin/env bash
#---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
#---------------------------------------------------------------------------------------------

# check-deps.sh — Verify node_modules exist before dev server startup.
# Lightweight guard: checks both root and key extension node_modules.
# Run as part of npm scripts to prevent "Cannot find module" errors
# when working in a fresh worktree where postinstall hasn't run.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ ! -d "$REPO_ROOT/node_modules" ]]; then
	echo "[ERROR] Root node_modules not found. Run 'npm install' first."
	echo "  cd $REPO_ROOT && npm install"
	exit 1
fi

# Verify postinstall completed by checking a representative extension's node_modules.
# extensions/git depends on several npm packages (byline, etc.) and is itself
# a dependency of other extensions, making it a reliable indicator.
if [[ ! -d "$REPO_ROOT/extensions/git/node_modules" ]]; then
	echo "[ERROR] Extension node_modules not found (postinstall may have been skipped)."
	echo "  Run: cd $REPO_ROOT && VSCODE_FORCE_INSTALL=1 npm install"
	exit 1
fi
