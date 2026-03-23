# Error Analysis Audit Report
**Project:** ask-forge  
**Audit Date:** 2026-03-12  
**Area:** Error Analysis  
**Auditor:** Claude Code (pi-agent worker)

---

## Executive Summary

The ask-forge eval pipeline shows **partial evidence** of error-grounded design but lacks systematic error analysis infrastructure. Judge criteria evolved reactively based on observed patterns (e.g., `is_answer_relevant` → `is_answer_complete`), but **no formal failure taxonomy, labeled trace datasets, or documented error categories** were found.

**Status:** 🟡 **MIXED** — Some application-grounded refinement, but missing systematic error analysis foundation.

---

## Findings

### 1. Systematic Error Analysis on Real Traces

**Status:** ❌ **PROBLEM EXISTS**

**Evidence:**
- ✅ **Found:** Eval results with 32 rows in latest run (`eval_2026-02-09_13-44-46-800.csv`)
- ✅ **Found:** `misc_feedback` field in judge output capturing per-trace observations
- ❌ **Missing:** Labeled trace datasets with failure categorizations
- ❌ **Missing:** Documented failure modes or error taxonomy
- ❌ **Missing:** Systematic trace review notes or analysis artifacts
- ❌ **Missing:** Error category definitions referenced in code or documentation

**Current state:**
- Judge outputs free-form `misc_feedback` but this is not systematically aggregated or analyzed
- Latest eval shows failures across dimensions:
  - `is_evidence_supported`: 10/32 failures
  - `is_evidence_linked`: 25/32 failures (78% failure rate!)
  - `is_answer_complete`: 3/32 failures
  - `is_reasoning_sound`: 0/32 failures (criterion may be too lenient)

**Problem:**
Without systematic error categorization, the team cannot:
- Prioritize which failure modes matter most
- Track if fixes actually reduce specific error types
- Distinguish between acceptable vs unacceptable failures
- Build stratified test sets targeting known weaknesses

---

### 2. Failure Category Provenance: Brainstormed vs Observed

**Status:** 🟡 **MIXED**

**Evidence from git history:**

**Application-grounded (observed from traces):**
- `is_answer_complete` (commit `0fb4ad7`): Replaced `is_answer_relevant` because it was "near-always 'yes'" — direct observation from eval runs
  > "is_answer_relevant was near-always 'yes' since the model always engages with the question."
- Specific failure patterns documented in commit message:
  - Partial answers
  - 'What' answers to 'when/why/how' questions  
  - Deflections
  - Untraceable concrete scenarios

**Hypothesized (brainstormed):**
- `is_reasoning_sound` (commit `a4b1610`): Added to "catch cases where linked code disproves the stated claim, causal chains have missing steps..."
  - Describes plausible failure modes but no evidence these were observed in actual traces
  - 0/32 failures in latest eval suggests:
    - Either this failure mode is rare (good!)
    - Or the rubric is too lenient (bad!)
    - Or the test set doesn't cover these scenarios (bad!)

**Generic (not application-specific):**
- `is_evidence_supported`: Standard eval criterion, not unique to ask-forge's domain
- `is_evidence_linked`: Specific to ask-forge's linking requirements but not grounded in observed failure clustering

**Verdict:**
Judge criteria are **partially application-grounded** but lack systematic failure mode discovery. The team is reacting to some observed patterns but not systematically categorizing and tracking error types.

---

### 3. Error Analysis Artifacts Search

**Status:** ❌ **NOT FOUND**

Searched for:
- ✅ Eval results CSVs (found in `tmp/eval/reports/` and `scripts/eval/reports/`)
- ✅ Judge prompt with rubrics (`src/prompt.ts`)
- ✅ Eval runner (`scripts/eval/run-eval.ts`)
- ❌ Failure categorization files
- ❌ Error taxonomy documentation
- ❌ Trace review notes
- ❌ Labeled failure datasets
- ❌ Error mode definitions
- ❌ Systematic analysis of `misc_feedback` aggregations

**Files examined:**
- `eval-research.md`: UX research for eval viewer, no error analysis
- `CHANGELOG.md`: Documents judge criteria changes but not underlying error analysis
- `tmp/eval/annotations_export.csv`: Only 3 rows, not a systematic review
- Git history: Shows reactive fixes but no documented error analysis process

---

### 4. Eval Dataset and Results Examination

**Status:** 🟡 **MIXED**

**Datasets:**
- `ask-forge-eval-dataset.csv`: 134 questions across various repos
- `ask-forge-eval-dataset-selected.csv`: 15 selected rows (no documented selection criteria)
- Latest results: 32 rows evaluated

**Failure distribution analysis:**
```
is_answer_complete:       3/32 failures (9%)
is_evidence_supported:   10/32 failures (31%)
is_evidence_linked:      25/32 failures (78%) ← CRITICAL
is_reasoning_sound:       0/32 failures (0%)  ← SUSPICIOUS
```

**Key observations:**

1. **Evidence linking is the dominant failure mode** (78% failure rate)
   - This is actionable data but not formally documented as an error category
   - No documented analysis of WHY links fail (model capability? prompt clarity? tool design?)

2. **Evidence support failures** (31%) are material but under-investigated
   - `misc_feedback` shows patterns like "lot more links would've been useful"
   - No systematic categorization of what "unsupported" means in practice

3. **Answer completeness** is mostly passing (91% success)
   - Suggests the replacement of `is_answer_relevant` was effective
   - But no documented validation that the new criterion catches the intended failures

4. **Reasoning soundness never fails** (0%)
   - Either:
     - The model is genuinely sound (unlikely given other metrics)
     - The rubric is too vague or lenient
     - The test set doesn't cover these scenarios
   - **No documented investigation into why this metric is always green**

5. **`misc_feedback` contains unstructured observations** but is never analyzed:
   ```
   "- lot more links would've been useful"
   "- The function names could be linked to the the line for the user to check"
   "- too verbose answer to output a prompt"
   "- The key features section is unnecessary imo"
   ```
   These are valuable error signals but not categorized or tracked.

---

## Recommendations

### Immediate (High Priority)

1. **Conduct systematic trace review** following the `error-analysis` skill workflow:
   - Review 30-50 traces from latest eval results
   - Label each failure with specific error categories
   - Document recurring patterns (not just isolated bugs)
   - Create a failure taxonomy grounded in real traces
   - Reference: `/Users/kiran/.pi/agent/skills/evals-skills/skills/error-analysis/SKILL.md`

2. **Investigate the `is_evidence_linked` crisis** (78% failure rate):
   - Sample 10 failures and categorize WHY links are missing:
     - Model doesn't generate markdown links?
     - Model generates wrong URL format?
     - Model doesn't know which line numbers to use?
     - Prompt doesn't emphasize linking strongly enough?
   - Each root cause may need a different fix

3. **Audit `is_reasoning_sound` criterion** (0% failure rate):
   - Manually review 10 traces and apply the rubric strictly
   - If you can find failures the judge missed → rubric is too lenient, rewrite it
   - If you cannot find failures → test set may be too easy, expand coverage
   - Document findings either way

### Short-term (Medium Priority)

4. **Create labeled trace dataset** with error categories:
   - Format: CSV with columns `[session_id, question, answer, error_category, error_subcategory, notes]`
   - Start with 30-50 examples covering major failure modes
   - This becomes your calibration set for future judge refinement

5. **Aggregate and analyze `misc_feedback`**:
   - Extract all feedback from recent eval runs
   - Cluster into themes (e.g., "missing links", "too verbose", "incomplete coverage")
   - Quantify how often each theme appears
   - Use this to discover blind spots in current judge criteria

6. **Document failure taxonomy** in a `docs/error-taxonomy.md` file:
   - Define each error category with examples
   - Map categories to judge verdicts (e.g., "hallucinated claims" → `is_evidence_supported=no`)
   - Track category prevalence over time to measure improvement

### Long-term (Maintenance)

7. **Establish error analysis as a regular practice**:
   - After each major eval run, dedicate 1-2 hours to trace review
   - Update failure taxonomy as new patterns emerge
   - Track error category trends (are hallucinations decreasing? are link errors increasing?)

8. **Validate judge calibration** following the `validate-evaluator` skill:
   - Create a gold-standard labeled set (50-100 examples with human labels)
   - Measure judge agreement (precision/recall per criterion)
   - Iterate on rubric until agreement is >85%
   - Reference: `/Users/kiran/.pi/agent/skills/evals-skills/skills/validate-evaluator/SKILL.md`

9. **Consider stratified sampling** for test set expansion:
   - Current dataset appears convenience-sampled (134 rows, various repos)
   - Use `generate-synthetic-data` skill to create targeted failure tests
   - Example dimensions: question_type (what/why/how), repo_size, domain
   - Reference: `/Users/kiran/.pi/agent/skills/evals-skills/skills/generate-synthetic-data/SKILL.md`

---

## Positive Findings

Despite the gaps, the eval pipeline has some strengths:

✅ **Reactive iteration based on observations:**  
   - Replacing `is_answer_relevant` with `is_answer_complete` shows responsiveness to eval data

✅ **Rich metadata capture:**  
   - Tool calls, files read, inference time, token usage, broken link ratio all tracked
   - This is good infrastructure for future analysis

✅ **Judge outputs structured + unstructured feedback:**  
   - Binary verdicts (yes/no) for automation + `misc_feedback` for nuance
   - Just needs systematic review of that feedback

✅ **Clear rubrics in judge prompt:**  
   - Each criterion has detailed guidelines with examples
   - This is a good foundation for calibration

---

## Comparison to Best Practices

**What the `error-analysis` skill recommends:**
1. ✅ Start with real traces (ask-forge has eval results)
2. ❌ Systematic review and labeling process (missing)
3. ❌ Documented failure categories (missing)
4. ❌ Calibration against labeled data (missing)
5. ✅ Judge criteria should be application-grounded (partially met)

**Gap:** ask-forge has infrastructure but hasn't run systematic error analysis.

---

## Next Steps

**Suggested workflow:**

1. **Start with error-analysis skill** to establish failure taxonomy:
   ```bash
   # Review latest eval results
   cd /Users/kiran/work/ask-forge
   # Pick 30 traces covering the failure distribution:
   # - 20 evidence_linked failures
   # - 8 evidence_supported failures  
   # - 2 answer_complete failures
   # Manually label each with specific error category
   ```

2. **Document findings** in `docs/error-taxonomy.md`

3. **Refine judge prompt** based on taxonomy (especially `is_reasoning_sound`)

4. **Re-run evals** to validate improvements

5. **Track error category prevalence** over time as a quality metric

---

## References

- Error Analysis Skill: `/Users/kiran/.pi/agent/skills/evals-skills/skills/error-analysis/SKILL.md`
- Validate Evaluator Skill: `/Users/kiran/.pi/agent/skills/evals-skills/skills/validate-evaluator/SKILL.md`
- Generate Synthetic Data Skill: `/Users/kiran/.pi/agent/skills/evals-skills/skills/generate-synthetic-data/SKILL.md`
- Write Judge Prompt Skill: `/Users/kiran/.pi/agent/skills/evals-skills/skills/write-judge-prompt/SKILL.md`

---

## Appendix: Evidence Summary

**Git commits showing iterative refinement:**
- `0fb4ad7`: Replaced `is_answer_relevant` → `is_answer_complete` (observation-driven)
- `a4b1610`: Added `is_reasoning_sound` (hypothesis-driven)
- `d956a0b`: Format judge feedback as bullet points
- `acff019`: Added line numbers to read output (linking accuracy fix)

**Eval infrastructure:**
- Judge prompt: `src/prompt.ts` (JUDGE_SYSTEM_PROMPT)
- Eval runner: `scripts/eval/run-eval.ts`
- Dataset: `ask-forge-eval-dataset.csv` (134 rows)
- Latest results: `tmp/eval/reports/eval_2026-02-09_13-44-46-800.csv` (32 rows)

**Failure patterns observed in latest eval:**
- 78% evidence linking failures (25/32)
- 31% evidence support failures (10/32)
- 9% answer completeness failures (3/32)
- 0% reasoning soundness failures (0/32) ← needs investigation
