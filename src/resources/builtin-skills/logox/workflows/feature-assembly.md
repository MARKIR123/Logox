---
name: feature-assembly
description: End-to-end agile feature assembly & multi-actor coordination workflow SOP
actors: [logox]
---

# Feature Assembly Workflow SOP (全功能敏捷装配流)

This SOP governs how Director Logox coordinates Kalon, Techne, and Aletheia to build end-to-end features rapidly with zero deadlocks and zero duplicate card fragmentation.

## 1. Pre-Flight Check
- Call `ListActors({})` to inspect current ensemble availability (`busy` vs `idle`).
- Ensure no subagent is left hanging in deadlocks.
- Check `.logox/bulletin.md` for known environment pitfalls or design anchors.

## 2. Phase 1: Parallel Design & Numerical Calculation
- **Kalon**: Dispatch visual design, color tokens, and layout guidelines.
- **Techne**: Dispatch numerical computation or mathematical IK scripts to scratchpad (never calculate in thought blocks).
- **Rule**: Both deliver data deliverables to disk or return channels; neither writes to the final production source file yet.

## 3. Phase 2: Single-Writer Production Assembly
- Assign the target deliverable (e.g. `index.html` or `feature.ts`) strictly to **Techne as the Single Writer**.
- Techne synthesizes Kalon's design tokens and precomputed metrics, assembling the complete working artifact.
- Minimized rounds: Deliver a working baseline within 1-2 turns.

## 4. Phase 3: Independent Verification (Visual & Functional)
- **Aletheia**: Dispatched to verify the artifact independently.
  - For frontend/visuals: Run `browser-shot <target>` followed by `Read` on the output PNG.
  - For backend/logic: Run existing test suites or write isolated unit tests in scratchpad.
  - **Rule**: Aletheia ONLY reports findings and NEVER modifies the production file directly.

## 5. Phase 4: Final Handover & Knowledge Promotion
- If minor visual flaws exist: Logox assigns surgical fix pass back to Techne.
- Record reusable recipes in `.logox/bulletin.md` with role and timestamp.
