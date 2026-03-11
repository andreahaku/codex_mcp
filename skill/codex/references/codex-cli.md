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

Depth and reasoning flags:

- `--fast` uses `gpt-5.1-codex-mini` with `low` reasoning — fast, lightweight
- `--deep` uses `gpt-5.4` with `xhigh` reasoning — max analysis depth
- `--reasoning <level>` sets explicit reasoning effort (`minimal`, `low`, `medium`, `high`, `xhigh`)
- `--structured` wraps the prompt to request JSON-structured output

Optional environment variables:

- `CODEX_SKILL_MODEL` — model override
- `CODEX_SKILL_SANDBOX` — sandbox mode override
- `CODEX_SKILL_APPROVAL` — approval policy override
- `CODEX_SKILL_SEARCH=1` — enable web search
- `CODEX_SKILL_STATE_DIR` — session state directory override
- `CODEX_SKILL_REASONING` — default reasoning effort

Examples:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/codex-ask.sh" --new --name api-design "Review this service boundary and suggest improvements."
bash "${CLAUDE_SKILL_DIR}/scripts/codex-ask.sh" --last "Push further on the migration strategy."
bash "${CLAUDE_SKILL_DIR}/scripts/codex-ask.sh" --session api-design "Now propose a rollout plan."
bash "${CLAUDE_SKILL_DIR}/scripts/codex-ask.sh" --one-shot --fast "Summarize this regex pattern."
bash "${CLAUDE_SKILL_DIR}/scripts/codex-ask.sh" --one-shot --deep --structured "Analyze this module for race conditions."
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
- `--fast` — lightweight model with low reasoning
- `--deep` — full model with max reasoning
- `--reasoning <level>` — explicit reasoning effort

Behavior:

- Runs `codex review`
- Defaults to `--uncommitted` when no explicit target is provided
- When `--base` or `--commit` is set, custom prompts are routed through `-c developer_instructions="..."` (because Codex CLI does not allow positional `[PROMPT]` with those flags)
- Escapes backslashes, double quotes, carriage returns, and newlines in the prompt to prevent TOML config breakage
- Otherwise appends the optional prompt as a positional argument

## Cross-model tracker

Path:

```bash
${CLAUDE_SKILL_DIR}/scripts/cross-model-tracker.sh
```

Manages shared threads across Codex and Gemini. Commands:

- `new <name>` — create a new cross-model thread
- `link <name> <model> <session-ref>` — link a model session to a thread
- `log <name> <model> <summary>` — append a turn summary
- `get <name>` — show thread state (JSON)
- `list` — list all active threads
- `export <name>` — export context summary for prompt injection

State is stored in `~/.claude/cross-model-threads/`.

## Debate script

Path:

```bash
${CLAUDE_SKILL_DIR}/scripts/debate.sh
```

Automates structured cross-model critique cycles. Options:

- `--topic <text>` — the question to debate (required)
- `--first <model>` — which model goes first: `codex` or `gemini` (default: codex)
- `--rounds <n>` — number of critique rounds (default: 1)
- `--context <text>` — additional context for all prompts
- `--structured` — use JSON output
- `--fast` / `--deep` — depth control
- `--output-dir <dir>` — save round outputs

Requires `GEMINI_SKILL_DIR` environment variable to locate the Gemini skill.
