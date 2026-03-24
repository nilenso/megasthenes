# Eval Pipeline Audit Report — ask-forge

**Date:** March 12, 2026  
**Scope:** Full eval pipeline audit across 6 diagnostic areas  
**Method:** Automated audit using `eval-audit` skill from [hamelsmu/evals-skills](https://github.com/hamelsmu/evals-skills)

---

## Executive Summary

The ask-forge eval pipeline has **good infrastructure foundations** (binary judge verdicts, code-based link validation, an eval viewer, rich metadata capture) but suffers from **critical process gaps** that undermine trust in the metrics it produces. The three highest-impact problems are:

1. **No judge validation** — the LLM judge has never been measured against human labels
2. **Stale metrics** — no eval has been run in 31 days despite major prompt and judge changes
3. **No systematic error analysis** — failure categories were partially brainstormed, not observed from traces

Until these are addressed, eval results cannot be trusted to guide product decisions.

---

## Findings by Impact

### 🔴 P0 — Critical (fix immediately)

#### 1. Stale Eval Metrics (Pipeline Hygiene)

**Status:** Problem exists

Last eval run: **Feb 9, 2026** (31 days ago). Since then:
- Feb 19: Judge criteria changed (`is_answer_relevant` → `is_answer_complete`, added `is_reasoning_sound`)
- Feb 20: Judge model upgraded to Claude Sonnet 4.6
- Feb 27: **5 commits** rewriting system prompt (tool usage, response, evidence, and linking guidelines)

All current metrics are stale and incomparable to previous runs. Any decisions based on the Feb 9 results are unreliable.

**Fix:** Re-run the full eval suite immediately:
```bash
bun run scripts/eval/run-eval.ts ask-forge-eval-dataset-selected.csv
```
Then establish a policy: re-run evals after every significant prompt, model, or judge change.

---

#### 2. Unvalidated LLM Judge (Judge Validation)

**Status:** Problem exists

The LLM judge (Claude Sonnet 4.6) produces verdicts across 4 dimensions, but:
- ❌ No confusion matrices, TPR/TNR, or alignment scores exist
- ❌ No human-labeled validation dataset with the current judge schema
- ❌ Schema mismatch: human labels use `is_answer_relevant`/`is_clear_and_readable`, judge uses `is_answer_complete`/`is_reasoning_sound`/`is_evidence_linked`
- Only `is_evidence_supported` matches between human labels and judge output

Without validation, you don't know if the judge agrees with human judgment. The 78% failure rate on `is_evidence_linked` could be a real crisis or a miscalibrated judge — there's no way to tell.

**Fix:** Use the `validate-evaluator` skill:
1. Label 100 examples (50 Pass + 50 Fail per criterion) using current judge schema
2. Split into train (15) / dev (40) / test (45)
3. Measure TPR and TNR per criterion (target: >80% each)
4. Add few-shot examples to judge prompt from the training set
5. Apply Rogan-Gladen bias correction to aggregate metrics

**Quick win:** Validate `is_evidence_supported` only using existing 20 human-labeled rows (1–2 hours).

---

#### 3. No Systematic Error Analysis (Error Analysis)

**Status:** Problem exists

No labeled trace datasets, failure category definitions, or trace review notes found. The judge evaluates generic quality dimensions rather than application-specific failure modes discovered from real traces.

Evidence of partial grounding: `is_answer_complete` replaced `is_answer_relevant` based on observing a near-100% pass rate. But this was reactive, not systematic.

**Suspicious signal:** `is_reasoning_sound` has a **0% failure rate** (0/32). Either the criterion is too lenient, or the test set doesn't cover reasoning failures.

**Fix:** Use the `error-analysis` skill:
1. Review 30–50 traces from the latest eval results
2. Label failures with application-specific categories (e.g., "wrong file referenced", "missed multi-part question", "fabricated line number")
3. Build evaluators grounded in observed failure modes

---

### 🟠 P1 — High (fix this sprint)

#### 4. `is_evidence_linked` Duplicates Code-Based Check (Evaluator Design)

**Status:** Problem exists

Two checks validate link quality:
- **LLM judge** (`is_evidence_linked`): "yes only if EVERY code reference has a valid GitHub URL" — 78% fail rate
- **Code-based check** (`broken_link_ratio` via `response-validation.ts`): deterministic file existence check — already running

The LLM judge is redundant, expensive, and likely miscalibrated for this objectively-checkable criterion.

**Fix:** Remove `is_evidence_linked` from the judge prompt. Use only the code-based `broken_link_ratio` with a threshold (e.g., pass if < 10% broken). Save LLM judge calls for subjective criteria.

---

#### 5. `is_answer_complete` Is Too Holistic (Evaluator Design)

**Status:** Problem exists

The rubric for `is_answer_complete` checks 4+ distinct failure modes in one dimension:
- Multiple parts addressed
- "When/why/how" vs "what" distinction
- Hedging/deflection
- General vs specific scenarios

When this fails, you can't tell *which* aspect failed without reading the `misc_feedback`.

**Fix:** Use the `write-judge-prompt` skill to split into narrower judges (e.g., `addresses_all_parts`, `avoids_hedging`) or add code-based checks for detectable patterns (hedge word detection).

---

#### 6. Near-Zero Human Labels (Labeled Data)

**Status:** Problem exists

| Metric | Current | Target | Gap |
|--------|---------|--------|-----|
| Labeled rows | 27 of 134 | ~100 | 73 |
| Pass examples | 24 | ~50 | 26 |
| Fail examples | 1 | ~50 | 49 |

The 24:1 Pass/Fail imbalance makes it impossible to validate the judge's ability to detect failures.

**Quick win:** `tmp/eval/goose-eval-50.csv` has 60 questions with expert-written reference answers. Labeling these gets you from 27 → 87 examples.

**Fix:** Use the `generate-synthetic-data` skill for dimension-based sampling, then label strategically to reach 100+ examples with balanced Pass/Fail per criterion.

---

#### 7. No Annotation Workflow (Human Review)

**Status:** Problem exists

A Flask-based review server with annotation UI was **deleted** (commit `feeb65b`, Feb 8, 2026). The current `eval-viewer.html` is **read-only** — no way to collect human judgments.

Without an annotation tool, you can't build the labeled dataset needed for judge validation (Finding #2) or error analysis (Finding #3).

**Fix:** Use the `build-review-interface` skill to create an annotation tool that:
- Shows full traces (input, tool calls, retrieved files, final answer)
- Collects binary Pass/Fail labels per criterion
- Exports labeled data as CSV
- Tracks reviewer identity

---

### 🟡 P2 — Medium (fix this month)

#### 8. No Train/Dev/Test Split (Labeled Data + Judge Validation)

**Status:** Problem exists

`ask-forge-eval-dataset-test.csv` is **not** a held-out test set — it's just the base dataset without labels. No splitting strategy exists. This is a blocker for judge validation (Finding #2).

**Fix:** Once you reach 100 labeled examples, split 60/20/20 (train/dev/test). Use training examples as few-shot sources for the judge prompt. Iterate on dev. Measure final metrics on test (once only).

---

#### 9. Judge Prompt Lacks Few-Shot Examples (Evaluator Design)

**Status:** Problem exists

The judge prompt has detailed rubrics but **zero few-shot examples**. Borderline cases (e.g., "Is a partial hedge acceptable?") are undefined, leading to inconsistent verdicts.

**Fix:** After creating the train/dev/test split, add 3–5 examples per dimension from the training set, including at least one clear Pass, one clear Fail, and one borderline case.

---

#### 10. No CI/Automation (Pipeline Hygiene)

**Status:** Problem exists

No automated eval runs on PR, merge, or schedule. Evals are manual-only, which explains the 31-day gap.

**Fix:** Add a CI job that runs evals on PRs touching `src/prompt.ts`, `scripts/eval/`, or model config. Even a small subset (15 questions) catches regressions early.

---

#### 11. Misleading Code Comment (Pipeline Hygiene)

**Status:** Problem exists

Line 10 of `scripts/eval/run-eval.ts`:
```
// LLM Judge (commented out — currently using link validation instead)
```
But the judge code is fully operational and running. This confuses contributors.

**Fix:** Update the comment to reflect reality.

---

### ✅ OK — No Issues Found

| Area | Status | Notes |
|------|--------|-------|
| Binary verdicts | ✅ OK | All judge dimensions use yes/no, not Likert scales |
| No similarity metrics | ✅ OK | No ROUGE, BERTScore, or cosine similarity used |
| Vanity metrics removed | ✅ OK | `is_clear_and_readable` (100% pass) was replaced |
| Dataset diversity | ✅ OK | 23 repos, varied question types and complexity |
| Active development | ✅ OK | 36 eval-related commits in 16 days |
| Rich metadata | ✅ OK | Token usage, tool calls, inference time captured |

---

## Recommended Action Plan

### Week 1: Stabilize

| # | Action | Skill | Effort |
|---|--------|-------|--------|
| 1 | Re-run full eval suite | — | 2 hrs |
| 2 | Fix misleading comment in `run-eval.ts` | — | 5 min |
| 3 | Remove `is_evidence_linked` from judge; use code-based check only | `write-judge-prompt` | 1 hr |
| 4 | Validate `is_evidence_supported` with existing 20 human labels | `validate-evaluator` | 2 hrs |

### Week 2: Error Analysis

| # | Action | Skill | Effort |
|---|--------|-------|--------|
| 5 | Review 30–50 traces from latest results; build failure taxonomy | `error-analysis` | 4–6 hrs |
| 6 | Investigate `is_reasoning_sound` 0% failure rate | `error-analysis` | 2 hrs |
| 7 | Label goose-eval-50 outputs (60 examples) | — | 4–6 hrs |

### Week 3: Judge Calibration

| # | Action | Skill | Effort |
|---|--------|-------|--------|
| 8 | Build annotation tool for human labeling | `build-review-interface` | 4–8 hrs |
| 9 | Label to 100+ examples with balanced Pass/Fail | — | 6–8 hrs |
| 10 | Create train/dev/test split; add few-shot examples | `validate-evaluator` | 2 hrs |
| 11 | Measure TPR/TNR per criterion; iterate on dev set | `validate-evaluator` | 4 hrs |

### Week 4: Sustain

| # | Action | Skill | Effort |
|---|--------|-------|--------|
| 12 | Add CI eval automation for prompt/judge changes | — | 4 hrs |
| 13 | Document "when to re-run evals" policy | — | 1 hr |
| 14 | Split `is_answer_complete` into narrower judges | `write-judge-prompt` | 4 hrs |

---

## Skills Used / Recommended

| Skill | When to Use |
|-------|-------------|
| [`error-analysis`](https://github.com/hamelsmu/evals-skills) | Week 2: Build failure taxonomy from traces |
| [`write-judge-prompt`](https://github.com/hamelsmu/evals-skills) | Week 1 & 4: Redesign judge prompts with few-shot examples |
| [`validate-evaluator`](https://github.com/hamelsmu/evals-skills) | Week 1 & 3: Calibrate judge against human labels using TPR/TNR |
| [`build-review-interface`](https://github.com/hamelsmu/evals-skills) | Week 3: Build annotation tool for human labeling |
| [`generate-synthetic-data`](https://github.com/hamelsmu/evals-skills) | If real traces are insufficient for error analysis saturation |

---

## References

- [Your AI Product Needs Evals](https://hamel.dev/blog/posts/evals/index.html)
- [Creating an LLM Judge That Drives Business Results](https://hamel.dev/blog/posts/llm-judge/)
- [LLM Evals FAQ](https://hamel.dev/blog/posts/evals-faq/)
- [Who Validates the Validators?](https://arxiv.org/abs/2404.12272)
- [A Field Guide to Improving AI Products](https://hamel.dev/blog/posts/field-guide/)

---

## Artifacts

Detailed per-area reports generated by the audit:
- `tmp/error-analysis-audit.md` — Error analysis diagnostic
- `tmp/eval/human-review-audit.md` — Human review process diagnostic  
- `tmp/eval/labeled-data-audit.md` — Labeled data analysis
- `tmp/eval/labeled-data-summary.md` — Labeled data executive summary
- `tmp/pipeline-hygiene-audit.md` — Pipeline hygiene diagnostic
