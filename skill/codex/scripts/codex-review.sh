#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  codex-review.sh [--uncommitted] [--base <branch>] [--commit <sha>] [--title <title>] [--prompt <text>]

Defaults:
  If no target is provided, the script uses --uncommitted.

Environment:
  CODEX_SKILL_MODEL      Optional model override
  CODEX_SKILL_SANDBOX    Optional sandbox mode override
  CODEX_SKILL_APPROVAL   Optional approval policy override
EOF
}

if ! command -v codex >/dev/null 2>&1; then
  echo "Codex CLI not found. Install it first and make sure \`codex\` is on PATH." >&2
  exit 1
fi

args=(review)
custom_prompt=""
target_set=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --uncommitted)
      args+=(--uncommitted)
      target_set=1
      shift
      ;;
    --base)
      if [[ $# -lt 2 ]]; then
        echo "--base requires a branch name" >&2
        exit 2
      fi
      args+=(--base "$2")
      target_set=1
      shift 2
      ;;
    --commit)
      if [[ $# -lt 2 ]]; then
        echo "--commit requires a commit SHA" >&2
        exit 2
      fi
      args+=(--commit "$2")
      target_set=1
      shift 2
      ;;
    --title)
      if [[ $# -lt 2 ]]; then
        echo "--title requires a value" >&2
        exit 2
      fi
      args+=(--title "$2")
      shift 2
      ;;
    --prompt)
      if [[ $# -lt 2 ]]; then
        echo "--prompt requires a value" >&2
        exit 2
      fi
      custom_prompt="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -n "${custom_prompt}" ]]; then
        custom_prompt+=" "
      fi
      custom_prompt+="$1"
      shift
      ;;
  esac
done

if [[ "${target_set}" -eq 0 ]]; then
  args+=(--uncommitted)
fi

if [[ -n "${CODEX_SKILL_MODEL:-}" ]]; then
  args=(-c "model=\"${CODEX_SKILL_MODEL}\"" "${args[@]}")
fi

if [[ -n "${CODEX_SKILL_SANDBOX:-}" ]]; then
  args=(-c "sandbox_mode=\"${CODEX_SKILL_SANDBOX}\"" "${args[@]}")
fi

if [[ -n "${CODEX_SKILL_APPROVAL:-}" ]]; then
  args=(-c "approval_policy=\"${CODEX_SKILL_APPROVAL}\"" "${args[@]}")
fi

if [[ -n "${custom_prompt}" ]]; then
  args+=("${custom_prompt}")
fi

exec codex "${args[@]}"
