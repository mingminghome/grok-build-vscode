#!/usr/bin/env bash
# Uninstall the Grok VS Code extension on macOS / Linux / WSL.
# Usage:  ./scripts/uninstall.sh

set -euo pipefail

find_code_cli() {
    for name in antigravity-ide antigravity code code-insiders; do
        if command -v "$name" >/dev/null 2>&1; then
            echo "$name"; return 0
        fi
    done
    for path in \
        "/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide" \
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
        "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders" \
    ; do
        [ -x "$path" ] && { echo "$path"; return 0; }
    done
    echo "Could not find VS Code / Antigravity CLI." >&2
    return 1
}

code=$(find_code_cli)
echo "Uninstalling PawelHuryn.grok-vscode-phuryn via $code"
"$code" --uninstall-extension PawelHuryn.grok-vscode-phuryn
echo
echo "Done. Reload VS Code / Antigravity to drop the sidebar."
