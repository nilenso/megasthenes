# Pipeline Hygiene Audit Report
**Project:** ask-forge  
**Audit Date:** 2026-03-12  
**Area:** Pipeline Hygiene  
**Auditor:** Claude Code (pi-agent worker)

---

## Executive Summary

The ask-forge eval pipeline shows **active development** (36 commits to eval/prompt code) but **poor hygiene practices**. Critical changes to both the judge model and system prompt were made 18 days ago without re-running evaluations. There is **no CI automation, no documented re-evaluation triggers, and no periodic evaluator validation**.

**Status:** 🔴 **CRITICAL HYGIENE PROBLEMS**

---

## Critical Timeline Gap

### Last Eval Run
- **Date:** February 9, 2026 (32 rows evaluated)
- **Files:** `tmp/eval/reports/eval_2026-02-09_13-44-46-800.csv`
- **Time since last eval:** **31 days** (as of March 12, 2026)

### Major Changes Since Last Eval (Not Re-Evaluated)

#### February 19-20, 2026 (10-11 days after last eval)
1. ✅ **Judge criterion change** (commit `0fb4ad7`):
   - Replaced `is_answer_relevant` → `is_answer_complete`
   - **Impact:** Changes what counts as a passing answer
   - **Re-eval status:** ❌ NOT re-evaluated

2. ✅ **New judge criterion added** (commit `a4b1610`):
   - Added `is_reasoning_sound` verdict
   - **Impact:** New failure mode detection (currently 0/32 failures - suspicious)
   - **Re-eval status:** ❌ NOT re-evaluated

3. ✅ **Tool output format change** (commit `acff019`):
   - Added line numbers to `read` tool output
   - **Impact:** Could improve linking accuracy
   - **Re-eval status:** ❌ NOT re-evaluated

4. ✅ **Judge model upgrade** (commit `78d212d`):
   - Changed judge from previous model to `anthropic/claude-sonnet-4.6`
   - **Impact:** Different judge = different verdicts (calibration lost)
   - **Re-eval status:** ❌ NOT re-evaluated

#### February 27, 2026 (18 days after last eval)
5. ✅ **MAJOR system prompt rewrite** (5 separate commits):
   - `f67426e`: Rewrite tool usage guidelines
   - `d9c22e3`: Rewrite response content guidelines
   - `4a12a64`: Rewrite evidence/linking guidelines
   - `c830d28`: Add security and safety guidelines
   - `0cdb347`: Remove qualitative judgments guideline
   - **Impact:** Fundamentally changes model behavior
   - **Re-eval status:** ❌ NOT re-evaluated

### Severity Assessment

**🔴 CRITICAL:** The system prompt rewrites on Feb 27 are architecturally significant changes. Running evals on Feb 9 data with a Feb 27 prompt is **meaningless** — you're evaluating a different system.

**🔴 CRITICAL:** Changing the judge model without re-running calibration means all future comparisons to Feb 9 baselines are invalid.

**Risk:** The team may be making decisions (e.g., "linking improved from 22% to 40%") based on comparisons between incompatible eval runs.

---

## Findings by Question

### 1. Is error analysis re-run after significant changes?

**Status:** ❌ **NO**

**Evidence:**
- 36 commits to `scripts/eval/` and `src/prompt.ts` between Feb 11 - Feb 27
- Last eval: Feb 9, 2026
- Gap: **18 days** with major changes (judge model upgrade, prompt rewrites)
- No eval runs found after Feb 27 prompt changes

**Git commit frequency analysis:**
```bash
# Eval/prompt changes by date (Feb 11 - Feb 27)
Feb 11: 1 commit (reorganize project)
Feb 13: 1 commit (fix judge model name)
Feb 16: 1 commit (refactor eval script)
Feb 17: 2 commits (add link metrics, system prompt extraction)
Feb 18: 7 commits (refactor eval script, add report fields)
Feb 19: 3 commits (add is_reasoning_sound, change to is_answer_complete, line numbers)
Feb 20: 4 commits (upgrade judge model, refactor viewer, fix lint)
Feb 27: 8 commits (5 prompt rewrites, eval viewer improvements)

Total: 27 commits in 16 days = 1.7 commits/day
Eval runs: 0 in this period
```

**Problem:**
- High velocity of changes WITHOUT corresponding eval runs
- No documented trigger for when to re-run evals
- Changes accumulate without validation

**Impact:**
- Unknown if changes improved/degraded quality
- Cannot attribute improvements to specific changes
- Risk of shipping regressions

---

### 2. Are evaluators maintained and periodically re-validated?

**Status:** ❌ **NO EVIDENCE OF MAINTENANCE**

**Evidence:**
- ❌ No documented re-validation schedule
- ❌ No calibration runs after judge model change (Feb 20)
- ❌ No gold-standard labeled dataset for judge validation
- ❌ No documented judge accuracy metrics (precision/recall per criterion)
- ❌ No inter-rater reliability checks (human vs judge agreement)
- ✅ Judge prompt has clear rubrics (good foundation, but not validated)

**Specific judge maintenance issues:**

#### A. Judge model change without re-calibration (commit `78d212d`)
```typescript
// Before (implicit, older model)
const JUDGE_MODEL_NAME = "anthropic/claude-sonnet-4.6"; // NEW model as of Feb 20

// Problem: No re-validation against previous judge verdicts
// Question: Does Sonnet 4.6 agree with previous model on same traces?
// Answer: Unknown — no calibration run performed
```

**Impact:**
- All comparisons between Feb 9 (old judge) and future runs (new judge) are **invalid**
- Metrics may shift due to judge changes, not actual quality changes
- No way to know if metric improvements are real or judge drift

#### B. New criterion with 0% failure rate (suspicious)

From `tmp/error-analysis-audit.md`:
```
is_reasoning_sound: 0/32 failures (0%)
```

**Questions to investigate:**
1. Is the rubric too lenient? (needs manual review of 10 traces)
2. Is the test set too easy? (needs harder examples)
3. Is this criterion redundant with existing checks?

**Current state:** Criterion added Feb 19, never validated, never failed.

#### C. Dataset has never been refreshed

```bash
$ git log --oneline --all -- ask-forge-eval-dataset*.csv
(no output)
```

**Evidence:**
- No git history for dataset files = never updated in version control
- Dataset metadata:
  - `ask-forge-eval-dataset.csv`: 21K (134 rows)
  - Last modified: Feb 18, 2026 (git-tracked file date)
  - No documented refresh schedule

**Problem:**
- Dataset may not cover new failure modes discovered in production
- No stratified sampling to target known weaknesses
- Risk of overfitting eval criteria to static dataset

---

### 3. Stale comments and misleading code

**Status:** ❌ **STALE COMMENT FOUND**

**Evidence:**

#### Line 10 in `scripts/eval/run-eval.ts`:
```typescript
// =============================================================================
// LLM Judge (commented out — currently using link validation instead)
// =============================================================================
```

**Reality:** Judge code IS being used (lines 17-85), NOT commented out.

**Timeline of confusion:**
- This comment may have been accurate at some point
- Current code shows judge is fully operational:
  ```typescript
  const judgeResult = await judge(question, askResult.response); // Line 193
  console.log(`  ⚖ Judge: complete=${judgeResult.is_answer_complete}...`); // Line 203
  ```
- Results CSV contains all judge verdicts (`is_answer_complete`, `is_evidence_supported`, etc.)

**Impact:**
- Misleading for new developers ("why is this commented out?")
- Suggests lack of code review or attention to documentation hygiene
- Indicates technical debt accumulation

**Fix:** Remove or correct the comment.

---

### 4. Eval-related commit frequency and update patterns

**Status:** 🟡 **ACTIVE BUT UNSTRUCTURED**

**Commit analysis:**
```bash
$ git log --all --format="%ai" -- scripts/eval/ src/prompt.ts | wc -l
36 commits (Feb 11 - Feb 27, 2026)

Breakdown:
- scripts/eval/: 18 commits
- src/prompt.ts: 18 commits (prompt extracted Feb 17, then heavily revised)
```

**Patterns observed:**

✅ **High velocity:** 1.7 commits/day over 16-day period = active development  
✅ **Branch discipline:** Multiple feature branches (`refactor/eval-judge-and-read-tool`, `feat/eval-report-fields`)  
✅ **Reactive iteration:** Criterion changes based on observations (e.g., `is_answer_relevant` → `is_answer_complete`)  

❌ **No eval runs during iteration:** 0 eval runs between Feb 9 - March 12  
❌ **No commit patterns for "eval run after change":** No `chore: eval run after X change` commits  
❌ **Changes batched without validation:** 27 commits before next eval run  

**Git branches show iteration:**
```
chore/eval-improvements
feat/eval-report-fields
fix/eval-viewer-improvements
refactor/eval-judge-and-read-tool
refactor/eval-script-and-judge-prompt
```

**Problem:** Iteration is happening, but validation is not integrated into the workflow.

---

### 5. CI integration and automated eval runs

**Status:** ❌ **NO EVAL AUTOMATION**

**Evidence:**

#### CI configuration (`.github/workflows/ci.yml`)
```yaml
jobs:
  ci:
    steps:
      - run: bun install
      - run: bunx biome check .  # Lint + format
      - run: bun test              # Unit tests
      - run: bun build ...         # Build
      - run: bunx jsr publish --dry-run
```

**What's missing:**
- ❌ No eval runs on PR
- ❌ No eval runs on main branch merge
- ❌ No scheduled eval runs (nightly, weekly)
- ❌ No regression detection (compare to baseline)
- ❌ No metric tracking over time
- ❌ No eval status badges in README

**Contrast with mature eval practices:**

| Practice | Best-in-class | ask-forge |
|----------|--------------|-----------|
| Eval on every PR | ✅ (subset) | ❌ None |
| Eval on main merge | ✅ (full suite) | ❌ None |
| Baseline comparison | ✅ (auto-detect regressions) | ❌ Manual |
| Scheduled runs | ✅ (nightly/weekly) | ❌ None |
| Cost/latency tracking | ✅ (in CI metrics) | ❌ Manual CSV review |
| Metric history | ✅ (time-series charts) | ❌ CSV files in tmp/ |

**Why this matters:**

Without CI integration:
1. **Regressions ship silently** — No one notices when quality drops
2. **Iteration is slow** — Manual eval runs = fewer validations = slower learning
3. **Metrics are invisible** — CSVs in `tmp/` don't surface trends
4. **No accountability** — Easy to skip evals under deadline pressure

**Example risk scenario:**
```
Developer A: "I rewrote the prompt to fix linking issues."
Developer B: "Did you run evals?"
Developer A: "No, I'll do it later." [never happens]
[Linking actually got worse, discovered 2 weeks later]
```

---

## Supporting Evidence

### Eval result files (all from Feb 8-9):
```bash
$ ls -lh tmp/eval/reports/*.csv
-rw-r--r--  10K  eval_2026-02-08_07-36-58-396.csv
-rw-r--r--  16K  eval_2026-02-08_07-49-37-959.csv
-rw-r--r-- 101K  eval_2026-02-08_10-35-22-300.csv
-rw-r--r--  11K  eval_2026-02-08_11-13-54-279.csv
-rw-r--r-- 105K  eval_2026-02-09_13-44-46-800.csv  ← Latest
```

### Datasets (no version control history):
```bash
$ ls -lh ask-forge-eval-dataset*.csv
-rw-r--r--  2.4K  ask-forge-eval-dataset-selected.csv  (15 rows)
-rw-r--r--   19K  ask-forge-eval-dataset-test.csv      (unknown)
-rw-r--r--   21K  ask-forge-eval-dataset.csv           (134 rows)
```

### Key commits requiring re-evaluation:
1. **0fb4ad7** (Feb 19): Judge criterion change (`is_answer_relevant` → `is_answer_complete`)
2. **a4b1610** (Feb 19): Added `is_reasoning_sound` criterion
3. **78d212d** (Feb 20): Judge model upgrade (sonnet 4.6)
4. **f67426e - 0cdb347** (Feb 27): System prompt rewrites (5 commits)

---

## Comparison to Best Practices

### What the `eval-audit` skill recommends:

**Error analysis:**
- ✅ Eval infrastructure exists (good foundation)
- ❌ No systematic error analysis (see separate audit: `tmp/error-analysis-audit.md`)
- ❌ No documented failure taxonomy

**Evaluator validation:**
- ✅ Judge prompt has clear rubrics
- ❌ No calibration against gold-standard labels
- ❌ No inter-rater reliability metrics
- ❌ No validation after judge model change

**Pipeline hygiene:**
- ❌ No re-evaluation after significant changes
- ❌ No CI automation
- ❌ No scheduled maintenance
- ❌ No documented triggers for re-running evals

**Metric tracking:**
- ✅ Rich metadata in eval CSVs (token usage, tool calls, etc.)
- ❌ No time-series tracking
- ❌ No regression detection
- ❌ No baseline comparison tooling

---

## Recommendations

### CRITICAL (Do Immediately)

#### 1. Re-run full eval suite ASAP
**Why:** 31 days + major prompt changes = current metrics are stale and meaningless

**Action:**
```bash
cd /Users/kiran/work/ask-forge
bun run scripts/eval/run-eval.ts ask-forge-eval-dataset.csv
```

**Expected outcome:**
- New baseline with current judge model + current prompts
- Compare to Feb 9 results to understand impact of changes
- Document any metric shifts and their likely causes

**Time estimate:** ~2-3 hours (134 rows × 1-2 min/row)

#### 2. Fix stale comment (2 minutes)
**File:** `scripts/eval/run-eval.ts:10`

**Current:**
```typescript
// LLM Judge (commented out — currently using link validation instead)
```

**Fix option A (accurate):**
```typescript
// LLM Judge — evaluates answers on 4 criteria: completeness, evidence support, linking, reasoning
```

**Fix option B (remove):**
Just delete the misleading comment block.

#### 3. Establish "eval after major change" policy

**Document in README or CONTRIBUTING.md:**
```markdown
## When to Re-run Evals

Run full eval suite after:
- ✅ System prompt changes (ask or judge)
- ✅ Judge model changes
- ✅ Judge criterion changes (add/remove/modify rubrics)
- ✅ Tool output format changes (e.g., adding line numbers)
- ✅ Major codebase refactors

Run targeted eval subset (15-30 examples) after:
- ✅ Bug fixes that could affect answer quality
- ✅ Dependency upgrades (e.g., pi-ai, LLM SDK)
```

**Enforcement:**
- Add to PR checklist template
- Require eval run evidence in PR descriptions for prompt/judge changes

---

### HIGH PRIORITY (This Sprint)

#### 4. Add CI eval automation

**Minimum viable automation:**

Create `.github/workflows/eval-pr.yml`:
```yaml
name: Eval on PR

on:
  pull_request:
    paths:
      - 'src/prompt.ts'
      - 'scripts/eval/**'
      - 'src/index.ts'
      - 'src/config.ts'

jobs:
  eval-subset:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      
      # Run eval on small subset (15 examples)
      - name: Run eval subset
        run: bun run scripts/eval/run-eval.ts ask-forge-eval-dataset-selected.csv
        env:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
      
      # Upload results as artifact
      - uses: actions/upload-artifact@v3
        with:
          name: eval-results
          path: tmp/eval/reports/*.csv
```

**Why this matters:**
- Catches regressions before merge
- Makes eval runs routine (not optional)
- Builds metric history over time

**Time estimate:** 1-2 hours to implement and test

#### 5. Create eval run documentation

**Create `docs/eval-guide.md`:**
```markdown
# Eval Guide

## Running Evals Locally

### Full eval suite (134 examples)
bun run scripts/eval/run-eval.ts ask-forge-eval-dataset.csv

### Quick validation (15 examples)
bun run scripts/eval/run-eval.ts ask-forge-eval-dataset-selected.csv

## Interpreting Results

### Key metrics
- is_answer_complete: Should be >90%
- is_evidence_supported: Should be >85%
- is_evidence_linked: Should be >75% (currently 22% - known issue)
- is_reasoning_sound: Should be >95%

### Viewing results
bun run web (port 3000)
# Navigate to /eval-viewer

## When to Re-run Evals
[See section from recommendation #3]

## Debugging Failures
1. Open eval viewer
2. Filter by failing criterion
3. Review misc_feedback for patterns
4. Group similar failures into error categories
5. File issues with examples
```

**Time estimate:** 1 hour

#### 6. Validate `is_reasoning_sound` criterion

**Problem:** 0/32 failures (0%) suggests rubric may be too lenient or test set too easy

**Action:**
1. Manually review 10 traces from Feb 9 results
2. Apply `is_reasoning_sound` rubric strictly
3. Document:
   - Can you find failures the judge missed? → Rubric too lenient
   - Cannot find any reasoning errors? → Test set too easy
4. Refine rubric or expand dataset accordingly

**Time estimate:** 1-2 hours

---

### MEDIUM PRIORITY (This Month)

#### 7. Re-calibrate judge after model change

**Problem:** Changed to Sonnet 4.6 on Feb 20 without validation

**Action:**
1. Create gold-standard labeled set (50-100 examples with human labels)
2. Run new judge on same examples
3. Measure agreement (precision/recall per criterion)
4. Iterate on rubric until agreement >85%
5. Document calibration results

**Reference:** `/Users/kiran/.pi/agent/skills/evals-skills/skills/validate-evaluator/SKILL.md`

**Time estimate:** 4-6 hours

#### 8. Add baseline comparison tooling

**Goal:** Automatically detect regressions vs. baseline

**Implementation options:**

**Option A: Simple bash script**
```bash
#!/bin/bash
# scripts/eval/compare-to-baseline.sh
BASELINE="tmp/eval/reports/baseline.csv"
CURRENT="$1"

python3 - <<EOF
import pandas as pd
baseline = pd.read_csv("$BASELINE")
current = pd.read_csv("$CURRENT")

for metric in ['is_answer_complete', 'is_evidence_supported', 'is_evidence_linked', 'is_reasoning_sound']:
    baseline_pct = (baseline[metric] == 'yes').mean() * 100
    current_pct = (current[metric] == 'yes').mean() * 100
    delta = current_pct - baseline_pct
    
    symbol = "🔴" if delta < -5 else "🟡" if delta < 0 else "🟢"
    print(f"{symbol} {metric}: {current_pct:.1f}% ({delta:+.1f}%)")
EOF
```

**Usage:**
```bash
bun run scripts/eval/run-eval.ts dataset.csv
scripts/eval/compare-to-baseline.sh tmp/eval/reports/eval_<timestamp>.csv
```

**Time estimate:** 2-3 hours

#### 9. Refresh eval dataset

**Problem:** Dataset has never been updated (no git history)

**Action:**
1. Review production logs for new question types
2. Add examples covering recent failure modes (e.g., evidence linking)
3. Stratify by difficulty/domain if needed
4. Document selection criteria
5. Commit to git with version tag (v2)

**Reference:** `/Users/kiran/.pi/agent/skills/evals-skills/skills/generate-synthetic-data/SKILL.md`

**Time estimate:** 3-4 hours

---

### LOW PRIORITY (Nice to Have)

#### 10. Add scheduled eval runs

**Option:** GitHub Actions scheduled workflow

```yaml
name: Nightly Eval

on:
  schedule:
    - cron: '0 2 * * *'  # 2 AM UTC daily

jobs:
  nightly-eval:
    runs-on: ubuntu-latest
    steps:
      # ... similar to eval-pr.yml but full dataset
      - run: bun run scripts/eval/run-eval.ts ask-forge-eval-dataset.csv
      
      # Compare to baseline and post to Slack/Discord if regression
```

**Time estimate:** 2-3 hours (requires notification setup)

#### 11. Track metrics in time-series database

**Options:**
- Lightweight: Append metrics to JSON file, visualize with Chart.js
- Heavy: Push to Prometheus/Grafana or LangSmith

**Time estimate:** 4-8 hours depending on approach

---

## Risk Assessment

### Current Risks

| Risk | Severity | Likelihood | Impact |
|------|----------|------------|---------|
| Shipping regressions without detection | 🔴 High | 🔴 High | Quality degradation goes unnoticed for weeks |
| Invalid metric comparisons (judge drift) | 🔴 High | 🔴 High | Decisions based on meaningless comparisons |
| Accumulating technical debt | 🟡 Medium | 🔴 High | Misleading code, undocumented assumptions |
| Eval runs become optional under pressure | 🟡 Medium | 🔴 High | Pipeline degrades during crunch time |
| Dataset staleness | 🟡 Medium | 🟡 Medium | Missing coverage for new failure modes |

### Mitigation Strategy

**Phase 1 (This Week):** Immediate fixes
- Re-run eval suite (establish new baseline)
- Fix stale comment
- Document "when to eval" policy

**Phase 2 (This Sprint):** Automation
- Add PR eval automation
- Create eval guide
- Validate `is_reasoning_sound` criterion

**Phase 3 (This Month):** Calibration & tooling
- Re-calibrate judge
- Add baseline comparison
- Refresh dataset

---

## Positive Findings

Despite hygiene issues, the eval pipeline has strong foundations:

✅ **Active development:** 36 commits in 16 days shows commitment  
✅ **Good tooling:** Eval runner, viewer, CSV export all functional  
✅ **Rich metadata:** Token usage, tool calls, broken link ratios captured  
✅ **Clear rubrics:** Judge prompt has detailed guidelines  
✅ **Reactive iteration:** Team responds to observations (e.g., criterion changes)  
✅ **Branch discipline:** Feature branches for eval work  

**These are solvable problems.** The infrastructure is good; the missing piece is process discipline.

---

## Comparison: ask-forge vs. Industry Standards

| Practice | Industry Standard | ask-forge | Gap |
|----------|------------------|-----------|-----|
| Eval automation | ✅ CI on every PR | ❌ Manual only | 🔴 Critical |
| Re-eval after changes | ✅ Required | ❌ Optional/skipped | 🔴 Critical |
| Judge calibration | ✅ Validated quarterly | ❌ Never | 🔴 Critical |
| Baseline tracking | ✅ Time-series metrics | ❌ CSV files | 🟡 Medium |
| Dataset refresh | ✅ Monthly/quarterly | ❌ Never | 🟡 Medium |
| Scheduled runs | ✅ Nightly/weekly | ❌ None | 🟢 Low |
| Error taxonomy | ✅ Documented | ❌ Ad-hoc | 🔴 Critical (see separate audit) |

---

## Next Actions (Prioritized)

**This week:**
1. ✅ Run full eval suite (134 examples) to establish fresh baseline
2. ✅ Fix stale comment in `run-eval.ts:10`
3. ✅ Document "when to re-run evals" policy in README

**This sprint:**
4. ✅ Add PR eval automation (`.github/workflows/eval-pr.yml`)
5. ✅ Create `docs/eval-guide.md`
6. ✅ Validate `is_reasoning_sound` criterion (manual review)

**This month:**
7. ✅ Re-calibrate judge against human labels
8. ✅ Add baseline comparison script
9. ✅ Refresh eval dataset (add new failure examples)

**Long-term:**
10. 🔲 Scheduled nightly eval runs
11. 🔲 Metric time-series tracking

---

## References

- **Error Analysis Audit:** `tmp/error-analysis-audit.md` (separate report)
- **Eval Research:** `eval-research.md` (UX improvements planned)
- **Eval Scripts:** `scripts/eval/run-eval.ts`, `scripts/eval/csv.ts`
- **Judge Prompt:** `src/prompt.ts` (JUDGE_SYSTEM_PROMPT)
- **Eval Viewer:** `bun run web` → http://localhost:3000/eval-viewer
- **Skills:**
  - Error Analysis: `/Users/kiran/.pi/agent/skills/evals-skills/skills/error-analysis/SKILL.md`
  - Validate Evaluator: `/Users/kiran/.pi/agent/skills/evals-skills/skills/validate-evaluator/SKILL.md`
  - Generate Synthetic Data: `/Users/kiran/.pi/agent/skills/evals-skills/skills/generate-synthetic-data/SKILL.md`

---

## Appendix: Git Commit Summary (Feb 11-27)

**Eval script changes (18 commits):**
- Refactor: extract CSV parsing, simplify iteration
- Features: add tool_calls, files_read, broken_link_ratio tracking
- Features: add token usage to CSV and viewer
- Fixes: resolve merge conflicts, add table styles
- Viewer: collapsible sidebar, copy buttons, code/preview toggle

**Prompt changes (18 commits):**
- Feb 17: Extract system prompt to `src/prompt.ts`
- Feb 19: Add `is_reasoning_sound`, change to `is_answer_complete`
- Feb 27: **5 major rewrites**:
  - Tool usage guidelines
  - Response content guidelines
  - Evidence/linking guidelines
  - Security and safety guidelines
  - Remove qualitative judgments

**Judge changes (3 commits):**
- Feb 13: Fix model name format
- Feb 19: Add `is_reasoning_sound` criterion
- Feb 20: Upgrade to Sonnet 4.6

---

**End of Report**
