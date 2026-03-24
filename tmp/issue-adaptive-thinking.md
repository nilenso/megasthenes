## Summary
Enable Claude Adaptive Thinking for Ask Forge requests, with **guardrails**: do not ship as default until we run evals and confirm quality/cost/latency tradeoffs against the current non-thinking mode.

Docs:
- https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
- https://platform.claude.com/docs/en/build-with-claude/extended-thinking#interleaved-thinking

## Motivation
Ask Forge currently streams `thinking_delta` progress events but does not explicitly configure Adaptive/Extended Thinking behavior. Enabling adaptive thinking may improve answer completeness and reasoning quality for complex repo questions, but can also increase token usage and latency.

We should make this a measured rollout backed by eval evidence.

## Scope
- Add configurable support for Adaptive Thinking in Ask Forge model calls.
- Keep non-thinking mode available as baseline.
- Add evaluation workflow to compare:
  - quality metrics
  - broken-link behavior
  - inference latency
  - token usage / cost signals

## Caveat / rollout policy
**Do not turn Adaptive Thinking on by default** until evals show clear improvement (or acceptable tradeoff) versus non-thinking mode.

## Proposed implementation
1. **Config surface**
   - Extend `ForgeConfig` with a `thinking` config (e.g., `"off" | "adaptive"`, and optional advanced settings if supported by provider).
   - Keep default as `off` initially.

2. **Session/model wiring**
   - Pass thinking config through to the underlying model completion/stream API.
   - Ensure compatibility across providers; gracefully no-op or error with clear messaging where unsupported.

3. **CLI / docs**
   - Document how to enable adaptive thinking.
   - Document provider/model caveats.

4. **Evals**
   - Run evals on the same dataset for:
     - Baseline: non-thinking mode
     - Candidate: adaptive thinking enabled
   - Compare outputs using existing eval tooling (`scripts/eval/run-eval.ts` + report generation).
   - Include a brief results summary in this issue before changing defaults.

## Acceptance criteria
- [ ] `ForgeConfig` supports explicit thinking mode selection.
- [ ] Adaptive thinking can be enabled in code path used by `Session.ask()`.
- [ ] Existing behavior remains unchanged when thinking is not configured.
- [ ] Evals are run for baseline vs adaptive on the same dataset and attached/linked in this issue.
- [ ] Decision note added in issue comments: keep `off` or flip default based on measured results.

## Suggested eval success gates
(Adjust thresholds as needed before final decision.)

- Quality:
  - No regression in judged completeness/evidence metrics
  - Prefer improvement in reasoning-related metric(s)
- Reliability:
  - No increase in tool or link-validation failure rate
- Cost/latency:
  - Median latency increase within acceptable bound (e.g., <= 20–30%), unless quality gains justify higher cost
  - Token increase explicitly reported and accepted

## Notes
Given current architecture, this likely touches:
- `src/index.ts` (`ForgeConfig` / resolved config)
- `src/session.ts` (request construction / streaming call options)
- docs in `README.md`
- eval scripts/report notes for side-by-side run comparison
