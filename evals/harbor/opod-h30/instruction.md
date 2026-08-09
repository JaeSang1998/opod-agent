# Evaluate OPOD H30 conversation readiness

This is a verifier-driven container wrapper. The Harbor agent is intentionally `nop`: it does not edit
the workspace, produce a rollout, or represent the OPOD candidate in `AgentContext`. The verifier runs
the repository's closed-loop H30 suite against the configured candidate, preserves its reports and ATIF
trajectory under `/logs/verifier/opod-eval`, and writes numeric scores to `/logs/verifier/reward.json`.
