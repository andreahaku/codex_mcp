---
name: codex
description: >
  Use the local Codex CLI when the user explicitly asks to consult Codex, delegate a task to Codex,
  run /codex, or request a Codex review of changes, a branch, a commit, or a PR. This skill is
  independent from any MCP server and talks directly to the installed `codex` CLI.
user-invocable: true
argument-hint: "<prompt or review request>"
compatibility: Requires Codex CLI installed and authenticated.
---

# Codex

Use the local `codex` CLI directly. Do not use this repository's MCP server when this skill is active.

## Context

- Working directory: !`pwd`
- Current branch: !`git branch --show-current 2>/dev/null || true`
- Git status: !`git status -sb 2>/dev/null | head -20 || true`

## When to use this skill

- The user invokes `/codex ...`
- The user explicitly asks you to ask Codex
- The user wants Codex to review local changes, a branch, a commit, or a PR

If the user did not explicitly request Codex, do not force this skill.

## Workflow

1. Decide whether the request is a general Codex consultation or a Codex review.
2. For general consultation, run:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/codex-ask.sh" "<prompt>"
```

3. For review requests, prefer the review wrapper:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/codex-review.sh" --uncommitted
```

Use these variants when the target is explicit:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/codex-review.sh" --base main
bash "${CLAUDE_SKILL_DIR}/scripts/codex-review.sh" --commit <sha>
```

4. If the user provides extra review instructions, append them with `--prompt`.
5. Summarize Codex's result clearly and attribute it to Codex. Preserve concrete findings, file paths, and line references when present.

## Review defaults

- If the user asks for a review but gives no target, default to `--uncommitted`.
- If the user clearly refers to a specific commit, use `--commit`.
- If the user clearly refers to branch or PR changes against a base branch, use `--base`.
- If the review target is ambiguous and the wrong target would be misleading, ask one short clarifying question.

## Notes

- The wrappers live inside this skill, so the skill remains portable and independent from `codex_mcp`.
- Optional environment variables for the wrappers are documented in [references/codex-cli.md](references/codex-cli.md).
