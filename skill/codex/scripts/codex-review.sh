#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  codex-review.sh [--uncommitted] [--base <branch>] [--commit <sha>] [--title <title>] [--prompt <text>]
                  [--fast] [--deep] [--reasoning <level>] [--structured]
                  [--worker --scratchpad <dir>]

Defaults:
  If no target is provided, the script uses --uncommitted.

Options:
  --fast                Use lightweight model with low reasoning for quick reviews
  --deep                Use full model with max reasoning for thorough reviews
  --reasoning <level>   Set reasoning effort: minimal, low, medium, high, xhigh
  --structured          Emit machine-readable JSON to stdout: { findings[], summary, model }.
                        Each finding has id, severity, category, file, line, title, detail,
                        recommendation, confidence. Output is always valid JSON (non-JSON model
                        output, timeouts, and failures are wrapped into a fallback envelope).
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
# Source the centralized model-name config (single source of truth for model ids).
# shellcheck source=/dev/null
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/model-config.sh"
CODEX_DEFAULT_TIMEOUT=600

# emit_structured_json <raw-output-file> <model> <worker_status>
# Emits a guaranteed-valid { findings[], summary, model } JSON object to stdout.
# If the model already returned valid JSON matching (or close to) the schema, it
# is passed through (normalized). Otherwise the raw text is wrapped into a single
# fallback finding so callers always get parseable JSON. Requires jq.
emit_structured_json() {
  local raw_file="$1"
  local model="$2"
  local wstatus="${3:-completed}"
  local raw=""
  [[ -s "${raw_file}" ]] && raw="$(cat "${raw_file}")"

  # Strip ```json fences if the model wrapped its JSON.
  local stripped
  stripped="$(printf '%s' "${raw}" | sed -E 's/^[[:space:]]*```[a-zA-Z]*[[:space:]]*//; s/```[[:space:]]*$//')"

  if command -v jq >/dev/null 2>&1 && printf '%s' "${stripped}" | jq -e 'has("findings") and has("summary")' >/dev/null 2>&1; then
    # Valid schema-shaped JSON: normalize and force model=codex.
    printf '%s' "${stripped}" | jq --arg model "${model}" '{findings: (.findings // []), summary: (.summary // ""), model: $model}'
    return 0
  fi

  # Fallback: wrap raw text into the envelope so the contract is never broken.
  local summary="Codex review (non-JSON output wrapped). status=${wstatus}."
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg model "${model}" --arg detail "${raw:-<no output>}" --arg summary "${summary}" \
      '{findings: [{id:"codex-raw", severity:"info", category:"bug", file:null, line:null, title:"Unstructured Codex review output", detail:$detail, recommendation:"Parse heuristically.", confidence:"low"}], summary:$summary, model:$model}'
  else
    # No jq: emit a minimal hand-built envelope (best effort, no embedded raw to avoid quoting bugs).
    printf '{"findings":[],"summary":"%s","model":"%s"}\n' "${summary}" "${model}"
  fi
}

args=(review)
custom_prompt=""
target_set=0
model_override=""
reasoning="${CODEX_SKILL_REASONING:-}"
worker_mode=0
scratchpad_dir=""
structured=0

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
      model_override="${CODEX_MODEL_FAST}"
      reasoning="${CODEX_REASONING_FAST}"
      shift
      ;;
    --deep)
      model_override="${CODEX_MODEL_DEEP}"
      reasoning="${CODEX_REASONING_DEEP}"
      shift
      ;;
    --structured)
      structured=1
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
  args=(-c "model=\"${CODEX_MODEL_DEFAULT}\"" "${args[@]}")
  if [[ -z "${reasoning}" ]]; then
    reasoning="${CODEX_REASONING_DEFAULT}"
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

# --structured: ask the model to emit the cross-model JSON findings schema.
# We prepend the schema instruction to whatever custom_prompt exists so it flows
# through the same developer_instructions / positional-prompt plumbing below.
# The output is additionally wrapped into a guaranteed-valid JSON envelope after
# the run (see the structured post-processing blocks), so a malformed model
# response can never break the { findings[], summary, model } contract.
if [[ "${structured}" -eq 1 ]]; then
  structured_instruction='You MUST respond with valid JSON only, matching this exact schema: {"findings":[{"id":"<short-id>","severity":"high|medium|low|info","category":"bug|security|performance|architecture|style|missing","file":"<file path or null>","line":"<line number or null>","title":"<one-line summary>","detail":"<explanation>","recommendation":"<suggested fix or action>","confidence":"high|medium|low"}],"summary":"<2-3 sentence overview>","model":"codex"}. Do not include any text, markdown fences, or commentary outside the JSON object.'
  if [[ -n "${custom_prompt}" ]]; then
    custom_prompt="${structured_instruction}"$'\n\n'"${custom_prompt}"
  else
    custom_prompt="${structured_instruction}"
  fi
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

  worker_model="${model_override:-${CODEX_SKILL_MODEL:-${CODEX_MODEL_DEFAULT}}}"
  {
    echo "---"
    echo "worker: codex"
    echo "task: review"
    echo "status: ${worker_status}"
    echo "started: ${started_at}"
    echo "completed: ${completed_at}"
    echo "model: ${worker_model}"
    echo "exit_code: ${status}"
    echo "---"
    echo ""
    if [[ "${structured}" -eq 1 ]]; then
      # Always emit a valid JSON envelope, even on timeout/failure.
      emit_structured_json "${tmp_output}" "${worker_model}" "${worker_status}"
    elif [[ -s "${tmp_output}" ]]; then
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
elif [[ "${structured}" -eq 1 ]]; then
  # Structured (non-worker) mode: capture output and emit a valid JSON envelope
  # to stdout. This is the path the /pr skill uses (codex-review.sh --base ... --structured).
  tmp_output="$(mktemp)"
  tmp_stderr="$(mktemp)"
  trap 'rm -f "${tmp_output}" "${tmp_stderr}"' EXIT
  status=0
  if run_with_timeout "${codex_timeout}" codex "${args[@]}" > "${tmp_output}" 2> "${tmp_stderr}"; then
    status=0
  else
    status=$?
  fi
  emit_status="completed"
  if [[ "${status}" -eq 124 ]]; then
    emit_status="timeout"
    echo "[codex-review] timed out after ${codex_timeout}s" >&2
  elif [[ "${status}" -ne 0 ]]; then
    emit_status="failed"
    echo "[codex-review] codex exited with status ${status}" >&2
    tail -n 10 "${tmp_stderr}" >&2 2>/dev/null || true
  fi
  emit_structured_json "${tmp_output}" "${model_override:-${CODEX_SKILL_MODEL:-${CODEX_MODEL_DEFAULT}}}" "${emit_status}"
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
