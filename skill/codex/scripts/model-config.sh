#!/usr/bin/env bash
# model-config.sh — single source of truth for Codex model names.
#
# Why this file exists: model names used to be hardcoded per-flag in every
# wrapper script (codex-ask.sh, codex-review.sh, ...). Whenever OpenAI retired
# a model (e.g. the old "gpt-5.1-codex-mini") the wrappers would silently route
# to a dead model and the skill appeared "broken". Centralizing the names here
# means a single edit fixes every wrapper at once.
#
# Source this file, then read the CODEX_MODEL_* constants. Per-script env
# overrides (CODEX_SKILL_MODEL, --fast/--deep flags) still take precedence in
# the wrappers; these are only the defaults.
#
# ⚠️ MODEL NAMES NEED PERIODIC CONFIRMATION ⚠️
# The Codex CLI does not expose a machine-readable model list (`codex --list`
# is not a thing as of codex-cli 0.137.0), so these cannot be auto-derived and
# must be confirmed by hand against what OpenAI currently serves. If `--fast`
# or `--deep` start failing, the most likely cause is a retired model name
# below. The DEEP/default model below matches the user's ~/.codex/config.toml
# (model = "gpt-5.6-sol"); the FAST model is the low-cost agentic tier of the
# same 5.6 family and is the one most likely to need confirmation.

# Default / "deep" full model. Mirrors ~/.codex/config.toml default.
# GPT-5.6 family GA 2026-07-09 (Sol = frontier, Terra = balanced, Luna = fast).
: "${CODEX_MODEL_DEFAULT:=gpt-5.6-sol}"
: "${CODEX_MODEL_DEEP:=gpt-5.6-sol}"

# Lightweight model for --fast (Luna: "fast and affordable agentic coding model").
: "${CODEX_MODEL_FAST:=gpt-5.6-luna}"

# Reasoning effort presets per tier.
: "${CODEX_REASONING_FAST:=low}"
: "${CODEX_REASONING_DEEP:=xhigh}"
: "${CODEX_REASONING_DEFAULT:=xhigh}"
