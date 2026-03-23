# Labeled Data Audit - Quick Summary

**Status:** 🔴 **CRITICAL ISSUES**  
**Date:** 2026-03-12

---

## The Problem in Numbers

| Metric | Current | Target | Gap |
|--------|---------|--------|-----|
| **Total labeled examples** | 27 | 100 | 🔴 Need 73 more |
| **Pass examples** | 24 | ~50 | 🟡 Need 26 more |
| **Fail examples** | 1 | ~50 | 🔴 Need 49 more |
| **Pass/Fail ratio** | 24:1 | ~1:1 | 🔴 Extreme imbalance |
| **Dataset labeled** | 22.1% | 100% | 🔴 77.9% unlabeled |

---

## Why This Matters

**You cannot validate your LLM judge without labeled data.**

- ❌ **Cannot measure judge accuracy** (need ~50 Pass + ~50 Fail examples)
- ❌ **Cannot identify failure modes** (need ~100 labeled examples for saturation)
- ❌ **Cannot track improvements** (need balanced test set for regression detection)
- ❌ **Cannot avoid overfitting** (need train/test split)

**Current state:** You're flying blind. Judge verdicts are unvalidated.

---

## Root Cause

1. **Ad-hoc labeling:** Only first ~27 rows have labels (convenience sampling, not strategic)
2. **No labeling process:** No rubric, no inter-rater agreement, no systematic review
3. **No train/test split:** All labeled data is mixed together
4. **No failure taxonomy:** Labels exist but failure modes are not categorized

---

## Quick Win: goose-eval-50.csv

**You already have 60 examples with reference answers!**

| Dataset | Rows | Type | Status |
|---------|------|------|--------|
| goose-eval-50.csv | 60 | Reference answers | ✅ Ready to convert |

**Action:** Run ask-forge on these 60 questions, then label outputs as Pass/Fail by comparing to reference answers.

**Effort:** ~4-6 hours  
**Benefit:** Gets you to 87 total labeled examples (27 existing + 60 goose)  
**Why it helps:** Reference answers make labeling fast + accurate

---

## 4-Week Roadmap to Fix This

### Week 1: Error Analysis + Quick Labeling (8 hours)
1. Run error analysis on latest eval (32 rows) → identify failure modes
2. Label 30 examples targeting those failures (15 Pass / 15 Fail)
3. **Result:** 57 labeled examples, more balanced

### Week 2: Leverage goose-eval-50 (6 hours)
4. Run ask-forge on goose-eval-50.csv questions
5. Label outputs by comparing to reference answers (60 examples)
6. **Result:** 117 labeled examples (exceeds minimum viable)

### Week 3: Split + Validate (8 hours)
7. Create train/dev/test split (70/15/15 from 100 examples)
8. Run judge calibration on train set
9. Measure precision/recall, iterate if F1 < 0.85
10. Final test on held-out test set
11. **Result:** Validated judge with known accuracy

### Week 4: Documentation + Process (4 hours)
12. Document labeling rubric in `docs/labeling-guide.md`
13. Document sampling strategy in README
14. Establish continuous labeling process
15. **Result:** Sustainable eval workflow

**Total effort:** ~26 hours spread over 4 weeks  
**Outcome:** Trustworthy eval system with validated judge

---

## Immediate Next Steps (Do This Now)

### Step 1: Review Latest Eval Results (30 min)
```bash
cd /Users/kiran/work/ask-forge
# Open latest eval in viewer
open scripts/eval/eval-viewer.html
# Drag tmp/eval/reports/eval_2026-02-09_13-44-46-800.csv into viewer
```

**Goal:** Identify top 3-5 failure patterns

### Step 2: Run Error Analysis (2 hours)
Follow the `error-analysis` skill:
```bash
# Read the skill
cat /Users/kiran/.pi/agent/skills/evals-skills/skills/error-analysis/SKILL.md

# Review 30 traces from latest eval
# Categorize failures:
# - Missing evidence (no citations)
# - Broken links (wrong URLs)
# - Incomplete answers (partial coverage)
# - Hallucinations (unsupported claims)
# - etc.
```

**Goal:** Document 5-7 recurring failure modes

### Step 3: Label 30 Strategic Examples (4 hours)
```bash
# Create stratified sample:
# - 15 examples likely to FAIL (based on error analysis)
# - 15 examples likely to PASS (to balance)

# Add labels to ask-forge-eval-dataset.csv:
# - is_answer_relevant
# - is_evidence_supported  
# - is_clear_and_readable
# - misc_feedback
```

**Goal:** Reach 57 labeled examples with better balance

---

## Key Insights from Data Analysis

### Failure Mode Mismatch 🔴

**Latest eval results show:**
- 78% failure rate on `is_evidence_linked` (25/32 failures)
- 31% failure rate on `is_evidence_supported` (10/32 failures)

**But labeled dataset has:**
- Only 1 overall failure example (!)
- No targeted coverage of linking failures

**Implication:** Your test set doesn't reflect actual failure distribution.

### Unlabeled Gold Mines

**Largest datasets are unlabeled:**
- grpo-trainer: 45 questions, 0 labeled
- goose: 38 questions, 0 labeled  
- git: 6 questions, 0 labeled

**Total unlabeled:** 95 rows (77.9% of dataset)

**Question:** Why do these exist if not being labeled? Consider prioritizing labeling for these.

### Repository Coverage is Good ✅

- 23 unique repositories
- Mix of domains (job queues, AI training, dev tools)
- Question types well-distributed (what/how/why)

**Strength:** Diversity is there, just need labels.

---

## Critical Decision Points

### Decision 1: Label Existing vs Generate New?

**Option A: Label the existing 95 unlabeled rows**
- ✅ Pro: Data already exists, questions are real
- ✅ Pro: Covers diverse repos
- ❌ Con: May not target specific failure modes
- ❌ Con: Random distribution (not stratified)

**Option B: Generate synthetic targeted examples**
- ✅ Pro: Can target specific failure modes
- ✅ Pro: Ensures balanced Pass/Fail distribution
- ❌ Con: Requires synthesis effort
- ❌ Con: May not reflect real user questions

**Recommendation:** **Hybrid approach**
1. Label goose-eval-50 (60 examples, reference answers make it fast)
2. Error analysis on latest eval → identify failure modes
3. Label 30 existing examples targeting those modes
4. If still gaps, generate synthetic for edge cases

### Decision 2: Train/Test Split Now or Later?

**Option A: Split now (with only 27 labeled)**
- ❌ Con: Too small for meaningful train/test (16 train / 5 val / 6 test)
- ❌ Con: Validation set would have 0-1 failures (not useful)

**Option B: Split after reaching 100 labeled**
- ✅ Pro: More meaningful split (60 train / 20 val / 20 test)
- ✅ Pro: Each set has sufficient failures for calibration
- ✅ Pro: Standard practice

**Recommendation:** **Wait until 100 labeled, then split 60/20/20**

### Decision 3: What to Do With Unlabeled 95 Rows?

**Option A: Keep them for future labeling**
- ✅ Pro: Preserves optionality
- ❌ Con: Dead weight in dataset (confusing)

**Option B: Archive to separate file**
- ✅ Pro: Cleaner dataset
- ✅ Pro: Makes labeled vs unlabeled explicit
- ❌ Con: Requires refactoring eval pipeline

**Recommendation:** **Keep for now, but document status**
- Add `labeled` boolean column to CSV
- Update README to explain labeled vs unlabeled split
- Prioritize labeling based on error analysis

---

## Reference Materials

### Skills to Read
1. **Error Analysis:** `/Users/kiran/.pi/agent/skills/evals-skills/skills/error-analysis/SKILL.md`
2. **Validate Evaluator:** `/Users/kiran/.pi/agent/skills/evals-skills/skills/validate-evaluator/SKILL.md`
3. **Generate Synthetic Data:** `/Users/kiran/.pi/agent/skills/evals-skills/skills/generate-synthetic-data/SKILL.md`

### Full Audit Report
- Detailed analysis: `tmp/eval/labeled-data-audit.md`

---

## Bottom Line

**Current state:** You have infrastructure (eval runner, judge, viewer) but no foundation (labeled data).

**What's blocking you:**
- Cannot validate judge accuracy → don't know if it's trustworthy
- Cannot track failure modes → don't know what to fix
- Cannot measure improvement → don't know if changes help

**How to fix it:**
1. ✅ Label goose-eval-50 outputs (60 examples, ~4-6 hours)
2. ✅ Run error analysis (30 traces, ~2 hours)  
3. ✅ Label 30 targeted examples (15 Pass / 15 Fail, ~4 hours)
4. ✅ Split into train/dev/test (60/20/20)
5. ✅ Validate judge and document accuracy

**Total effort:** ~26 hours over 4 weeks  
**Outcome:** Trustworthy eval system

---

**Start here:** Review `/Users/kiran/work/ask-forge/tmp/eval/reports/eval_2026-02-09_13-44-46-800.csv` for failure patterns.
