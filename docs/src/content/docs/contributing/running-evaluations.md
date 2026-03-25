---
title: Running Evaluations
description: Download the eval dataset and run ask-forge's evaluation harness.
sidebar:
  order: 2
---

The eval runner uses the published `nilenso/ask-forge-eval-dataset` dataset from Hugging Face.

### Download the dataset

```bash
pip install "huggingface-hub[cli]"
huggingface-cli download nilenso/ask-forge-eval-dataset --repo-type dataset --local-dir ./eval-data
```

### Run the eval

```bash
bun run scripts/eval/run-eval.ts ./eval-data/ask-forge-eval-dataset.csv

# With effort-based thinking (any provider)
bun run scripts/eval/run-eval.ts ./eval-data/ask-forge-eval-dataset.csv --effort high

# With adaptive thinking (Anthropic 4.6 only)
bun run scripts/eval/run-eval.ts ./eval-data/ask-forge-eval-dataset.csv --thinking adaptive

# Adaptive with explicit effort guidance
bun run scripts/eval/run-eval.ts ./eval-data/ask-forge-eval-dataset.csv --thinking adaptive --effort medium
```

Results are written to `scripts/eval/reports/`.

### View results

Open `scripts/eval/eval-viewer.html` to inspect a run or compare two result CSVs side by side.
