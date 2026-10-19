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

## 1.5 Specification Gate (before any dispatch)

A bad spec is obeyed silently and fails silently. Scan for these four before dispatching anything:

- **Satisfiability**: every "must satisfy A *and* B" pair gets checked for geometric or logical conflict. Real case: a frozen hip anchor 28px below the saddle, plus "the saddle must be visible" — unsatisfiable, yet both sides dutifully complied and the saddle disappeared.
- **Ownership**: for every shared file, layer, group and id, state *who writes it* and *what it must / must not contain*. Naming agreement is not semantic agreement. Real case: `#legs` — art drew a static fallback inside it, the engine assumed an empty group and appended → six legs on screen.
- **Acceptance object**: the acceptance target is the **assembled artifact**, never a placeholder harness. If a stand-in is specified as the minimum deliverable, say explicitly that it does NOT close the task. Real case: an IK harness built on a placeholder rig passed every assertion while the real art shipped feet outside the canvas.
- **Redirect budget**: one direction change per task. A second redirect is evidence that recon was insufficient — stop and recon, do not redirect again.

## 2. Phase 1: Parallel Design & Numerical Calculation

- **Kalon**: Dispatch visual design, color tokens, and layout guidelines.
- **Techne**: Dispatch numerical computation or mathematical IK scripts to scratchpad (never calculate in thought blocks).
- **Rule**: Both deliver data deliverables to disk or return channels; neither writes to the final production source file yet.

## 3. Phase 2: Single-Writer Production Assembly

- Assign the target deliverable (e.g. `index.html` or `feature.ts`) strictly to **Techne as the Single Writer**.
- Techne synthesizes Kalon's design tokens and precomputed metrics, assembling the complete working artifact.
- Minimized rounds: Deliver a working baseline within 1-2 turns.
- **Write lock**: while a role owns the file, no third party writes it directly. Patches travel as a separate `*.patch` file or through an explicit handshake message. Silent edits destroy work the owner cannot see. Real case: an art rewrite silently reverted three director patches, and only a timestamp check caught it.

## 4. Phase 3: Independent Verification (Visual & Functional)

- **Aletheia**: Dispatched to verify the artifact independently.
  - For frontend/visuals: Run `browser-shot <target>` followed by `Read` on the output PNG.
  - For backend/logic: Run existing test suites or write isolated unit tests in scratchpad.
  - **Rule**: Aletheia ONLY reports findings and NEVER modifies the production file directly.
- **Assert the execution path**: for screenshot verification, confirm the log shows the primary path (`sha256=...`). If it shows `fell back to legacy CLI`, timing and byte-stability claims are void — "it produced an image" is not a pass.
- **Auto-wake on objective failure**: dispatch Aletheia on hard signals — frames byte-identical where motion is expected, fallback in the log, regression failure — without waiting for the Director to remember. Verification is a trigger, not a courtesy.
- **Self-verification does not count**: the builder never signs off its own component. Component-green is not product-green.

## 5. Phase 4: Final Handover & Knowledge Promotion

- If minor visual flaws exist: Logox assigns a surgical fix pass back to the Single Writer.
- Record reusable recipes in `.logox/bulletin.md` with role and timestamp.
- Update the relevant skill file when a procedure, flag, or invariant changes. A stale SOP is worse than no SOP: the next actor follows it exactly and reproduces the old behaviour.
