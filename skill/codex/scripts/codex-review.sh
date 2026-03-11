#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  codex-review.sh [--uncommitted] [--base <branch>] [--commit <sha>] [--title <title>] [--prompt <text>]
                  [--fast] [--deep] [--reasoning <level>]

Defaults:
  If no target is provided, the script uses --uncommitted.

Options:
  --fast                Use lightweight model (gpt-4o-mini) with low reasoning for quick reviews
  --deep                Use full model (gpt-5.4) with max reasoning for thorough reviews
  --reasoning <level>   Set reasoning effort: minimal, low, medium, high, xhigh

Environment:
  CODEX_SKILL_MODEL      Optional model override (default: gpt-5.4)
  CODEX_SKILL_SANDBOX    Optional sandbox mode override
  CODEX_SKILL_APPROVAL   Optional approval policy override
  CODEX_SKILL_REASONING  Default reasoning effort
EOF
}

if ! command -v codex >/dev/null 2>&1; then
  echo "Codex CLI not found. Install it first and make sure \`codex\` is on PATH." >&2
  exit 1
fi

args=(review)
custom_prompt=""
target_set=0
model_override=""
reasoning="${CODEX_SKILL_REASONING:-}"

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
    --fast)
      model_override="gpt-4o-mini"
      reasoning="low"
      shift
      ;;
    --deep)
      model_override="gpt-5.4"
      reasoning="xhigh"
      shift
      ;;
    --reasoning)
      if [[ $# -lt 2 ]]; then
        echo "--reasoning requires a value (minimal, low, medium, high, xhigh)" >&2
        exit 2
      fi
      reasoning="$2"
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

# Model: CLI flag > env var > codex default
if [[ -n "${model_override}" ]]; then
  args=(-c "model=\"${model_override}\"" "${args[@]}")
elif [[ -n "${CODEX_SKILL_MODEL:-}" ]]; then
  args=(-c "model=\"${CODEX_SKILL_MODEL}\"" "${args[@]}")
fi

if [[ -n "${CODEX_SKILL_SANDBOX:-}" ]]; then
  args=(-c "sandbox_mode=\"${CODEX_SKILL_SANDBOX}\"" "${args[@]}")
fi

if [[ -n "${CODEX_SKILL_APPROVAL:-}" ]]; then
  args=(-c "approval_policy=\"${CODEX_SKILL_APPROVAL}\"" "${args[@]}")
fi

if [[ -n "${reasoning}" ]]; then
  args=(-c "model_reasoning_effort=\"${reasoning}\"" "${args[@]}")
fi

if [[ -n "${custom_prompt}" ]]; then
  if [[ "${target_set}" -eq 1 ]]; then
    # codex review doesn't allow positional PROMPT with --base or --commit,
    # so pass custom instructions via developer_instructions config
    escaped_prompt="${custom_prompt//\\/\\\\}"
    escaped_prompt="${escaped_prompt//\"/\\\"}"
    args=(-c "developer_instructions=\"${escaped_prompt}\"" "${args[@]}")
  else
    args+=("${custom_prompt}")
  fi
fi

exec codex "${args[@]}"
