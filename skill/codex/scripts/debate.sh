#!/usr/bin/env bash

set -euo pipefail

# Cross-model debate orchestrator
# Runs a structured critique cycle between Codex and Gemini.
# Designed to be called by Claude Code to automate multi-model review.

usage() {
  cat <<'EOF'
Usage:
  debate.sh --topic "<question or task>" [options]

Options:
  --topic <text>         The question or task to debate (required)
  --first <model>        Which model goes first: codex or gemini (default: codex)
  --rounds <n>           Number of critique rounds (default: 1, i.e. A→B→A)
  --context <text>       Additional context to include in all prompts
  --structured           Use JSON output for machine-readable results
  --fast                 Use fast/lightweight models
  --deep                 Use max reasoning
  --output-dir <dir>     Save round outputs to this directory
  -h, --help             Show this help

Environment:
  CODEX_SKILL_DIR        Path to codex skill directory
  GEMINI_SKILL_DIR       Path to gemini skill directory
EOF
}

# Resolve skill directories
script_dir="$(cd "$(dirname "$0")" && pwd)"
codex_skill_dir="${CODEX_SKILL_DIR:-$(dirname "${script_dir}")}"
gemini_skill_dir="${GEMINI_SKILL_DIR:-}"

# Try to find gemini skill if not set
if [[ -z "${gemini_skill_dir}" ]]; then
  # Check common locations
  for candidate in \
    "${HOME}/.claude/skills/gemini" \
    "${HOME}/Development/Claude/gemini_mcp/skill/gemini" \
    "$(dirname "$(dirname "${codex_skill_dir}")")/gemini_mcp/skill/gemini"; do
    if [[ -f "${candidate}/scripts/gemini-ask.sh" ]]; then
      gemini_skill_dir="${candidate}"
      break
    fi
  done
fi

topic=""
first_model="codex"
rounds=1
context=""
structured_flag=""
speed_flag=""
output_dir=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --topic)
      if [[ $# -lt 2 ]]; then echo "--topic requires a value" >&2; exit 2; fi
      topic="$2"
      shift 2
      ;;
    --first)
      if [[ $# -lt 2 ]]; then echo "--first requires codex or gemini" >&2; exit 2; fi
      first_model="$2"
      shift 2
      ;;
    --rounds)
      if [[ $# -lt 2 ]]; then echo "--rounds requires a number" >&2; exit 2; fi
      rounds="$2"
      shift 2
      ;;
    --context)
      if [[ $# -lt 2 ]]; then echo "--context requires a value" >&2; exit 2; fi
      context="$2"
      shift 2
      ;;
    --structured)
      structured_flag="--structured"
      shift
      ;;
    --fast)
      speed_flag="--fast"
      shift
      ;;
    --deep)
      speed_flag="--deep"
      shift
      ;;
    --output-dir)
      if [[ $# -lt 2 ]]; then echo "--output-dir requires a path" >&2; exit 2; fi
      output_dir="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "${topic}" ]]; then
        topic="$1"
      else
        topic+=" $1"
      fi
      shift
      ;;
  esac
done

if [[ -z "${topic}" ]]; then
  echo "Error: --topic is required." >&2
  usage
  exit 2
fi

if [[ -z "${gemini_skill_dir}" ]]; then
  echo "Error: Could not find Gemini skill directory. Set GEMINI_SKILL_DIR." >&2
  exit 1
fi

# Setup output directory
if [[ -n "${output_dir}" ]]; then
  mkdir -p "${output_dir}"
else
  output_dir="$(mktemp -d "${TMPDIR:-/tmp}/debate.XXXXXX")"
fi

# Determine model order
if [[ "${first_model}" == "codex" ]]; then
  model_a="codex"
  model_b="gemini"
else
  model_a="gemini"
  model_b="codex"
fi

run_model() {
  local model="$1"
  local prompt="$2"
  local output_file="$3"

  if [[ "${model}" == "codex" ]]; then
    CLAUDE_SKILL_DIR="${codex_skill_dir}" \
      bash "${codex_skill_dir}/scripts/codex-ask.sh" \
      --one-shot ${speed_flag} ${structured_flag} "${prompt}" > "${output_file}" 2>&1
  else
    CLAUDE_SKILL_DIR="${gemini_skill_dir}" \
      bash "${gemini_skill_dir}/scripts/gemini-ask.sh" \
      --plan ${speed_flag} ${structured_flag} "${prompt}" > "${output_file}" 2>&1
  fi
}

context_block=""
if [[ -n "${context}" ]]; then
  context_block="

Context:
${context}"
fi

echo "=== DEBATE: ${model_a} vs ${model_b} ==="
echo "Topic: ${topic}"
echo "Rounds: ${rounds}"
echo "Output: ${output_dir}"
echo

# Round 1: Model A responds
echo "--- Round 1: ${model_a} responds ---"
round1_file="${output_dir}/round1_${model_a}.md"
run_model "${model_a}" "You are participating in a structured cross-model debate. You go first.${context_block}

Task:
${topic}

Provide your analysis. Be thorough and specific. Your response will be critiqued by another AI model." "${round1_file}"

echo "  Saved to: ${round1_file}"
model_a_response="$(cat "${round1_file}")"

# Round 2: Model B critiques
echo "--- Round 2: ${model_b} critiques ${model_a} ---"
round2_file="${output_dir}/round2_${model_b}_critiques.md"
run_model "${model_b}" "You are reviewing another AI model's (${model_a}) response in a structured cross-model debate. Be constructive but critical. Point out strengths, weaknesses, missing considerations, and potential bugs or errors.${context_block}

Original task:
${topic}

${model_a}'s response:
${model_a_response}

Provide your critique. Be specific about what is wrong, what is missing, and what is good." "${round2_file}"

echo "  Saved to: ${round2_file}"
model_b_critique="$(cat "${round2_file}")"

# Round 3: Model A addresses critique
echo "--- Round 3: ${model_a} addresses critique ---"
round3_file="${output_dir}/round3_${model_a}_response.md"
run_model "${model_a}" "You are in a structured cross-model debate. Another AI model (${model_b}) has critiqued your earlier response. Address their points: concede where they are right, defend where you disagree, and provide an improved version of your analysis.${context_block}

Original task:
${topic}

Your earlier response:
${model_a_response}

${model_b}'s critique:
${model_b_critique}

Provide your updated analysis addressing all valid critique points." "${round3_file}"

echo "  Saved to: ${round3_file}"
model_a_revised="$(cat "${round3_file}")"

# Additional rounds if requested
prev_response="${model_a_revised}"
prev_model="${model_a}"
current_model="${model_b}"
round_num=4

for ((r=2; r<=rounds; r++)); do
  # Counter-critique
  echo "--- Round ${round_num}: ${current_model} counter-critiques ---"
  round_file="${output_dir}/round${round_num}_${current_model}.md"
  run_model "${current_model}" "Continuing the cross-model debate. ${prev_model} has revised their response after your earlier critique. Review the updated version — has it improved? Are there remaining issues?${context_block}

Original task: ${topic}

${prev_model}'s revised response:
${prev_response}

Provide your assessment of the improvements and any remaining issues." "${round_file}"

  echo "  Saved to: ${round_file}"
  critique="$(cat "${round_file}")"
  round_num=$((round_num + 1))

  # Response to counter-critique
  echo "--- Round ${round_num}: ${prev_model} responds ---"
  round_file="${output_dir}/round${round_num}_${prev_model}.md"
  run_model "${prev_model}" "Continuing the cross-model debate. Address the latest critique.${context_block}

Original task: ${topic}

Your latest response:
${prev_response}

${current_model}'s latest critique:
${critique}

Address the points and provide your final refined analysis." "${round_file}"

  echo "  Saved to: ${round_file}"
  prev_response="$(cat "${round_file}")"
  round_num=$((round_num + 1))

  # Swap models for next round
  tmp="${current_model}"
  current_model="${prev_model}"
  prev_model="${tmp}"
done

# Generate synthesis summary
echo
echo "=== DEBATE COMPLETE ==="
echo "All outputs saved to: ${output_dir}"
echo
echo "Files:"
ls -1 "${output_dir}"/round*.md 2>/dev/null
echo
echo "To synthesize results, Claude should read all round files and extract:"
echo "  1. Points of consensus (both models agree)"
echo "  2. Divergences (models disagree — present both perspectives)"
echo "  3. Unique insights (found by only one model)"
echo "  4. Errors corrected (caught by critique rounds)"
