#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  codex-ask.sh [--new | --last | --session <id|alias> | --one-shot] [--name <alias>] [--prompt <text>]
  codex-ask.sh [--new | --last | --session <id|alias> | --one-shot] [--name <alias>] <prompt>
  codex-ask.sh --list-sessions

Defaults:
  If no mode is provided, the script starts a new persistent multi-turn session.

Modes:
  --new                 Start a new persistent session
  --last                Resume the last session saved for the current workspace
  --session <id|alias>  Resume a specific session id or a saved alias
  --one-shot            Run an isolated ephemeral prompt with no persisted session

Options:
  --name <alias>        Save or update a friendly alias for the resolved session
  --prompt <text>       Prompt text (alternative to positional arguments or stdin)
  --list-sessions       Show the saved aliases and last session for the current workspace
  --fast                Use lightweight model (gpt-5.1-codex-mini) with low reasoning for quick tasks
  --deep                Use full model (gpt-5.4) with max reasoning for complex analysis
  --reasoning <level>   Set reasoning effort: minimal, low, medium, high, xhigh
  --structured          Request JSON-structured output for cross-model chaining

Environment:
  CODEX_SKILL_MODEL       Optional model override (default: gpt-5.4)
  CODEX_SKILL_SANDBOX     Optional sandbox mode override
  CODEX_SKILL_APPROVAL    Optional approval policy override
  CODEX_SKILL_SEARCH=1    Enable web search for Codex
  CODEX_SKILL_STATE_DIR   Override the session state directory
  CODEX_SKILL_REASONING   Default reasoning effort
EOF
}

if ! command -v codex >/dev/null 2>&1; then
  echo "Codex CLI not found. Install it first and make sure \`codex\` is on PATH." >&2
  exit 1
fi

workspace_root() {
  local root
  if root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
    printf '%s\n' "${root}"
    return
  fi

  pwd -P
}

workspace_path="$(workspace_root)"
state_root_default="${CODEX_HOME:-$HOME/.codex}/memories/codex-skill"
state_dir="${CODEX_SKILL_STATE_DIR:-$state_root_default}"
mkdir -p "${state_dir}"

# Use shasum (macOS) or sha256sum (Linux) for hashing
if command -v shasum >/dev/null 2>&1; then
  workspace_key="$(printf '%s' "${workspace_path}" | shasum -a 256 | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  workspace_key="$(printf '%s' "${workspace_path}" | sha256sum | awk '{print $1}')"
else
  # Fallback: use a simple hash via python3
  workspace_key="$(printf '%s' "${workspace_path}" | python3 -c "import sys,hashlib;print(hashlib.sha256(sys.stdin.read().encode()).hexdigest())")"
fi
last_file="${state_dir}/${workspace_key}.last"
aliases_file="${state_dir}/${workspace_key}.aliases"

mode="new"
mode_set=0
prompt=""
session_ref=""
alias_name=""
list_sessions=0
reasoning="${CODEX_SKILL_REASONING:-}"
model_override=""
structured=0

set_mode() {
  local next_mode="$1"
  if [[ "${mode_set}" -eq 1 && "${mode}" != "${next_mode}" ]]; then
    echo "Choose only one of --new, --last, --session, or --one-shot." >&2
    exit 2
  fi

  mode="${next_mode}"
  mode_set=1
}

append_prompt_part() {
  local part="$1"
  if [[ -n "${prompt}" ]]; then
    prompt+=" "
  fi
  prompt+="${part}"
}

save_last_session() {
  local session_id="$1"
  printf '%s\n' "${session_id}" > "${last_file}"
}

save_alias() {
  local alias="$1"
  local session_id="$2"
  local tmp_file

  tmp_file="$(mktemp "${state_dir}/aliases.XXXXXX")"
  if [[ -f "${aliases_file}" ]]; then
    awk -F '\t' -v alias_name="${alias}" '$1 != alias_name { print $0 }' "${aliases_file}" > "${tmp_file}"
  fi
  printf '%s\t%s\t%s\n' "${alias}" "${session_id}" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "${tmp_file}"
  mv "${tmp_file}" "${aliases_file}"
}

resolve_alias() {
  local ref="$1"
  if [[ ! -f "${aliases_file}" ]]; then
    return 1
  fi

  awk -F '\t' -v alias_name="${ref}" '$1 == alias_name { session = $2 } END { if (session != "") print session }' "${aliases_file}"
}

read_last_session() {
  if [[ ! -f "${last_file}" ]]; then
    return 1
  fi

  tr -d '\n' < "${last_file}"
}

print_saved_sessions() {
  echo "workspace: ${workspace_path}"

  if session_id="$(read_last_session 2>/dev/null || true)" && [[ -n "${session_id}" ]]; then
    echo "last: ${session_id}"
  else
    echo "last: <none>"
  fi

  if [[ ! -f "${aliases_file}" ]]; then
    echo "aliases: <none>"
    return
  fi

  echo "aliases:"
  awk -F '\t' '{ printf "  %s -> %s (%s)\n", $1, $2, $3 }' "${aliases_file}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --new)
      set_mode "new"
      shift
      ;;
    --last)
      set_mode "last"
      shift
      ;;
    --session)
      if [[ $# -lt 2 ]]; then
        echo "--session requires a session id or alias" >&2
        exit 2
      fi
      set_mode "session"
      session_ref="$2"
      shift 2
      ;;
    --one-shot)
      set_mode "one-shot"
      shift
      ;;
    --name)
      if [[ $# -lt 2 ]]; then
        echo "--name requires an alias" >&2
        exit 2
      fi
      alias_name="$2"
      shift 2
      ;;
    --prompt)
      if [[ $# -lt 2 ]]; then
        echo "--prompt requires a value" >&2
        exit 2
      fi
      append_prompt_part "$2"
      shift 2
      ;;
    --list-sessions)
      list_sessions=1
      shift
      ;;
    --fast)
      model_override="gpt-5.1-codex-mini"
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
    --structured)
      structured=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      append_prompt_part "$1"
      shift
      ;;
  esac
done

if [[ "${list_sessions}" -eq 1 ]]; then
  print_saved_sessions
  exit 0
fi

if [[ -z "${prompt}" ]]; then
  if [[ -t 0 ]]; then
    usage >&2
    exit 2
  fi
  prompt="$(cat)"
fi

if [[ -z "${prompt//[[:space:]]/}" ]]; then
  echo "Provide a prompt as an argument, with --prompt, or on stdin." >&2
  exit 2
fi

if [[ "${mode}" == "one-shot" && -n "${alias_name}" ]]; then
  echo "--name is not supported with --one-shot because one-shot mode is ephemeral." >&2
  exit 2
fi

# Wrap prompt for structured output if requested
if [[ "${structured}" -eq 1 ]]; then
  prompt="You MUST respond with valid JSON only. Use this exact schema:
{
  \"findings\": [
    {
      \"id\": \"<short-id>\",
      \"severity\": \"high|medium|low|info\",
      \"category\": \"bug|security|performance|architecture|style|missing\",
      \"file\": \"<file path or null>\",
      \"line\": <line number or null>,
      \"title\": \"<one-line summary>\",
      \"detail\": \"<explanation>\",
      \"recommendation\": \"<suggested fix or action>\",
      \"confidence\": \"high|medium|low\"
    }
  ],
  \"summary\": \"<2-3 sentence overview>\",
  \"model\": \"codex\"
}

Do not include any text outside the JSON block.

Task:
${prompt}"
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/codex-skill.XXXXXX")"
events_file="${tmp_dir}/events.jsonl"
stderr_file="${tmp_dir}/stderr.log"
message_file="${tmp_dir}/message.txt"
trap 'rm -rf "${tmp_dir}"' EXIT

cmd=(
  codex
  -c 'sandbox_mode="workspace-write"'
  -c 'approval_policy="on-request"'
)

# Model: CLI flag > env var > default (codex default is gpt-5.4)
if [[ -n "${model_override}" ]]; then
  cmd+=(-c "model=\"${model_override}\"")
elif [[ -n "${CODEX_SKILL_MODEL:-}" ]]; then
  cmd+=(-c "model=\"${CODEX_SKILL_MODEL}\"")
fi

if [[ -n "${CODEX_SKILL_SANDBOX:-}" ]]; then
  cmd+=(-c "sandbox_mode=\"${CODEX_SKILL_SANDBOX}\"")
fi

if [[ -n "${CODEX_SKILL_APPROVAL:-}" ]]; then
  cmd+=(-c "approval_policy=\"${CODEX_SKILL_APPROVAL}\"")
fi

if [[ -n "${reasoning}" ]]; then
  cmd+=(-c "model_reasoning_effort=\"${reasoning}\"")
fi

if [[ "${CODEX_SKILL_SEARCH:-0}" == "1" ]]; then
  cmd+=(--search)
fi

resolved_session_id=""

case "${mode}" in
  new)
    cmd+=(
      exec
      --json
      --skip-git-repo-check
      -o "${message_file}"
      "${prompt}"
    )
    ;;
  last)
    if resolved_session_id="$(read_last_session 2>/dev/null || true)" && [[ -n "${resolved_session_id}" ]]; then
      cmd+=(
        exec resume
        --json
        --skip-git-repo-check
        -o "${message_file}"
        "${resolved_session_id}"
        "${prompt}"
      )
    else
      cmd+=(
        exec resume
        --json
        --skip-git-repo-check
        -o "${message_file}"
        --last
        "${prompt}"
      )
    fi
    ;;
  session)
    if [[ -z "${session_ref}" ]]; then
      echo "--session requires a session id or alias" >&2
      exit 2
    fi

    if resolved_session_id="$(resolve_alias "${session_ref}" 2>/dev/null || true)" && [[ -n "${resolved_session_id}" ]]; then
      :
    else
      resolved_session_id="${session_ref}"
    fi

    cmd+=(
      exec resume
      --json
      --skip-git-repo-check
      -o "${message_file}"
      "${resolved_session_id}"
      "${prompt}"
    )
    ;;
  one-shot)
    cmd+=(
      exec
      --json
      --skip-git-repo-check
      --ephemeral
      -o "${message_file}"
      "${prompt}"
    )
    ;;
  *)
    echo "Unsupported mode: ${mode}" >&2
    exit 2
    ;;
esac

status=0
if "${cmd[@]}" > "${events_file}" 2> "${stderr_file}"; then
  status=0
else
  status=$?
fi

started_session_id="$(grep -m1 '"type":"thread.started"' "${events_file}" | sed -E 's/.*"thread_id":"([^"]+)".*/\1/' || true)"

final_session_id=""
case "${mode}" in
  new)
    final_session_id="${started_session_id}"
    ;;
  last|session)
    if [[ -n "${resolved_session_id}" ]]; then
      final_session_id="${resolved_session_id}"
    else
      final_session_id="${started_session_id}"
    fi
    ;;
  one-shot)
    final_session_id="${started_session_id}"
    ;;
esac

if [[ "${mode}" != "one-shot" && -n "${final_session_id}" ]]; then
  save_last_session "${final_session_id}"
  if [[ -n "${alias_name}" ]]; then
    save_alias "${alias_name}" "${final_session_id}"
  fi
fi

# In structured mode, send session preamble to stderr to keep stdout as clean JSON
preamble_fd=1
if [[ "${structured}" -eq 1 ]]; then
  preamble_fd=2
fi

echo "[codex-session] mode=${mode}" >&"${preamble_fd}"
echo "[codex-session] workspace=${workspace_path}" >&"${preamble_fd}"
if [[ -n "${final_session_id}" ]]; then
  echo "[codex-session] session_id=${final_session_id}" >&"${preamble_fd}"
fi
if [[ -n "${alias_name}" ]]; then
  echo "[codex-session] alias=${alias_name}" >&"${preamble_fd}"
fi
if [[ -n "${reasoning}" ]]; then
  echo "[codex-session] reasoning=${reasoning}" >&"${preamble_fd}"
fi
echo >&"${preamble_fd}"

if [[ -s "${message_file}" ]]; then
  cat "${message_file}"
fi

if [[ "${status}" -ne 0 ]]; then
  error_message="$(grep '"type":"turn.failed"' "${events_file}" | tail -n1 | sed -E 's/.*"message":"([^"]+)".*/\1/' || true)"
  if [[ -z "${error_message}" ]]; then
    error_message="$(grep '"type":"error"' "${events_file}" | tail -n1 | sed -E 's/.*"message":"([^"]+)".*/\1/' || true)"
  fi

  if [[ -n "${error_message}" ]]; then
    echo
    echo "[codex-session] error=${error_message}" >&2
  fi

  if [[ -s "${stderr_file}" ]]; then
    echo "[codex-session] stderr tail:" >&2
    tail -n 20 "${stderr_file}" >&2
  fi

  exit "${status}"
fi
