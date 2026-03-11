#!/usr/bin/env bash

set -euo pipefail

# Cross-model session tracker
# Links conversations across Codex and Gemini under a shared thread ID.
# State is stored in ~/.claude/cross-model-threads/

usage() {
  cat <<'EOF'
Usage:
  cross-model-tracker.sh new    <thread-name>                          Create a new thread
  cross-model-tracker.sh link   <thread-name> <model> <session-ref>    Link a model session to a thread
  cross-model-tracker.sh get    <thread-name>                          Show thread state (JSON)
  cross-model-tracker.sh log    <thread-name> <model> <summary>        Append a turn summary
  cross-model-tracker.sh list                                          List all threads
  cross-model-tracker.sh export <thread-name>                          Export thread context for prompt injection

Models: codex, gemini
EOF
}

state_dir="${HOME}/.claude/cross-model-threads"
mkdir -p "${state_dir}"

cmd="${1:-}"
shift || true

# Sanitize thread names: reject path separators to prevent directory traversal
sanitize_thread_name() {
  local name="$1"
  if [[ "${name}" == *"/"* || "${name}" == *".."* ]]; then
    echo "Error: Thread name cannot contain '/' or '..'. Use hyphens instead (e.g., 'feature-auth')." >&2
    exit 2
  fi
}

case "${cmd}" in
  new)
    thread_name="${1:?Thread name required}"
    sanitize_thread_name "${thread_name}"
    thread_file="${state_dir}/${thread_name}.json"
    if [[ -f "${thread_file}" ]]; then
      echo "Thread '${thread_name}' already exists." >&2
      exit 1
    fi
    python3 -c "
import json, sys, datetime
data = {
    'name': sys.argv[1],
    'created_at': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'sessions': {},
    'turns': []
}
with open(sys.argv[2], 'w') as f:
    json.dump(data, f, indent=2)
" "${thread_name}" "${thread_file}"
    echo "Created thread: ${thread_name}"
    ;;

  link)
    thread_name="${1:?Thread name required}"
    sanitize_thread_name "${thread_name}"
    model="${2:?Model required (codex or gemini)}"
    session_ref="${3:?Session reference required}"
    thread_file="${state_dir}/${thread_name}.json"
    if [[ ! -f "${thread_file}" ]]; then
      echo "Thread '${thread_name}' not found." >&2
      exit 1
    fi

    # Use python for JSON manipulation (available on macOS)
    python3 -c "
import json, sys, os
thread_file = sys.argv[1]
model = sys.argv[2]
session_ref = sys.argv[3]
with open(thread_file, 'r') as f:
    data = json.load(f)
data['sessions'][model] = session_ref
with open(thread_file, 'w') as f:
    json.dump(data, f, indent=2)
" "${thread_file}" "${model}" "${session_ref}"
    echo "Linked ${model} session '${session_ref}' to thread '${thread_name}'"
    ;;

  get)
    thread_name="${1:?Thread name required}"
    sanitize_thread_name "${thread_name}"
    thread_file="${state_dir}/${thread_name}.json"
    if [[ ! -f "${thread_file}" ]]; then
      echo "Thread '${thread_name}' not found." >&2
      exit 1
    fi
    cat "${thread_file}"
    ;;

  log)
    thread_name="${1:?Thread name required}"
    sanitize_thread_name "${thread_name}"
    model="${2:?Model required (codex or gemini)}"
    summary="${3:?Summary required}"
    thread_file="${state_dir}/${thread_name}.json"
    if [[ ! -f "${thread_file}" ]]; then
      echo "Thread '${thread_name}' not found." >&2
      exit 1
    fi

    python3 -c "
import json, sys, datetime
thread_file = sys.argv[1]
model = sys.argv[2]
summary = sys.argv[3]
with open(thread_file, 'r') as f:
    data = json.load(f)
data['turns'].append({
    'model': model,
    'timestamp': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'summary': summary
})
with open(thread_file, 'w') as f:
    json.dump(data, f, indent=2)
" "${thread_file}" "${model}" "${summary}"
    echo "Logged turn for ${model} in thread '${thread_name}'"
    ;;

  list)
    if [[ ! -d "${state_dir}" ]] || ! ls "${state_dir}"/*.json >/dev/null 2>&1; then
      echo "No active threads."
      exit 0
    fi

    for f in "${state_dir}"/*.json; do
      python3 -c "
import json, sys
f = sys.argv[1]
data = json.load(open(f))
name = data['name']
created = data['created_at']
s = data['sessions']
sessions = ', '.join(f'{k}: {v}' for k,v in s.items()) if s else 'none'
turns = len(data['turns'])
print(f'{name}  created={created}  sessions=[{sessions}]  turns={turns}')
" "${f}"
    done
    ;;

  export)
    thread_name="${1:?Thread name required}"
    sanitize_thread_name "${thread_name}"
    thread_file="${state_dir}/${thread_name}.json"
    if [[ ! -f "${thread_file}" ]]; then
      echo "Thread '${thread_name}' not found." >&2
      exit 1
    fi

    # Generate a context summary suitable for injection into a prompt
    python3 -c "
import json, sys
with open(sys.argv[1], 'r') as f:
    data = json.load(f)

print(f'## Cross-Model Thread: {data[\"name\"]}')
print()
if data['sessions']:
    print('### Active Sessions')
    for model, ref in data['sessions'].items():
        print(f'- {model}: {ref}')
    print()
if data['turns']:
    print('### Conversation History')
    for i, turn in enumerate(data['turns'], 1):
        print(f'{i}. [{turn[\"model\"]}] ({turn[\"timestamp\"]}): {turn[\"summary\"]}')
    print()
" "${thread_file}"
    ;;

  *)
    usage
    exit 2
    ;;
esac
