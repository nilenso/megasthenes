# Labeled Data Audit Report
**Project:** ask-forge  
**Audit Date:** 2026-03-12  
**Area:** Labeled Data  
**Auditor:** Claude Code (pi-agent worker)

---

## Executive Summary

The ask-forge eval pipeline has **critical gaps in labeled data**. While 122 examples exist for automated judge evaluation, only **27 rows (22.1%) have human labels**, with an extremely imbalanced Pass/Fail ratio of **24:1**. This is **far below** the minimum thresholds for error analysis (~100 labeled examples) and judge validation (~50 Pass + ~50 Fail).

**Status:** 🔴 **CRITICAL ISSUES**

---

## Findings

### 1. Labeled Data Volume

**Status:** 🔴 **INSUFFICIENT**

| Dataset | Total Rows | Labeled Rows | % Labeled | Pass | Fail | Balance |
|---------|-----------|--------------|-----------|------|------|---------|
| ask-forge-eval-dataset.csv | 122 | 27 | 22.1% | 24 | 1 | 24:1 |
| ask-forge-eval-dataset-selected.csv | 15 | 0 | 0% | - | - | - |
| ask-forge-eval-dataset-test.csv | 122 | 0 | 0% | - | - | - |
| tmp/eval/goose-eval-50.csv | 60 | 60* | 100% | - | - | - |
| tmp/eval/grpo-trainer-eval.csv | 50 | 0 | 0% | - | - | - |

\* goose-eval-50.csv has reference answers, not human judgment labels

**Label column coverage in ask-forge-eval-dataset.csv:**
- `is_answer_relevant`: 25 rows (24 pass, 1 fail)
- `is_evidence_supported`: 20 rows (13 pass, 7 fail)
- `is_clear_and_readable`: 24 rows (24 pass, 0 fail)
- `misc_feedback`: 18 rows (free-text observations)

**Problems:**

1. **Insufficient volume for error analysis saturation:**
   - **Target:** ~100 labeled examples recommended by `error-analysis` skill
   - **Actual:** 27 labeled examples (73% gap)
   - **Impact:** Cannot reliably identify failure mode prevalence or saturation point

2. **Insufficient volume for judge validation:**
   - **Target:** ~50 Pass + ~50 Fail examples recommended by `validate-evaluator` skill
   - **Actual:** 24 Pass + 1 Fail (96% gap in failures)
   - **Impact:** Cannot calibrate judge accuracy, precision, or recall

3. **Extreme class imbalance:**
   - 24:1 Pass/Fail ratio makes it impossible to:
     - Measure judge false positive rate
     - Test judge sensitivity to actual failures
     - Build stratified test sets

4. **No systematic labeling process:**
   - Labels appear convenience-sampled (first 27 rows + a few scattered examples)
   - No documented labeling rubric or inter-rater agreement process
   - No labeled failure taxonomy to guide sampling

---

### 2. Dataset Diversity

**Status:** 🟡 **MIXED**

**Repository coverage:**
- **Unique repositories:** 23
- **Labeled repositories:** 17
- **Unlabeled repositories:** 9 (including 2 major ones: goose, grpo-trainer)

**Top repositories by volume:**
| Repository | Questions | Labeled | % Labeled |
|-----------|-----------|---------|-----------|
| grpo-trainer | 45 | 0 | 0% |
| goose | 38 | 0* | 0% |
| git | 6 | 0 | 0% |
| pi-mono | 4 | 4 | 100% |
| ecoflow_exporter | 3 | 2 | 67% |

\* goose has a separate dataset (`goose-eval-50.csv`) with reference answers, but these are not human judgment labels

**Question type distribution:**
| Type | Count | % |
|------|-------|---|
| What-questions | 51 | 41.8% |
| How-questions | 23 | 18.9% |
| Yes/no-questions | 10 | 8.2% |
| Why-questions | 7 | 5.7% |
| Explain-requests | 3 | 2.5% |
| Other | 28 | 23.0% |

**Question complexity (by length):**
| Complexity | Char Range | Count | % |
|-----------|-----------|-------|---|
| Short | <50 | 36 | 29.5% |
| Medium | 50-100 | 64 | 52.5% |
| Long | >100 | 22 | 18.0% |

**Strengths:**
- ✅ Good repository diversity (23 repos across different domains)
- ✅ Reasonable question type variety (what/how/why/yes-no)
- ✅ Mix of complexity levels (short/medium/long questions)

**Gaps:**
- ❌ Two largest datasets (goose: 38, grpo-trainer: 45) have zero human labels
- ❌ No documented stratification strategy (random sampling evident)
- ❌ No difficulty levels or domain tags to enable targeted eval
- ❌ Unclear if diversity covers actual failure modes

---

### 3. Data Splitting Strategy

**Status:** 🔴 **MISSING**

**Evidence:**
- ✅ Found: `ask-forge-eval-dataset-test.csv` (122 rows)
- ❌ **Not a train/test split:** This file is just the base dataset without label columns
- ❌ No separate train/dev/test partitions
- ❌ No holdout set for judge calibration
- ❌ No documented splitting methodology

**Current state:**
- `ask-forge-eval-dataset.csv` = base dataset WITH sparse human labels (27/122 labeled)
- `ask-forge-eval-dataset-test.csv` = base dataset WITHOUT label columns (same 122 rows)
- `ask-forge-eval-dataset-selected.csv` = 15-row subset (no labels, no documented selection criteria)

**Problems:**
1. **No holdout set for judge validation:**
   - All labeled data is intermixed
   - If labels are used to refine judge prompt, there's no independent test set to measure overfitting

2. **No progressive disclosure for error analysis:**
   - Best practice: start with 30 traces, check saturation, expand if needed
   - Current approach: all 122 examples available at once (but only 27 labeled)

3. **Risk of data leakage:**
   - If judge prompt is iteratively refined based on failures in labeled set, those examples become "training data"
   - Need a reserved test set to verify generalization

**Recommendation:**
- Split labeled data into:
  - **Calibration set:** 60% for iterative judge refinement
  - **Validation set:** 20% for hyperparameter tuning (e.g., judge prompt variations)
  - **Test set:** 20% reserved holdout for final evaluation
- Once you have ~100 labeled examples, split would be: 60 calibration / 20 validation / 20 test

---

### 4. Sampling Strategy

**Status:** 🔴 **UNCLEAR / AD-HOC**

**Evidence searched:**
- ❌ No documentation of sampling methodology
- ❌ No stratification by failure mode, repo type, or question complexity
- ❌ No feedback-driven sampling (selecting hard cases, edge cases, or known failure modes)
- ❌ No synthetic data generation to target gaps

**Observed patterns:**
1. **Convenience sampling evident:**
   - First 10 rows have labels
   - Then scattered labels throughout dataset
   - Suggests labeling fatigue or opportunistic annotation

2. **No clustering analysis:**
   - No evidence of representative sampling from question type clusters
   - No deliberate coverage of different failure scenarios

3. **Separate specialized datasets suggest domain-specific sampling:**
   - `goose-eval-50.csv`: 60 questions with reference answers (deep Goose codebase questions)
   - `grpo-trainer-eval.csv`: 50 questions (no labels)
   - Suggests targeted dataset creation for specific repos, but no labels

**Problems:**
1. **Cannot measure sampling bias:**
   - Unknown if labeled 27 examples are representative of full 122-row distribution
   - Could be skewed toward easier questions or specific repos

2. **No targeted failure mode coverage:**
   - `generate-synthetic-data` skill recommends dimension-based sampling (e.g., question_type × repo_complexity × failure_mode)
   - Current dataset appears randomly sampled without failure hypotheses

3. **Inefficient labeling:**
   - Labeling 27 random examples provides limited signal
   - Better: label 27 examples stratified by anticipated failure modes

**Recommendation:**
- Review the `generate-synthetic-data` skill at:
  `/Users/kiran/.pi/agent/skills/evals-skills/skills/generate-synthetic-data/SKILL.md`
- Before labeling more data, run error analysis on latest eval results to identify failure clusters
- Sample next 73 labels strategically to cover identified failure modes

---

### 5. Reference Answer Dataset (goose-eval-50.csv)

**Status:** 🟢 **GOOD (but different purpose)**

**Details:**
- **Rows:** 60
- **Repository:** goose (Clojure job queue)
- **Columns:** `id, repository, commit_id, question, reference_answer`
- **Label coverage:** 100% have reference answers

**Example reference answer:**
```
5 threads default; consumed in worker defaults. 
refs: src/goose/defaults.clj:6; src/goose/worker.clj:42-44
```

**Strengths:**
- ✅ Expert-written reference answers with code references
- ✅ Structured format: claim + file path pointers
- ✅ Can be used for fact-based evaluation (answer completeness, evidence accuracy)
- ✅ Domain-specific deep questions about Goose internals

**Limitations:**
- ❌ **Not human judgment labels:** Reference answers are not Pass/Fail verdicts
- ❌ Cannot directly validate judge without manual Pass/Fail labeling of model outputs against references
- ❌ Only covers 1 repository (goose), not generalizable
- ❌ No difficulty levels or failure mode tags

**Use case:**
- Good for **answer quality evaluation** (compare model output to reference)
- Good for **RAG retrieval testing** (can model find the referenced files?)
- **Not suitable for judge calibration** (need human verdicts, not just reference answers)

---

## Critical Gaps Summary

### Immediate Blockers

| Gap | Current State | Target | Blocker For |
|-----|--------------|--------|-------------|
| **Human labels (total)** | 27 | ~100 | Error analysis saturation |
| **Failure examples** | 1 | ~50 | Judge validation |
| **Pass examples** | 24 | ~50 | Judge validation |
| **Pass/Fail balance** | 24:1 | ~1:1 | Judge calibration |
| **Train/test split** | None | 60/20/20 | Avoiding overfitting |
| **Sampling strategy** | Ad-hoc | Stratified | Failure mode coverage |

### Data Quality Issues

1. **Only 22.1% of dataset is labeled** (27/122)
   - 95 rows are unlabeled "dead weight"
   - Unclear why these 95 exist if not going to be labeled

2. **Labeled set is not representative:**
   - Skewed toward specific repos (e.g., pi-mono: 4/4 labeled, grpo-trainer: 0/45 labeled)
   - No evidence of stratification by failure mode or complexity

3. **No documented labeling rubric:**
   - Inconsistent labeling (some rows have all 4 labels, some only 1-2)
   - No inter-rater agreement process
   - Risk of label noise

4. **No progressive annotation:**
   - All 27 labels appear to be from a single labeling session
   - No iterative refinement based on error analysis

---

## Recommendations

### Immediate (High Priority)

#### 1. Expand Labeled Dataset to Minimum Viable Size

**Goal:** Reach ~100 labeled examples with balanced Pass/Fail distribution

**Action plan:**
1. **Run error analysis first** (see `error-analysis` skill):
   - Review latest eval results (`eval_2026-02-09_13-44-46-800.csv`, 32 rows)
   - Categorize failures by type (e.g., missing evidence, broken links, incomplete answers)
   - Identify 5-7 recurring failure modes

2. **Stratified sampling for next 73 labels:**
   - Sample 50 examples likely to FAIL (based on error analysis)
   - Sample 23 examples likely to PASS (to balance with existing 24)
   - Ensure coverage of:
     - All major failure modes
     - All major repos (goose, grpo-trainer, git, pi-mono)
     - All question types (what/how/why/yes-no)

3. **Label in batches:**
   - Batch 1: 30 examples (calibration set for initial judge refinement)
   - Check saturation: are new failure modes still appearing?
   - Batch 2: 30 examples (expand coverage based on saturation analysis)
   - Batch 3: 13 examples (fill gaps, balance distribution)

**Effort estimate:** ~8-10 hours for 73 labels (6-8 min per example)

---

#### 2. Create Train/Dev/Test Split

**Goal:** Enable proper judge calibration without overfitting

**Action plan:**
1. **Wait until you have 100 labeled examples**
2. **Split as follows:**
   - **Calibration (60%):** 60 examples for iterative judge prompt refinement
   - **Validation (20%):** 20 examples for comparing judge prompt variants
   - **Test (20%):** 20 examples NEVER seen during judge development (final eval only)

3. **Document split:**
   - Create `ask-forge-eval-dataset-calibration.csv`
   - Create `ask-forge-eval-dataset-validation.csv`
   - Create `ask-forge-eval-dataset-test.csv`
   - Add split strategy to README

**Why:**
- Prevents overfitting judge to specific examples
- Enables honest evaluation of judge accuracy
- Standard ML practice for any learned component (LLM judge = learned)

---

#### 3. Document Labeling Rubric

**Goal:** Ensure consistent, high-quality labels

**Action plan:**
1. **Create `docs/labeling-guide.md`** with:
   - Rubric for each label dimension (is_answer_relevant, is_evidence_supported, etc.)
   - 5 examples per label value (Pass, Fail, Edge cases)
   - Decision tree for ambiguous cases
   - Inter-rater agreement target (>85%)

2. **Test rubric:**
   - Have 2 labelers independently label 10 examples
   - Measure agreement (Cohen's kappa)
   - Refine rubric until agreement >85%

3. **Apply rubric consistently:**
   - Reference guide during all labeling
   - Track which examples are ambiguous (flag for review)

**Effort estimate:** ~2-3 hours to create guide, ~1 hour for IRR testing

---

### Short-term (Medium Priority)

#### 4. Analyze and Expand Failure Coverage

**Goal:** Ensure test set covers all critical failure modes

**Action plan:**
1. **Run failure taxonomy analysis** (see `error-analysis` skill):
   - Cluster failures from latest eval run by root cause
   - Example categories:
     - Missing evidence (no code citations)
     - Broken links (incorrect URLs/line numbers)
     - Incomplete answers (partial coverage of question)
     - Hallucinated claims (unsupported by codebase)

2. **Check coverage:**
   - Map failure categories to existing labeled examples
   - Identify under-represented failure modes

3. **Generate targeted test cases:**
   - Use `generate-synthetic-data` skill to create dimension-based samples
   - Example dimensions:
     - `question_type`: [what, how, why, yes/no]
     - `repo_complexity`: [small, medium, large]
     - `expected_failure_mode`: [missing_evidence, broken_links, hallucination]

**Reference:** `/Users/kiran/.pi/agent/skills/evals-skills/skills/generate-synthetic-data/SKILL.md`

---

#### 5. Convert Reference Answers to Human Judgments

**Goal:** Leverage goose-eval-50.csv reference answers for judge validation

**Action plan:**
1. **Run ask-forge against goose-eval-50.csv questions**
2. **Compare model outputs to reference answers**
3. **Manually label each as Pass/Fail:**
   - Pass: Model answer matches reference (factually correct + complete)
   - Fail: Model answer contradicts reference, misses key points, or hallucinates

4. **Result:** 60 additional labeled examples (with known ground truth)
5. **This gives you:** ~87 total labeled examples (27 existing + 60 goose)

**Effort estimate:** ~4-6 hours (running evals + labeling)

**Why this helps:**
- Reference answers provide clear ground truth for Pass/Fail
- Goose questions are deep/complex, likely to trigger failures
- Increases failure example count significantly

---

#### 6. Implement Systematic Sampling Strategy

**Goal:** Replace ad-hoc sampling with principled approach

**Action plan:**
1. **Define sampling dimensions:**
   - Repository (small/medium/large by file count)
   - Question type (what/how/why/yes-no/explain)
   - Anticipated difficulty (simple fact lookup vs complex reasoning)
   - Failure mode hypothesis (if any)

2. **Create stratified sample:**
   - Ensure each dimension is represented proportionally
   - Example: if 40% of questions are "what" questions, 40% of labeled set should be "what"

3. **Document sampling in metadata:**
   - Add columns: `repo_size`, `question_type`, `difficulty_estimate`, `failure_mode_tag`
   - This enables future stratified analysis (e.g., "judge accuracy on complex questions")

**Reference:** `/Users/kiran/.pi/agent/skills/evals-skills/skills/generate-synthetic-data/SKILL.md`

---

### Long-term (Maintenance)

#### 7. Establish Continuous Labeling Process

**Goal:** Keep labeled dataset growing as pipeline evolves

**Action plan:**
1. **After each eval run:**
   - Review top 10 failures
   - Add 5-10 to labeled dataset (focusing on new failure modes)

2. **Monthly review:**
   - Check label distribution balance
   - Identify gaps in coverage
   - Expand test set to maintain ~100 labeled examples

3. **Track label provenance:**
   - Add `label_source` column: [manual, error_analysis, synthetic, production_feedback]
   - Enables analysis of which sources yield highest-quality labels

---

#### 8. Validate Judge Against Labeled Data

**Goal:** Measure and improve judge accuracy

**Action plan:**
1. **Once you have 100 labeled examples:**
   - Run judge on calibration set (60 examples)
   - Compare judge verdicts to human labels
   - Calculate metrics:
     - Precision (% of judge "Fail" that are true failures)
     - Recall (% of true failures caught by judge)
     - F1 score (harmonic mean of precision/recall)
     - Cohen's kappa (agreement beyond chance)

2. **Iterate on judge prompt:**
   - Fix systematic errors (e.g., judge too lenient on evidence)
   - Re-run on validation set (20 examples)
   - Repeat until F1 >0.85

3. **Final test:**
   - Run judge on test set (20 examples) ONCE
   - Report final accuracy (this is honest estimate, not overfit)

**Reference:** `/Users/kiran/.pi/agent/skills/evals-skills/skills/validate-evaluator/SKILL.md`

---

## Comparison to Best Practices

### What the `validate-evaluator` skill recommends:

| Best Practice | ask-forge Current State | Gap |
|--------------|------------------------|-----|
| ✅ ~50 Pass examples | ✅ 24 Pass examples | 🔴 Need 26 more |
| ✅ ~50 Fail examples | 🔴 1 Fail example | 🔴 Need 49 more |
| ✅ Balanced distribution | 🔴 24:1 Pass/Fail | 🔴 Extreme imbalance |
| ✅ Train/test split | ❌ No split | 🔴 Missing |
| ✅ Documented rubric | ❌ No rubric | 🔴 Missing |
| ✅ Inter-rater agreement | ❌ Not measured | 🔴 Missing |

### What the `error-analysis` skill recommends:

| Best Practice | ask-forge Current State | Gap |
|--------------|------------------------|-----|
| ✅ ~100 labeled traces | 🟡 27 labeled examples | 🔴 Need 73 more |
| ✅ Failure taxonomy | ❌ Not documented | 🔴 Missing |
| ✅ Saturation check | ❌ Not performed | 🔴 Missing |
| ✅ Stratified sampling | ❌ Ad-hoc sampling | 🔴 Missing |

### What the `generate-synthetic-data` skill recommends:

| Best Practice | ask-forge Current State | Gap |
|--------------|------------------------|-----|
| ✅ Dimension-based sampling | ❌ No documented dimensions | 🔴 Missing |
| ✅ Targeted failure coverage | ❌ Random sampling | 🔴 Missing |
| ✅ Synthetic data for edge cases | ❌ Not used | 🟡 Optional |

---

## Positive Findings

Despite critical gaps, some strengths exist:

✅ **Good foundation:**
- 122-row base dataset is a decent starting point
- 27 labeled examples show labeling is feasible
- Diverse repo coverage (23 repos)

✅ **Reference answer dataset (goose-eval-50.csv):**
- High-quality reference answers for 60 questions
- Can be converted to human judgments with effort
- Domain-specific depth (goose internals)

✅ **Eval infrastructure in place:**
- Judge system running and producing verdicts
- CSV-based workflow is simple and inspectable
- Viewer tool exists for result exploration

✅ **Some label diversity:**
- `is_evidence_supported` has 7 Fail / 13 Pass (more balanced than overall)
- `misc_feedback` captures qualitative observations
- Shows understanding of multi-dimensional evaluation

---

## Next Steps (Prioritized Roadmap)

### Week 1: Error Analysis + Targeted Labeling
1. ✅ **Run error analysis** on latest eval results (32 rows)
   - Categorize failures by type
   - Document failure taxonomy
2. ✅ **Label 30 examples strategically:**
   - Focus on failure modes from error analysis
   - Aim for 15 Pass / 15 Fail to start balancing dataset

### Week 2: Expand to Minimum Viable Dataset
3. ✅ **Run ask-forge on goose-eval-50.csv**
4. ✅ **Label goose outputs** (60 examples with reference answers as ground truth)
   - This gets you to ~87 total labeled (27 + 60)
5. ✅ **Label 13 more from main dataset** to reach 100 total
   - Fill gaps in failure mode coverage

### Week 3: Split + Validate
6. ✅ **Create train/dev/test split** (60/20/20)
7. ✅ **Run judge calibration** on calibration set
   - Measure precision/recall
   - Iterate on judge prompt if F1 <0.85
8. ✅ **Final test** on test set (report honest accuracy)

### Week 4: Documentation + Process
9. ✅ **Document labeling rubric** in `docs/labeling-guide.md`
10. ✅ **Document sampling strategy** in README
11. ✅ **Establish continuous labeling process** for future evals

---

## Appendix: Dataset Inventory

### Primary Datasets

| File | Rows | Columns | Labels? | Purpose |
|------|------|---------|---------|---------|
| `ask-forge-eval-dataset.csv` | 122 | 8 (4 label cols) | 27/122 | Main dataset with sparse labels |
| `ask-forge-eval-dataset-test.csv` | 122 | 4 (no labels) | 0/122 | Base dataset for running evals |
| `ask-forge-eval-dataset-selected.csv` | 15 | 4 (no labels) | 0/15 | Subset (purpose unclear) |
| `tmp/eval/goose-eval-50.csv` | 60 | 5 (reference_answer) | 60/60* | Expert reference answers |
| `tmp/eval/grpo-trainer-eval.csv` | 50 | 4 (no labels) | 0/50 | Unlabeled dataset |

\* Reference answers, not human judgment labels

### Eval Results

| File | Rows | Purpose |
|------|------|---------|
| `tmp/eval/reports/eval_2026-02-09_13-44-46-800.csv` | 32 | Latest eval run (judge verdicts) |
| `scripts/eval/sample-run-current.csv` | ? | Sample eval output |
| `scripts/eval/sample-run-previous.csv` | ? | Sample eval output (baseline) |

### Failure Distribution in Latest Eval (32 rows)

| Criterion | Pass | Fail | Fail % |
|-----------|------|------|--------|
| `is_answer_complete` | 29 | 3 | 9% |
| `is_evidence_supported` | 22 | 10 | 31% |
| `is_evidence_linked` | 7 | 25 | 78% 🔴 |
| `is_reasoning_sound` | 32 | 0 | 0% ⚠️ |

**Key insight:** Evidence linking is the dominant failure mode (78%), yet the labeled dataset has only 1 failure example. This is a critical mismatch.

---

## References

- Error Analysis Skill: `/Users/kiran/.pi/agent/skills/evals-skills/skills/error-analysis/SKILL.md`
- Validate Evaluator Skill: `/Users/kiran/.pi/agent/skills/evals-skills/skills/validate-evaluator/SKILL.md`
- Generate Synthetic Data Skill: `/Users/kiran/.pi/agent/skills/evals-skills/skills/generate-synthetic-data/SKILL.md`
- Write Judge Prompt Skill: `/Users/kiran/.pi/agent/skills/evals-skills/skills/write-judge-prompt/SKILL.md`

---

## Conclusion

The ask-forge eval pipeline has a **severe labeled data deficit**. While infrastructure exists (122-row dataset, judge system, eval runner), only **27 examples are labeled** with an **extreme 24:1 Pass/Fail imbalance**. This blocks both error analysis saturation (~100 labels needed) and judge validation (~50 Pass + ~50 Fail needed).

**Immediate action required:**
1. Run error analysis on latest eval results (32 rows)
2. Label 30 examples targeting identified failure modes (15 Pass / 15 Fail)
3. Convert goose-eval-50 reference answers to human judgments (60 examples)
4. This gets you to ~87 total labeled examples
5. Label 13 more to reach minimum viable dataset (100 total, balanced)

Without this foundational labeled data, the judge cannot be validated, error modes cannot be tracked, and regression detection remains unreliable.
