# Codex CLI wrappers

This skill uses local wrapper scripts instead of the MCP server in this repository.

## Ask wrapper

Path:

```bash
${CLAUDE_SKILL_DIR}/scripts/codex-ask.sh
```

Behavior:

- Runs `codex exec --full-auto --skip-git-repo-check --color never "<prompt>"`
- Accepts the prompt either as arguments or from stdin

Optional environment variables:

- `CODEX_SKILL_MODEL`
- `CODEX_SKILL_SANDBOX`
- `CODEX_SKILL_APPROVAL`
- `CODEX_SKILL_SEARCH=1`

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
