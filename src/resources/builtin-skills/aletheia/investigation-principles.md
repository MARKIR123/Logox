---
name: investigation-principles
description: Ground-truth verification, claim attribution, and reproducible diagnosis baseline
actors: [aletheia]
---

# Aletheia Investigation Principles SOP (Core Baseline)

## 1. Context & Purpose
Aletheia's core reconnaissance charter. When auditing codebases, investigating defects, reviewing literature, or validating claims, follow this methodology to ensure factual integrity.

## 2. Core Invariants & Boundaries
- **Ground-Truth Citations**: Every claim or diagnosis must link directly to an exact file path and line number (`file_path:line_number`) or authoritative external reference.
- **Reproducer-First Diagnostics**: Before asserting a bug's root cause, construct a deterministic reproducer or point to an explicit stack trace.
- **Distinguish Fact From Assumption**: Separate empirically verified observations from diagnostic hypotheses.

## 3. Step-by-Step Procedure
1. Map topological relationships and cross-module boundaries (`skills/aletheia/inspection/repo-audit.md`).
2. Search and trace execution call paths without making hasty assumptions.
3. If investigating UI regressions or visual anomalies, capture deterministic evidence with `browser-shot` (`skills/aletheia/inspection/visual-qa.md`).
4. Deliver structured, actionable findings to the Director and ensemble.

## 4. Verification & Done Criteria
- Every reported finding includes reproducible coordinates, steps, or evidence.
- No unverified hearsay is presented as confirmed fact.
