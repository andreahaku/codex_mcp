#!/usr/bin/env bash

set -euo pipefail

if ! command -v codex >/dev/null 2>&1; then
  echo "Codex CLI not found. Install it first and make sure \`codex\` is on PATH." >&2
  exit 1
fi

prompt="${*:-}"

if [[ -z "${prompt}" ]]; then
  if [[ -t 0 ]]; then
    echo "Usage: codex-ask.sh <prompt>" >&2
    echo "You can also pipe a prompt on stdin." >&2
    exit 2
  fi
  prompt="$(cat)"
fi

if [[ -z "${prompt//[[:space:]]/}" ]]; then
  echo "Usage: codex-ask.sh <prompt>" >&2
  echo "Provide a prompt as an argument or on stdin." >&2
  exit 2
fi

args=(
  exec
  --full-auto
  --skip-git-repo-check
  --color
  never
)

if [[ -n "${CODEX_SKILL_MODEL:-}" ]]; then
  args+=(--model "${CODEX_SKILL_MODEL}")
fi

if [[ -n "${CODEX_SKILL_SANDBOX:-}" ]]; then
  args+=(--sandbox "${CODEX_SKILL_SANDBOX}")
fi

if [[ -n "${CODEX_SKILL_APPROVAL:-}" ]]; then
  args+=(--ask-for-approval "${CODEX_SKILL_APPROVAL}")
fi

if [[ "${CODEX_SKILL_SEARCH:-0}" == "1" ]]; then
  args+=(--search)
fi

exec codex "${args[@]}" "${prompt}"
