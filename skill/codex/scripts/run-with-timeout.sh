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

  # NIENTE --preserve-status: era la causa del bug diagnosticato il 22/7/2026.
  # Con quel flag GNU timeout restituisce lo stato del processo ucciso, e un CLI
  # che gestisce SIGTERM uscendo in modo pulito torna **0** — non 143, non 137.
  # codex fa esattamente questo (riprodotto: run uccisa a 12s -> status 0, message
  # file mai creato). Le normalizzazioni 143/137 -> 124 qui sotto non scattavano
  # mai, il chiamante leggeva "successo con output vuoto" e finiva per attribuire
  # il fallimento al primo evento error del log (il warning benigno delle skill).
  # Senza il flag, timeout restituisce **sempre 124** quando e' lui a uccidere:
  # e' il contratto dichiarato nell'header. Gli exit status normali passano intatti.
  # Le due righe 143/137 restano come rete per i segnali che arrivano da fuori.
  local rc
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout --kill-after=2 "${secs}" "$@" <"${stdin_src}"
    rc=$?
    if [[ "${rc}" -eq 143 || "${rc}" -eq 137 ]]; then
      return 124
    fi
    return "${rc}"
  fi
  if command -v timeout >/dev/null 2>&1; then
    timeout --kill-after=2 "${secs}" "$@" <"${stdin_src}"
    rc=$?
    if [[ "${rc}" -eq 143 || "${rc}" -eq 137 ]]; then
      return 124
    fi
    return "${rc}"
  fi

  # Pure bash watchdog fallback with recursive process-tree kill.
  # Il watchdog lascia una sentinella su disco PRIMA di uccidere: e' l'unico modo
  # affidabile di sapere che il timeout e' scattato, perche' un comando che
  # gestisce SIGTERM puo' uscire con qualsiasi status — codex esce con 0 — e in
  # quel caso l'exit status non dice nulla (stesso bug del ramo GNU timeout).
  local fired_flag
  fired_flag="$(mktemp -t rwt-fired.XXXXXX)"
  rm -f "${fired_flag}"

  "$@" <"${stdin_src}" &
  local cmd_pid=$!
  (
    sleep "${secs}"
    if kill -0 "${cmd_pid}" 2>/dev/null; then
      : > "${fired_flag}"
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
  if [[ -e "${fired_flag}" ]]; then
    rm -f "${fired_flag}"
    return 124
  fi
  rm -f "${fired_flag}"
  if [[ "${rc}" -eq 143 || "${rc}" -eq 137 ]]; then
    return 124
  fi
  return "${rc}"
}
