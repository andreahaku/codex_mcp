#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  codex-review.sh [--uncommitted] [--base <branch>] [--commit <sha>] [--title <title>] [--prompt <text>]
                  [--fast] [--deep] [--reasoning <level>]
                  [--worker --scratchpad <dir>]

Defaults:
  If no target is provided, the script uses --uncommitted.

Options:
  --fast                Use lightweight model (gpt-5.4-mini) with low reasoning for quick reviews
  --deep                Use full model (gpt-5.5) with max reasoning for thorough reviews
  --reasoning <level>   Set reasoning effort: minimal, low, medium, high, xhigh
  --worker              Worker mode: capture output and write to scratchpad (for /coordinate)
  --scratchpad <dir>    Scratchpad directory for worker mode output (required with --worker)

Environment:
  CODEX_SKILL_MODEL      Optional model override (default: gpt-5.5 with xhigh reasoning)
  CODEX_SKILL_SANDBOX    Optional sandbox mode override
  CODEX_SKILL_APPROVAL   Optional approval policy override
  CODEX_SKILL_REASONING  Default reasoning effort
  CODEX_SKILL_TIMEOUT    Timeout in seconds for the codex invocation (default: 600)
EOF
}

if ! command -v codex >/dev/null 2>&1; then
  echo "Codex CLI not found. Install it first and make sure \`codex\` is on PATH." >&2
  exit 1
fi

# Source the shared timeout helper (closes stdin, kills hung processes).
# shellcheck source=/dev/null
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/run-with-timeout.sh"
CODEX_DEFAULT_TIMEOUT=600

args=(review)
custom_prompt=""
target_set=0
model_override=""
reasoning="${CODEX_SKILL_REASONING:-}"
worker_mode=0
scratchpad_dir=""

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
      model_override="gpt-5.4-mini"
      reasoning="low"
      shift
      ;;
    --deep)
      model_override="gpt-5.5"
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
    --worker)
      worker_mode=1
      shift
      ;;
    --scratchpad)
      if [[ $# -lt 2 ]]; then
        echo "--scratchpad requires a directory path" >&2
        exit 2
      fi
      scratchpad_dir="$2"
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

if [[ "${worker_mode}" -eq 1 && -z "${scratchpad_dir}" ]]; then
  echo "--worker requires --scratchpad <dir>" >&2
  exit 2
fi

# Model: CLI flag > env var > skill default (gpt-5.5 with xhigh reasoning)
if [[ -n "${model_override}" ]]; then
  args=(-c "model=\"${model_override}\"" "${args[@]}")
elif [[ -n "${CODEX_SKILL_MODEL:-}" ]]; then
  args=(-c "model=\"${CODEX_SKILL_MODEL}\"" "${args[@]}")
else
  args=(-c "model=\"gpt-5.5\"" "${args[@]}")
  if [[ -z "${reasoning}" ]]; then
    reasoning="xhigh"
  fi
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
    escaped_prompt="${escaped_prompt//$'\r'/}"
    escaped_prompt="${escaped_prompt//$'\n'/\\n}"
    args=(-c "developer_instructions=\"${escaped_prompt}\"" "${args[@]}")
  else
    args+=("${custom_prompt}")
  fi
fi

codex_timeout="${CODEX_SKILL_TIMEOUT:-$CODEX_DEFAULT_TIMEOUT}"

if [[ "${worker_mode}" -eq 1 ]]; then
  # Worker mode: capture output and always write to scratchpad (even on failure or timeout).
  mkdir -p "${scratchpad_dir}/workers"
  tmp_output="$(mktemp)"
  tmp_stderr="$(mktemp)"
  trap 'rm -f "${tmp_output}" "${tmp_stderr}"' EXIT

  started_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  status=0
  if run_with_timeout "${codex_timeout}" codex "${args[@]}" > "${tmp_output}" 2> "${tmp_stderr}"; then
    status=0
  else
    status=$?
  fi
  completed_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  worker_status="completed"
  if [[ "${status}" -ne 0 ]]; then
    if [[ "${status}" -eq 124 ]]; then
      worker_status="timeout"
    else
      worker_status="failed"
    fi
  fi

  {
    echo "---"
    echo "worker: codex"
    echo "task: review"
    echo "status: ${worker_status}"
    echo "started: ${started_at}"
    echo "completed: ${completed_at}"
    echo "model: ${model_override:-${CODEX_SKILL_MODEL:-gpt-5.5}}"
    echo "exit_code: ${status}"
    echo "---"
    echo ""
    if [[ -s "${tmp_output}" ]]; then
      cat "${tmp_output}"
    elif [[ "${worker_status}" == "timeout" ]]; then
      echo "Codex review timed out after ${codex_timeout}s."
      tail -n 5 "${tmp_stderr}" 2>/dev/null || true
    elif [[ "${status}" -ne 0 ]]; then
      echo "Codex review failed with exit code ${status}."
      tail -n 10 "${tmp_stderr}" 2>/dev/null || true
    fi
  } > "${scratchpad_dir}/workers/codex.md"

  echo "[codex-review-worker] Output written to ${scratchpad_dir}/workers/codex.md (status=${worker_status})" >&2
  exit "${status}"
else
  # Interactive mode: stream output directly. stdin closed by run_with_timeout.
  run_with_timeout "${codex_timeout}" codex "${args[@]}"
  status=$?
  if [[ "${status}" -eq 124 ]]; then
    echo "[codex-review] timed out after ${codex_timeout}s" >&2
  fi
  exit "${status}"
fi
