#!/usr/bin/env bash
# Shared project-local Mnemosyne settings. This file is sourced, not executed.
set -euo pipefail

MNEMOSYNE_PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$MNEMOSYNE_PROJECT_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$MNEMOSYNE_PROJECT_ROOT/.env"
  set +a
fi

export MNEMOSYNE_HOME="${MNEMOSYNE_HOME:-$MNEMOSYNE_PROJECT_ROOT/.mnemosyne}"
export MNEMOSYNE_DATA_DIR="${MNEMOSYNE_DATA_DIR:-$MNEMOSYNE_PROJECT_ROOT/.mnemosyne/data}"
export MNEMOSYNE_MCP_BANK="${MNEMOSYNE_MCP_BANK:-default}"
export MNEMOSYNE_DEFAULT_SCOPE="${MNEMOSYNE_DEFAULT_SCOPE:-global}"
export MNEMOSYNE_EMBEDDING_API_URL="${MNEMOSYNE_EMBEDDING_API_URL:-http://localhost:11434/v1}"
export MNEMOSYNE_EMBEDDING_MODEL="${MNEMOSYNE_EMBEDDING_MODEL:-nomic-embed-text}"
export MNEMOSYNE_EMBEDDING_DIM="${MNEMOSYNE_EMBEDDING_DIM:-768}"
export MNEMOSYNE_LLM_ENABLED="${MNEMOSYNE_LLM_ENABLED:-false}"
export MNEMOSYNE_JOURNAL_MODE="${MNEMOSYNE_JOURNAL_MODE:-wal}"
export MNEMOSYNE_PACKAGE="${MNEMOSYNE_PACKAGE:-mnemosyne-memory[mcp]==3.15.1}"

mkdir -p "$MNEMOSYNE_DATA_DIR"

# Local Ollama needs no credential. More importantly, Mnemosyne deliberately
# refuses to send an Authorization header over plain HTTP.
unset OPENAI_API_KEY OPENROUTER_API_KEY MNEMOSYNE_EMBEDDING_API_KEY
