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
# is not a thing as of codex-cli 0.153.4), so these cannot be auto-derived and
# must be confirmed by hand against what OpenAI currently serves. If `--fast`
# or `--deep` start failing, the most likely cause is a retired model name
# below.
#
# ⚠️ THIS FILE OVERRIDES ~/.codex/config.toml, it does not read it.
# codex-ask.sh always passes `-c model="..."` explicitly (line 372-381), so
# whatever is set here WINS over the model chosen in the Codex TUI. On
# 2026-09-05 the TUI was switched to gpt-6-astra while this file still said
# gpt-5.6-sol, and for a few hours `codex` in the terminal and `/codex` inside
# Claude Code were two different models under one name. Keep the two in sync
# by hand, or check both before trusting a label.
#
# ⚠️ THE REASONING DEFAULT BELOW ONLY APPLIES WHEN NO MODEL IS SET.
# In codex-ask.sh the `reasoning` fallback lives in the `else` branch, i.e. it
# fires only when neither --model nor CODEX_SKILL_MODEL is given. Set a model
# explicitly and no `model_reasoning_effort` is sent at all: the level then
# comes from ~/.codex/config.toml. Any benchmark row labelled by model but not
# by effort has therefore inherited whatever that file said on the day it ran.

# Default / "deep" full model. Allineato a ~/.codex/config.toml il 5/9/2026 su
# richiesta di Andrea, dopo che la TUI era passata a gpt-6-astra.
# GPT-6 Astra GA 2026-09-03. GPT-5.6 family GA 2026-07-09 (Sol = frontier,
# Terra = balanced, Luna = fast) resta raggiungibile con CODEX_SKILL_MODEL.
#
# 💰 Costo misurato il 5/9 sugli 8 task del super-bench, stesso runner e stesso
# regime one-shot (reports/astra-vs-sol-costo-2026-09-05.md in ollama-bench):
# Astra e' ~$10/M input e ~$50/M output contro i ~$2,50-3 e ~$20-25 di Sol.
# A parita' di lavoro prodotto, Astra `high` costa ~2x Sol `xhigh` e Astra
# `xhigh` ~3x, nonostante Astra usi MENO token (a `high` il 38% dell'output di
# Sol). Il prezzo unitario si mangia l'efficienza.
# ⚠️ Con CODEX_REASONING_DEFAULT=xhigh qui sotto, un `/codex` senza flag e senza
# env prende Astra `xhigh`, cioe' il braccio piu' caro dei quattro misurati.
: "${CODEX_MODEL_DEFAULT:=gpt-6-astra}"
: "${CODEX_MODEL_DEEP:=gpt-6-astra}"

# Lightweight model for --fast (Luna: "fast and affordable agentic coding model").
# ⚠️ NON allineato ad Astra apposta: Astra non pubblica un tier economico, e --fast
# esiste per costare poco. La skill quindi mescola due famiglie, 6 per default/deep
# e 5.6 per fast. E' voluto, non una svista.
: "${CODEX_MODEL_FAST:=gpt-5.6-luna}"

# Reasoning effort presets per tier.
: "${CODEX_REASONING_FAST:=low}"
: "${CODEX_REASONING_DEEP:=xhigh}"
: "${CODEX_REASONING_DEFAULT:=xhigh}"
