#!/usr/bin/env bash
set -uo pipefail

readonly output_dir=/logs/verifier/opod-eval
readonly reward_file=/logs/verifier/reward.json

mkdir -p "$output_dir"

# Harbor resolves optional ${VAR:-} templates to an empty string. Preserve the
# application's "not configured" semantics so role settings can fall back to
# LLM_* and an omitted split embedding endpoint can fall back to LLM_BASE_URL.
optional_env=(
  EMBEDDING_MODEL
  EMBEDDING_BASE_URL
  EMBEDDING_API_KEY
  EVAL_SIMULATOR_BASE_URL
  EVAL_SIMULATOR_MODEL
  EVAL_SIMULATOR_API_KEY
  EVAL_JUDGE_BASE_URL
  EVAL_JUDGE_MODEL
  EVAL_JUDGE_API_KEY
)
for name in "${optional_env[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    unset "$name"
  fi
done

status=0
npm run eval:long -- \
  --output "$output_dir" \
  --reward-file "$reward_file" || status=$?

if [[ ! -f "$reward_file" ]]; then
  printf '{"reward":0,"passed":0,"certification_eligible":0,"pass_rate":0,"mean_scenario_median":0,"p10_score":0,"critical_failure_rate":1}\n' \
    > "$reward_file"
fi

printf '%s\n' "$status" > "$output_dir/runner-exit-code.txt"

# A quality failure is represented by the numeric reward. Exit success so Harbor
# can ingest it; infrastructure crashes still receive the explicit zero reward.
exit 0
