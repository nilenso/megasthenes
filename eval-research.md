# Eval Viewer Research Notes

## Sources reviewed

I reviewed UI/UX patterns and docs from:

- LangSmith experiment comparison docs
- Arize AX/Phoenix compare experiments docs
- Promptfoo web viewer docs
- Braintrust interpret results docs
- W&B Weave comparison/leaderboard docs and comparison report
- Langfuse experiments via UI docs
- Helicone experiments docs
- TruLens dashboard/comparison docs

## Repeated UX patterns across strong eval tools

1. **Baseline-first comparison**
   - Explicitly set and show a baseline run.
   - Deltas and regression highlighting depend on this.

2. **Multi-level review flow**
   - High-level summary first (metrics + deltas)
   - Then focused triage views (regressions / failures)
   - Then per-question row-level deep dives

3. **Strong filtering + display modes**
   - Modes like all / failures / regressions / changed
   - Rich filters and sortable metric columns are core to fast triage

4. **Side-by-side detail panes**
   - Compare outputs and key metadata at row level
   - Keep long content collapsible to reduce clutter

5. **Progressive disclosure**
   - Clean default view; detailed traces/prompts/debug data hidden behind expansion

6. **Actionable prioritization**
   - Severity and impact ordering used heavily
   - Helps reviewers find the highest-value regressions first

## Critical additional fields to track in every eval run

These fields are the highest-value additions for robust evaluation workflows.

### 1) Run identity and provenance
- `run_id`
- `run_timestamp`
- `baseline_run_id`
- `git_branch`
- `git_commit`

Why: makes comparisons reproducible and avoids ambiguity about what changed.

### 2) Dataset lineage and slicing
- `dataset_id`
- `dataset_version`
- `dataset_slice` (category / domain / difficulty / language)

Why: top tools rely on slicing to localize regressions.

### 3) Prompt/model config versioning
- `ask_prompt_version` (or hash)
- `judge_prompt_version` (or hash)
- `temperature`, `top_p`, `max_tokens`

Why: these are often the real causes of shifts between runs.

### 4) Token and cost telemetry
- `prompt_tokens`
- `completion_tokens`
- `total_tokens`
- `cost_usd`

Why: comparison decisions frequently trade off quality vs latency vs cost.

### 5) Reliability and failure signals
- `run_status` (`ok|error|timeout|partial`)
- `error_type`
- `error_message`
- `retry_count`

Why: separates true quality issues from execution/infra failures.

### 6) Tooling quality numerics (in addition to raw text)
- `tool_call_count`
- `tool_error_count`
- `files_read_count`

Why: faster filtering/sorting than parsing free-form lists.

### 7) Evidence quality detail
- `invalid_link_count`
- `total_link_count`
- optional: `citation_count`, `claims_with_citations_pct`

Why: evidence regressions are a common and high-impact failure mode.

### 8) Traceability links
- `trace_url`
- `session_url`

Why: row-to-trace navigation is essential during investigation.

### 9) Human review loop fields
- `human_label`
- `human_score`
- `review_notes`

Why: top systems support human override and annotation to improve eval quality over time.

## Practical recommendation

Keep your current fields, and add the above in a backward-compatible `v2` CSV schema. 

This enables:

- better run-to-run accountability
- better sorting/filtering and triage speed
- clearer quality/cost/latency tradeoff decisions
- stronger debugging and auditability
