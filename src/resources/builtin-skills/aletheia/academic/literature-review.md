---
name: literature-review
description: Academic literature cross-referencing, claim auditing, citation verification & review SOP
actors: [aletheia]
---

# Academic Literature Review SOP (学术审稿与文献交叉核验 SOP)

## 1. Primary Source Verification
- Never accept secondary quotes without verifying the original paper, preprint, or RFC specification.
- Use `WebFetch` to inspect paper abstracts, methodology sections, and benchmark claims directly.

## 2. Adversarial Claim Auditing
- Verify mathematical derivations and experimental setups under boundary cases (zero baseline, distribution shift, noise sensitivity).
- Check whether baselines were tuned with equal compute and hyperparameter budgets.

## 3. Citation and Reproducibility Checklist
- Check whether datasets, code repositories, and checkpoints are publicly accessible.
- Identify confounding variables or selective reporting in metrics tables.
