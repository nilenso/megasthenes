# Eval Metrics Gap Analysis for ask-forge

## Current Metrics

The eval system currently tracks these metrics:

| Metric | Type | Description |
|--------|------|-------------|
| `is_answer_complete` | LLM-judge | Whether the answer addresses every distinct aspect of the question |
| `is_evidence_supported` | LLM-judge | Whether all repo-specific claims are backed by cited evidence |
| `is_evidence_linked` | LLM-judge | Whether every code reference includes a valid GitHub/GitLab URL with file + line |
| `is_reasoning_sound` | LLM-judge | Whether causal claims and conclusions follow logically from cited evidence |
| `broken_link_ratio` | Deterministic | N/M format — how many links in the answer are actually broken |
| `inference_time_ms` | Timing | End-to-end response latency |
| Token usage (`input_tokens`, `output_tokens`, `total_tokens`, `cache_read_tokens`, `cache_write_tokens`) | Counting | Cost and efficiency tracking |
| `tool_calls`, `files_read` | Metadata | Operational trace of what the model did |

These cover a solid foundation: completeness, evidence grounding, link integrity, reasoning quality, and basic operational metrics. But there are significant gaps relative to what the RAG/code-QA evaluation literature recommends.

---

## Missing Metrics

### P0 — High-Impact Gaps

#### 1. Faithfulness / Groundedness (distinct from `is_evidence_supported`)

**What it measures:** Whether every factual claim in the answer is supported by the *retrieved context* (the files the model actually read), not just whether the answer cites evidence in general. The current `is_evidence_supported` checks if claims have supporting evidence in the answer text — faithfulness checks if those claims are actually *true* relative to what was retrieved.

**Why it matters:** A model can cite evidence that it misinterprets or selectively quotes. Faithfulness catches cases where the model says "function X returns a list" and even links to the function, but the function actually returns a dict. This is the #1 metric in RAGAS, DeepEval, and TruLens frameworks. Cleanlab's benchmarking found that standard LLM-as-judge faithfulness catches hallucinations that simpler evidence-checking misses.

**How to implement:** Decompose the answer into atomic claims, then verify each claim against the actual file contents retrieved during the session (available via `files_read` + `tool_calls`). Score = supported claims / total claims.

**References:** RAGAS (arXiv:2309.15217), DeepEval Faithfulness, TruLens RAG Triad, Cleanlab TLM

---

#### 2. Answer Relevancy

**What it measures:** Whether the response actually addresses the user's question, without excessive off-topic content, unnecessary padding, or tangential information. Penalizes both missing information and irrelevant information.

**Why it matters:** Currently, `is_answer_complete` checks if all parts of the question are addressed, but doesn't penalize an answer that buries the actual answer in 2000 words of tangential context. A developer asking "how is auth configured?" doesn't want a full architecture walkthrough. Relevancy is orthogonal to completeness — an answer can be complete but bloated, or concise but off-topic.

**How to implement:** RAGAS approach: generate N hypothetical questions from the answer, measure cosine similarity to the original question. Lower similarity = answer drifted from the question. Alternatively, LLM-as-judge with a rubric checking for off-topic content and information density.

**References:** RAGAS Answer Relevancy, SWE-QA-Pro (weight 0.2), CoReQA

---

#### 3. Abstention Quality / "I Don't Know" Accuracy

**What it measures:** Whether the system correctly refuses to answer when it lacks sufficient information, rather than hallucinating. Two sub-metrics: (a) abstention recall — does it abstain when it should? (b) abstention precision — does it avoid over-refusing?

**Why it matters:** This is arguably the most dangerous gap. A code Q&A tool that confidently fabricates answers about code it hasn't read (or can't find) is worse than one that says "I don't have enough context." The current eval has no questions designed to test this, and no metric to measure it. Research (AbstentionBench, arXiv:2506.09038) shows that scaling models does NOT improve abstention — it must be explicitly evaluated.

**How to implement:** Add "unanswerable" questions to the eval dataset (questions about code that doesn't exist, questions requiring context the tool can't access). Score whether the model abstains vs. fabricates. Also score whether it over-refuses on answerable questions.

**References:** AbstentionBench (arXiv:2506.09038), Know Your Limits (MIT Press TACL)

---

#### 4. Code Identifier Accuracy (Deterministic)

**What it measures:** Whether function names, class names, variable names, module paths, and other code identifiers mentioned in the answer actually exist in the codebase at the referenced commit.

**Why it matters:** Hallucinated API names are a well-documented LLM failure mode. The current system checks if *links* are valid, but doesn't verify that the *identifiers* mentioned in prose are real. A model could say "the `processData()` function handles this" with no link, and the current eval wouldn't catch that `processData()` doesn't exist — it's actually called `transformData()`. This is deterministically verifiable by parsing the answer and checking against the repo's AST or a simple grep.

**How to implement:** Extract code identifiers from the answer (function names, class names, file paths mentioned in prose), verify each exists in the repo at the specified commit. Score = verified identifiers / total identifiers.

**References:** SWE-QA-Pro, Microsoft Evaluation Metrics, MERA Code (arXiv:2507.12284)

---

### P1 — Important Gaps

#### 5. Retrieval Quality (Context Precision & Recall)

**What it measures:** Two related metrics about the tool-use / retrieval step:
- **Context Precision:** What proportion of files the model read were actually relevant to answering the question? (Low precision = wasted context window on irrelevant files)
- **Context Recall:** Did the model read all the files it needed to give a complete answer? (Low recall = missed important files)

**Why it matters:** The current eval only measures the *answer* quality, not the *retrieval* quality. But retrieval is the bottleneck — if the model reads the wrong files, even perfect generation can't compensate. Measuring retrieval quality separately helps diagnose *why* answers fail: was it a retrieval problem or a generation problem?

**How to implement:** Requires ground-truth annotations of which files are relevant per question. Then compare `files_read` against the ground truth set. Context precision = |relevant ∩ read| / |read|. Context recall = |relevant ∩ read| / |relevant|.

**References:** RAGAS Context Precision/Recall, DeepEval Contextual Relevancy, TruLens Context Relevance

---

#### 6. Consistency / Stability

**What it measures:** Whether the system gives consistent answers when the same question is asked multiple times, or when semantically equivalent questions are phrased differently.

**Why it matters:** LLMs are non-deterministic. A code Q&A tool that says "the config is in `settings.py`" on one run and "the config is in `config.yaml`" on the next is unreliable. The SCORE framework (arXiv:2503.00137) argues that reporting a single accuracy number without a stability range is misleading.

**How to implement:** Run each question N times (N=3-5), compute pairwise agreement rate. Optionally, create paraphrased variants of questions and compare answers across phrasings. Report accuracy as a [min, max] range rather than a single number.

**References:** SCORE framework (arXiv:2503.00137), SelfCheckGPT

---

#### 7. Cost Per Query

**What it measures:** Total dollar cost of answering one question, including input tokens, output tokens, embedding costs, and any API calls made during tool use.

**Why it matters:** Token counts are already tracked but not converted to cost. For comparing models or system prompt changes, cost-per-query is a critical efficiency metric. A system that's 5% more accurate but 3x more expensive may not be the right tradeoff.

**How to implement:** Multiply token counts by per-token pricing for the model used. Sum across all API calls in a session (including tool-use calls that invoke the model). Already have the raw data — just need the calculation.

**References:** Metron framework (arXiv:2407.07000)

---

#### 8. Clarity / Readability

**What it measures:** Whether the answer is well-structured, logically organized, easy to follow, and uses appropriate technical language for the audience.

**Why it matters:** A technically correct answer that is poorly structured, uses inconsistent terminology, or buries the key insight in paragraph 5 is less useful. SWE-QA-Pro includes clarity as one of its 5 dimensions (weight 0.1). CoReQA also includes it as an independent dimension.

**How to implement:** LLM-as-judge with rubric checking: logical flow, use of headers/lists for complex answers, appropriate code formatting, conciseness.

**References:** SWE-QA-Pro (arXiv:2603.16124), CoReQA (arXiv:2501.03447)

---

### P2 — Valuable Additions

#### 9. Cross-File Reasoning Depth

**What it measures:** The system's ability to synthesize information across multiple files — tracing imports, following inheritance hierarchies, understanding data flow across modules.

**Why it matters:** Most real developer questions require multi-file reasoning. "How does a request flow from the API to the database?" requires reading routers, controllers, models, and ORM config. CrossCodeEval showed performance improves dramatically when cross-file context is available, but measuring whether the system *uses* it correctly is equally important.

**How to implement:** Tag eval questions by reasoning complexity (single-file vs. multi-file). Compare performance across categories. Alternatively, have the judge assess whether the answer demonstrates cross-file understanding or only addresses individual files in isolation.

**References:** CrossCodeEval, MERA Code (arXiv:2507.12284)

---

#### 10. Actionability

**What it measures:** Whether the answer contains concrete, executable guidance — specific file paths to modify, code snippets to add, commands to run — vs. vague directional advice.

**Why it matters:** "You should use the middleware pattern" is less useful than "Add `app.use(authMiddleware)` in `src/server.ts` after line 45." For a code Q&A tool, actionability is what separates it from a generic chatbot. This is not the same as completeness — an answer can cover all aspects of the question at a high level without giving the developer anything they can directly act on.

**How to implement:** LLM-as-judge rubric: does the answer provide specific file locations, concrete code changes, or executable steps? Score on a gradient from "vague guidance" to "copy-paste ready."

---

#### 11. Semantic Similarity to Reference Answer

**What it measures:** Embedding-based cosine similarity between the generated answer and a curated reference answer.

**Why it matters:** Provides a cheap, deterministic baseline metric that correlates with human judgment better than string-matching metrics (BLEU/ROUGE). Useful for regression detection — if a system prompt change drops semantic similarity by 15% across the board, something broke, even before running the expensive LLM judge.

**How to implement:** Requires curated reference answers in the eval dataset. Embed both generated and reference answers, compute cosine similarity. Can use any embedding model (e.g., OpenAI text-embedding-3-small).

**References:** RAGAS Semantic Similarity, BERTScore, Microsoft Evaluation Metrics

---

#### 12. Tool-Use Efficiency

**What it measures:** Whether the model used its tools efficiently — did it read unnecessary files? Make redundant tool calls? Fail to use available tools?

**Why it matters:** `tool_calls` and `files_read` are already captured but not evaluated. A model that reads 30 files to answer a question about one function is wasteful (higher latency, higher cost). A model that doesn't use its search tool and guesses file locations is risky.

**How to implement:** Metrics could include: total tool calls per question, files read per question, ratio of relevant files read to total files read, presence of search-before-read patterns.

---

### P3 — Nice to Have

#### 13. Time to First Token (TTFT)

**What it measures:** Time from request submission to first token appearing. Currently only total `inference_time_ms` is tracked.

**Why it matters:** For interactive use, TTFT determines perceived responsiveness. A 30-second TTFT feels broken even if total time is reasonable.

**References:** NVIDIA LLM benchmarking, Anyscale metrics

---

#### 14. Noise Sensitivity

**What it measures:** How much answer quality degrades when the codebase contains misleading or irrelevant code (dead code, commented-out alternatives, similarly-named functions in different modules).

**Why it matters:** Real codebases are messy. A tool that performs well on clean repos but falls apart on legacy code with multiple versions of the same function is fragile.

**How to implement:** Include eval questions from repos with known noise characteristics (large legacy codebases, monorepos with duplicate patterns).

**References:** RAGAS Noise Sensitivity

---

#### 15. Judge Calibration / Inter-Rater Agreement

**What it measures:** How well the LLM judge's verdicts agree with human judgments on the same questions.

**Why it matters:** This isn't a metric *in* the report — it's a meta-metric about the report's trustworthiness. If the LLM judge disagrees with humans 30% of the time, all reported metrics are suspect. The EVAL-AUDIT-REPORT.md in the repo already flags this: "No judge validation against humans."

**How to implement:** Have humans rate a sample of eval results on the same dimensions. Compute Cohen's kappa or simple agreement rate between human and LLM verdicts.

**References:** SWE-QA-Pro methodology (3 evaluations averaged, randomized answer order)

---

## Summary: What to Prioritize

The current eval system has good coverage of **answer-level quality** (completeness, evidence, linking, reasoning) and **basic operational metrics** (latency, tokens). The biggest gaps are:

1. **Faithfulness vs. evidence-supported is conflated** — the system doesn't verify claims against actual retrieved content, only whether evidence is cited
2. **No abstention testing** — no way to know if the system fabricates answers when it shouldn't
3. **No deterministic identifier verification** — links are checked but code identifiers in prose are not
4. **No retrieval-level metrics** — can't diagnose whether failures are retrieval or generation problems
5. **No relevancy metric** — completeness without relevancy allows bloated, unfocused answers to pass
6. **No consistency/stability measurement** — single-run results may not be representative
7. **No cost tracking** — token data exists but isn't converted to dollars

The first three (faithfulness, abstention, identifier accuracy) would likely have the highest impact on catching real quality problems that the current system misses.

---

## References

- RAGAS framework: arXiv:2309.15217, https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/
- DeepEval: https://deepeval.com/docs/metrics-introduction
- TruLens: https://www.trulens.org/
- Cleanlab TLM: https://cleanlab.ai/blog/rag-tlm-hallucination-benchmarking/
- SWE-QA-Pro: arXiv:2603.16124
- CoReQA: arXiv:2501.03447
- CrossCodeEval: https://crosscodeeval.github.io/
- MERA Code: arXiv:2507.12284
- SCORE framework: arXiv:2503.00137
- AbstentionBench: arXiv:2506.09038
- Know Your Limits (abstention survey): MIT Press TACL, doi:10.1162/tacl_a_00754
- Microsoft Evaluation Metrics: https://learn.microsoft.com/en-us/ai/playbook/technology-guidance/generative-ai/working-with-llms/evaluation/list-of-eval-metrics
- NVIDIA LLM benchmarking: https://docs.nvidia.com/nim/benchmarking/llm/latest/metrics.html
- Metron framework: arXiv:2407.07000
