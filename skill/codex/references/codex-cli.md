# Codex CLI wrappers

This skill uses local wrapper scripts instead of the MCP server in this repository.

## Ask wrapper

Path:

```bash
${CLAUDE_SKILL_DIR}/scripts/codex-ask.sh
```

Behavior:

- Defaults to a new persistent multi-turn Codex session
- Supports four modes:
  - `--new` starts a new persistent session
  - `--last` resumes the last saved session for the current workspace
  - `--session <id|alias>` resumes a specific session id or saved alias
  - `--one-shot` runs an isolated ephemeral prompt
- Accepts the prompt either as arguments, with `--prompt`, or from stdin
- Emits a `[codex-session]` preamble with workspace and session metadata before the final Codex response
- Stores per-workspace aliases and last-session pointers in a local state directory

Optional environment variables:

- `CODEX_SKILL_MODEL`
- `CODEX_SKILL_SANDBOX`
- `CODEX_SKILL_APPROVAL`
- `CODEX_SKILL_SEARCH=1`
- `CODEX_SKILL_STATE_DIR`

Examples:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/codex-ask.sh" --new --name api-design "Review this service boundary and suggest improvements."
bash "${CLAUDE_SKILL_DIR}/scripts/codex-ask.sh" --last "Push further on the migration strategy."
bash "${CLAUDE_SKILL_DIR}/scripts/codex-ask.sh" --session api-design "Now propose a rollout plan."
bash "${CLAUDE_SKILL_DIR}/scripts/codex-ask.sh" --one-shot "Summarize the tradeoffs of feature flags vs branch-by-abstraction."
```

## Review wrapper

Path:

```bash
${CLAUDE_SKILL_DIR}/scripts/codex-review.sh
```

Supported options:

- `--uncommitted`
- `--base <branch>`
- `--commit <sha>`
- `--title <title>`
- `--prompt <text>`

Behavior:

- Runs `codex review`
- Defaults to `--uncommitted` when no explicit target is provided
- Appends the optional prompt as Codex review instructions
