#!/usr/bin/env bash
set -euo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/mnemosyne-env.sh"
exec uvx --from "$MNEMOSYNE_PACKAGE" --with numpy mnemosyne mcp --bank "$MNEMOSYNE_MCP_BANK"
