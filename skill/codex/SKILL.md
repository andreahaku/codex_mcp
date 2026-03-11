---
name: codex
description: >
  Use the local Codex CLI when the user explicitly asks to consult Codex, delegate a task to Codex,
  run /codex, continue or resume a Codex conversation, or request a Codex review of local changes,
  a branch, a commit, or a PR. Prefer persistent multi-turn Codex sessions for iterative coding,
  architecture analysis, refinement, and back-and-forth collaboration. This skill is independent
  from any MCP server and talks directly to the installed `codex` CLI.
---

# Codex

Use the local `codex` CLI directly. Do not use this repository's MCP server when this skill is active.

## Context

- Working directory: !`pwd`
- Current branch: !`git branch --show-current 2>/dev/null || true`
- Git status: !`git status -sb 2>/dev/null | head -20 || true`

## Workflow

1. Decide whether the request is a collaborative Codex consultation or a Codex review.
2. For collaborative consultations, default to a persistent multi-turn session instead of a one-shot prompt.

Start a new persistent session when the user is opening a new line of work:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/codex-ask.sh" --new --name <task-slug> "<prompt>"
```

Resume the most recent Codex session for the current workspace when the user is clearly continuing the same Codex collaboration:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/codex-ask.sh" --last "<follow-up prompt>"
```

Resume a specific Codex session when the user provides a session id or a known alias:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/codex-ask.sh" --session <session-id-or-alias> "<follow-up prompt>"
```

Use one-shot mode only for isolated requests that do not need iterative follow-up:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/codex-ask.sh" --one-shot "<prompt>"
```

3. Prefer persistent sessions for:

- architecture analysis
- code refinement and iterative implementation
- debugging that may require multiple rounds
- tradeoff discussions
- asking Codex to critique or deepen an earlier answer

4. Prefer one-shot mode only for narrow, self-contained prompts where no follow-up context is useful.
5. For review requests, prefer the review wrapper:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/codex-review.sh" --uncommitted
```

Use these variants when the target is explicit:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/codex-review.sh" --base main
bash "${CLAUDE_SKILL_DIR}/scripts/codex-review.sh" --commit <sha>
```

6. If the user provides extra review instructions, append them with `--prompt`.
7. After using `codex-ask.sh`, read the `[codex-session] ...` preamble in the wrapper output. Preserve the session id or alias in your reply so the user can continue the same Codex thread later.
8. Summarize Codex's result clearly and attribute it to Codex. Preserve concrete findings, file paths, line references, and notable tradeoffs when present.

## Session Strategy

- Prefer `--new --name <task-slug>` when starting a substantial task. Choose short, stable aliases such as `auth-refactor`, `api-design`, or `react-perf`.
- Prefer `--last` when the user clearly says to continue, resume, iterate on, or follow up on the most recent Codex conversation in the same workspace.
- Prefer `--session <alias-or-id>` when the user names a session explicitly or when multiple ongoing Codex threads could make `--last` ambiguous.
- If the user asks for a collaborative discussion with Codex but does not specify a target session, start a new persistent session instead of falling back to one-shot.
- If the continuation target is ambiguous and the wrong session would be misleading, ask one short clarifying question.

## Review defaults

- If the user asks for a review but gives no target, default to `--uncommitted`.
- If the user clearly refers to a specific commit, use `--commit`.
- If the user clearly refers to branch or PR changes against a base branch, use `--base`.
- If the review target is ambiguous and the wrong target would be misleading, ask one short clarifying question.

## Notes

- The wrappers live inside this skill, so the skill remains portable and independent from `codex_mcp`.
- Optional environment variables for the wrappers are documented in [references/codex-cli.md](references/codex-cli.md).
