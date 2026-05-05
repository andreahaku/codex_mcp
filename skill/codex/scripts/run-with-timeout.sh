#!/usr/bin/env bash
# run-with-timeout.sh — portable timeout wrapper.
# Source this file, then call:
#   run_with_timeout <secs> <cmd...>
#   run_with_timeout <secs> --stdin <file> <cmd...>
#
# Behavior:
#   1. If gtimeout (GNU coreutils) is available, use it.
#   2. Else if timeout is available, use it.
#   3. Else fall back to a bash watchdog that kills the entire descendant tree
#      (SIGTERM at deadline, SIGKILL 2s later). This is critical when called
#      via `$(run_with_timeout ...)`: the command substitution waits for the
#      stdout pipe to close, which means orphaned grandchildren must also die.
#
# Stdin handling:
#   - Default: stdin is /dev/null. Critical for non-interactive CLIs that
#     would otherwise block waiting on inherited stdin.
#   - With --stdin <file>: the given file is fed to the command's stdin.
#     Use this to pass large prompts/diffs that exceed ARG_MAX.
#
# Returns:
#   - The command's own exit status on normal completion.
#   - 124 if the command was killed by the timeout (matches GNU timeout convention).
#
# Notes:
#   - Does NOT alter stdout/stderr — redirect them at the call site if needed.

# Recursively kill a process and all its descendants.
# Usage: _rwt_kill_tree <signal> <pid>
_rwt_kill_tree() {
  local sig="$1"
  local pid="$2"
  [[ -z "${pid}" ]] && return 0
  # Depth-first: kill descendants first, then the root.
  local child
  for child in $(pgrep -P "${pid}" 2>/dev/null); do
    _rwt_kill_tree "${sig}" "${child}"
  done
  kill "-${sig}" "${pid}" 2>/dev/null || true
}

run_with_timeout() {
  local secs="$1"
  shift

  local stdin_src="/dev/null"
  if [[ "${1:-}" == "--stdin" ]]; then
    stdin_src="$2"
    if [[ ! -r "${stdin_src}" ]]; then
      echo "run_with_timeout: --stdin file not readable: ${stdin_src}" >&2
      return 2
    fi
    shift 2
  fi

  if [[ -z "${secs}" || "${secs}" -le 0 ]]; then
    "$@" <"${stdin_src}"
    return $?
  fi

  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout --preserve-status --kill-after=2 "${secs}" "$@" <"${stdin_src}"
    return $?
  fi
  if command -v timeout >/dev/null 2>&1; then
    timeout --preserve-status --kill-after=2 "${secs}" "$@" <"${stdin_src}"
    return $?
  fi

  # Pure bash watchdog fallback with recursive process-tree kill.
  "$@" <"${stdin_src}" &
  local cmd_pid=$!
  (
    sleep "${secs}"
    if kill -0 "${cmd_pid}" 2>/dev/null; then
      _rwt_kill_tree TERM "${cmd_pid}"
      sleep 2
      _rwt_kill_tree KILL "${cmd_pid}" 2>/dev/null
    fi
  ) &
  local watcher_pid=$!
  local rc
  if wait "${cmd_pid}" 2>/dev/null; then
    rc=0
  else
    rc=$?
  fi
  # Cancel the watcher if the command finished on its own.
  if kill -0 "${watcher_pid}" 2>/dev/null; then
    _rwt_kill_tree KILL "${watcher_pid}" 2>/dev/null
    wait "${watcher_pid}" 2>/dev/null || true
  fi
  if [[ "${rc}" -eq 143 || "${rc}" -eq 137 ]]; then
    return 124
  fi
  return "${rc}"
}
