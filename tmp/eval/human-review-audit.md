# Human Review Process Audit — Ask Forge Eval Pipeline

**Auditor Focus Area:** Human Review Process  
**Date:** 2026-03-12  
**Project:** ask-forge @ `/Users/kiran/work/ask-forge`

---

## Executive Summary

❌ **CRITICAL**: The eval pipeline has **no active human review workflow**. A Flask-based review server with annotation UI existed but was completely removed (commit `feeb65b`, Feb 8, 2026). The current `eval-viewer.html` is a read-only comparison tool with **zero annotation or export capabilities**.

### Quick Status

| Aspect | Status | Severity |
|--------|--------|----------|
| Reviewer identification | ❌ Missing | **High** |
| Full trace visibility | ⚠️ Partial (collapsed) | Medium |
| Review interface quality | ⚠️ Read-only only | **Critical** |
| Annotation workflow | ❌ Deleted | **Critical** |
| Export/persistence | ❌ None | **High** |
| Labeling guidelines | ❌ None | **High** |

---

## Detailed Findings

### 1. Who is Reviewing Traces? (Domain Expert Involvement)

**Status:** ❌ **No evidence of systematic review process**

**Evidence:**
- **Dataset labels exist but provenance unclear:**
  - `ask-forge-eval-dataset.csv`: 122/135 rows (90%) have human labels
  - `tmp/eval/annotations_export.csv`: 4 annotation rows with feedback
  - **No metadata on WHO labeled these rows** (no reviewer_id, no timestamp, no expertise level)
  
- **No reviewer instructions or onboarding:**
  - Zero labeling guidelines or rubrics
  - No documentation of who should review or how
  - No evidence of domain expert recruitment

- **Historical context:**
  - Git history shows `review-server.py` existed (Jan 2026) for "human-in-the-loop feedback"
  - Server and all review templates **deleted** in commit `feeb65b` (Feb 8, 2026)
  - No replacement workflow documented

**Recommendation:**
1. **Document reviewer identity requirements** (e.g., "engineers with 2+ years experience in codebases using X framework")
2. **Add reviewer metadata to export schema:** `reviewer_id`, `reviewer_expertise_level`, `review_timestamp`, `review_duration_seconds`
3. **Restore or rebuild annotation workflow** — see Section 5 below

---

### 2. Full Traces vs Final Outputs

**Status:** ⚠️ **Full traces available but hidden by default**

**Evidence from `scripts/eval/eval-viewer.html`:**

✅ **What reviewers CAN see:**
- Full answer (markdown rendered, expanded by default)
- Tool calls (collapsed under `<details>`)
- Files read (collapsed under `<details>`)
- Ask system prompt (collapsed under `<details>`)
- Judge prompt (collapsed under `<details>`)
- Judge feedback (collapsed under `<details>`)
- Metadata: repository, commit, tool call count, inference time

⚠️ **What's problematic:**
- **Critical context is collapsed** — reviewers must manually expand 4-6 sections per row
- **No progressive disclosure guidance** — unclear which sections matter most for which failure modes
- **Cognitive load is high** — switching between comparison columns while expanding/collapsing sections

**Positive aspects:**
- Markdown rendering makes answers readable
- Side-by-side comparison mode for runs A vs B
- Copy-to-clipboard and code/preview toggle for answers
- AI-powered analysis via OpenRouter (cached per comparison)

**Recommendation:**
1. **Add "Expand All" / "Collapse All" toggle** for detail sections
2. **Pre-expand tool calls for rows with errors** (status: regressed, removed, or eval errors)
3. **Highlight redundant tool calls** visually (e.g., duplicate `read` on same file)
4. **Add trace-level timeline view** showing tool call sequence with latency bars

---

### 3. Review Interface Quality

**Status:** ❌ **Read-only viewer; zero annotation support**

**Current capabilities (eval-viewer.html):**

| Feature | Exists? | Notes |
|---------|---------|-------|
| Upload CSV | ✅ | Drag-and-drop for current + previous run |
| Side-by-side comparison | ✅ | A/B columns with change indicators |
| Filtering | ✅ | By status (all/regressions/failures/etc.), broken links, metrics |
| Sorting | ✅ | By tool calls, files read, latency, broken link ratio |
| Markdown rendering | ✅ | With copy + code/preview toggle |
| AI analysis | ✅ | OpenRouter-powered comparison insights |
| **Annotation input** | ❌ | **None** |
| **Export annotations** | ❌ | **None** |
| **Label persistence** | ❌ | **None** |
| **Multi-reviewer support** | ❌ | **None** |
| **Labeling guidelines** | ❌ | **None** |

**Critical gaps:**
1. **No way to record human judgments** — can't click "this answer is wrong" or "this tool call is redundant"
2. **No structured feedback collection** — misc_feedback exists in schema but can't be entered
3. **No review session tracking** — can't resume partially-completed reviews
4. **No inter-annotator agreement measurement** — can't assign same row to multiple reviewers

**Historical context:**
- **Web UI with feedback collection existed** (commit `aae8ff7`, Jan 23, 2026)
- **Flask review server with templates** (commits `88fcd51`, `b27e17d`)
  - `eval/templates/review.html` — annotation interface
  - `eval/templates/metrics.html` — agreement metrics
  - `eval/review-server.py` — Flask backend with `/review` API
- **All deleted** in commit `feeb65b` (Feb 8, 2026)
- **No replacement implemented**

**Recommendation:**
1. **Restore annotation UI** or use `build-review-interface` skill to create a custom tool
2. **Implement export to CSV** with full annotation schema (see Section 5)
3. **Add multi-reviewer mode** with row assignment and progress tracking
4. **Ship labeling guidelines** inline (collapsible panel in UI)

---

### 4. Eval-Research.md Review Process Plans

**Status:** ⚠️ **Mentions human review but no concrete plans**

**Relevant sections from `eval-research.md`:**

```markdown
### 9) Human review loop fields
- `human_label`
- `human_score`
- `review_notes`

Why: top systems support human override and annotation to improve eval quality over time.
```

**Analysis:**
- **Field names specified** but not implemented in `run-eval.ts`
- **No workflow design** — when/how/who collects these fields?
- **No integration plan** — how do human labels feed back into judge calibration?
- **Research doc is passive** — lists fields competitors track but doesn't commit to timeline

**Missing from research doc:**
- Reviewer recruitment criteria
- Label quality control (gold standard sets, inter-annotator agreement targets)
- Judge calibration loop (using human labels to measure judge TPR/FPR)
- Budget/timeline for human review sprints

**Recommendation:**
1. **Expand research doc with workflow section:**
   - When to trigger human review (e.g., "after judge score <0.7 on 20+ rows")
   - How to assign rows (stratified by status, random sampling, cherry-picking regressions)
   - Who reviews (internal team vs external contractors, expertise requirements)
2. **Add section on judge calibration:**
   - Collect 100 human labels on stratified sample
   - Measure judge TPR/TNR per verdict (complete, evidenced, linked, reasoning)
   - Iterate on judge prompt if agreement <0.8
3. **Reference `validate-evaluator` and `build-review-interface` evals skills**

---

### 5. Annotation Workflow, Guidelines, and Instructions

**Status:** ❌ **None exist; previously deleted**

**What was deleted:**

```
eval/review-server.py              — Flask server for /review API
eval/templates/review.html         — Annotation UI
eval/templates/metrics.html        — Inter-annotator agreement dashboard
eval/templates/index.html          — List of runs to review
eval/reports/reviews/*.json        — Saved review data
```

**What remains:**
- `tmp/eval/annotations_export.csv` (4 rows, orphaned artifact)
- `ask-forge-eval-dataset.csv` (122/135 labeled rows, unclear provenance)

**Current eval run schema (from `run-eval.ts`):**

```typescript
session_id, repository, commit_id, question,
is_answer_complete, is_evidence_supported, is_evidence_linked, is_reasoning_sound,
misc_feedback, answer, tool_call_count, inference_time_ms
// No human_label, human_score, reviewer_id, review_timestamp, etc.
```

**Missing components:**

1. **Labeling guidelines:**
   - What makes an answer "complete" vs "incomplete"?
   - When is evidence "supported" (exact quote? paraphrase? vibe?)
   - Link validation criteria (line anchors required? 404s acceptable?)
   - Edge case handling (partial answers, outdated code, ambiguous questions)

2. **Reviewer instructions:**
   - How to navigate eval-viewer
   - Which sections to expand for which verdicts
   - How to compare runs (focus on regressions vs improvements)
   - When to escalate (e.g., "judge verdict is clearly wrong")

3. **Annotation schema design:**
   - Binary labels (yes/no) vs Likert scale (1-5)
   - Free-text feedback structure (tags? required fields?)
   - Confidence levels (high/medium/low per verdict)
   - Reviewer agreement resolution (majority vote? expert tiebreaker?)

4. **Workflow tooling:**
   - How to export annotations (currently impossible)
   - How to merge annotations into dataset (manual CSV editing?)
   - How to track review progress (no session state)
   - How to handle iterative labeling (re-review after judge updates)

**Recommendation:**

### **Option A: Restore Flask-based review server**

**Pros:**
- Historical templates exist in git (`git show feeb65b^:eval/templates/review.html`)
- Python-based, easy to extend
- Can reuse logic from deleted `review-server.py`

**Cons:**
- Requires backend deployment
- Deleted for a reason (check with original author)
- May not integrate cleanly with current `scripts/eval/` TypeScript setup

**Steps:**
1. `git show feeb65b^:eval/review-server.py > scripts/eval/review-server.py`
2. Extract templates from git history
3. Update to use current CSV schema (e.g., `is_answer_complete` instead of `is_answer_relevant`)
4. Add export endpoint: `GET /export-annotations` → CSV download
5. Document in README: "Run `python scripts/eval/review-server.py` to start annotation UI"

---

### **Option B: Use `build-review-interface` evals skill** (RECOMMENDED)

**Advantages:**
- **Tailored to ask-forge data model** — can render tool calls, files read, markdown answers natively
- **Modern browser-based** — no backend deployment required
- **Structured export** — JSON or CSV with full schema control
- **Reviewer-friendly UX** — progressive disclosure, keyboard shortcuts, progress tracking

**Workflow:**
1. Load `build-review-interface` skill:
   ```bash
   Read /Users/kiran/.pi/agent/skills/evals-skills/skills/build-review-interface/SKILL.md
   ```
2. Design annotation schema based on current judge verdicts:
   ```typescript
   {
     session_id: string,
     human_is_answer_complete: "yes" | "no" | "partial",
     human_is_evidence_supported: "yes" | "no" | "partial",
     human_is_evidence_linked: "yes" | "no" | "n/a",
     human_is_reasoning_sound: "yes" | "no" | "partial",
     human_misc_feedback: string,
     reviewer_id: string,
     review_timestamp: string,
     review_confidence: "high" | "medium" | "low",
     time_spent_seconds: number,
   }
   ```
3. Build custom tool with:
   - **Left panel:** Filterable row list (status, repo, broken link ratio)
   - **Right panel:** Question + answer + collapsible trace sections
   - **Bottom panel:** Annotation form (radio buttons for verdicts, textarea for feedback)
   - **Export button:** Download annotations as `annotations-YYYY-MM-DD.csv`
4. Ship as `scripts/eval/annotation-tool.html` (single-file SPA)
5. Document in README:
   ```markdown
   ### Annotating Eval Results
   
   1. Open `scripts/eval/annotation-tool.html` in a browser
   2. Drag-and-drop an eval run CSV
   3. Review each row and fill out the annotation form
   4. Click "Export Annotations" to download CSV
   5. Merge annotations into dataset: `bun scripts/eval/merge-annotations.ts`
   ```

---

### **Option C: Extend eval-viewer.html with annotation mode**

**Pros:**
- Reuses existing comparison UI
- No separate tool to maintain

**Cons:**
- Eval-viewer is complex (2670 lines) — adding annotation may bloat it further
- Risk of breaking existing comparison workflows

**Steps:**
1. Add "Annotation Mode" toggle in header
2. Show annotation form below answer in detail panel
3. Store annotations in `localStorage` keyed by `session_id`
4. Add "Export Annotations" button → CSV download
5. Risk: localStorage size limits (~5MB) may hit on large datasets

---

## Summary of Recommendations

### Immediate (P0):
1. ✅ **Restore annotation workflow** via `build-review-interface` skill → custom `annotation-tool.html`
2. ✅ **Write labeling guidelines** as `scripts/eval/LABELING-GUIDELINES.md` (inline in tool)
3. ✅ **Extend eval CSV schema** with human_* fields (backward-compatible)

### Short-term (P1):
4. ✅ **Document reviewer requirements** in eval-research.md
5. ✅ **Add export button** to annotation tool → `annotations-{timestamp}.csv`
6. ✅ **Create merge script** to combine annotations into dataset

### Medium-term (P2):
7. ⚠️ **Calibrate judge with human labels** using `validate-evaluator` skill
8. ⚠️ **Measure inter-annotator agreement** on 50-row gold set
9. ⚠️ **Add reviewer_id tracking** to audit who labeled what

### Long-term (P3):
10. 🔮 **Multi-reviewer mode** with row assignment and disagreement resolution UI
11. 🔮 **Active learning loop** — auto-flag judge disagreements for human review
12. 🔮 **Metrics dashboard** — judge accuracy, annotation velocity, label drift over time

---

## Appendix: Deleted Files Reference

**Review server (deleted Feb 8, 2026, commit feeb65b):**
```bash
git show feeb65b^:eval/review-server.py > /tmp/review-server.py
git show feeb65b^:eval/templates/review.html > /tmp/review.html
git show feeb65b^:eval/templates/metrics.html > /tmp/metrics.html
```

**Sample annotation export schema (from `tmp/eval/annotations_export.csv`):**
```csv
session_id,repository,commit_id,question,is_answer_relevant,is_evidence_supported,is_clear_and_readable,misc_feedback
379dd988-9f9a-4b22-8283-d2d506d3425a,https://github.com/lukilabs/beautiful-mermaid.git,3fcbb97eac0b76cc4657119c4a0c09dc16e02b59,What benefit does this library provide over simply using mermaid.js directly,1,1,1,The function names could be linked to the the line for the user to check
```

---

## Related Evals Skills

- **`build-review-interface`** — Build custom annotation tool tailored to ask-forge traces
- **`validate-evaluator`** — Calibrate LLM judge against human labels (TPR/TNR measurement)
- **`error-analysis`** — Systematically identify failure modes before building judge
- **`write-judge-prompt`** — Design rubrics for subjective criteria (evidence quality, reasoning soundness)

---

**End of Audit**
