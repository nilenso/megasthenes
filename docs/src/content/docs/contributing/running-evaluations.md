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
```

Results are written to `scripts/eval/reports/`.

### View results

Open `scripts/eval/eval-viewer.html` to inspect a run or compare two result CSVs side by side.
