---
name: bugfix-rootcause
description: Surgical root-cause diagnosis, reproduction harness & verification SOP
actors: [logox]
---

# Bugfix & Root-Cause SOP (根因排查与手术刀修复流)

This SOP defines the disciplined procedure for investigating and fixing bugs without symptom patching or trial-and-error regression.

## 1. Reproduction Phase (Aletheia)
- Dispatch Aletheia to isolate the exact input, state transition, or network condition triggering the fault.
- Aletheia writes a minimal reproduction script in session scratchpad (`repro.mjs` or `repro.py`).
- Run the reproduction script to confirm it fails with the exact reported error.
- Deliver root-cause diagnosis and file line coordinates back to Logox.

## 2. Implementation Phase (Techne)
- Dispatch Techne with Aletheia's coordinates and minimal repro script.
- Techne follows strict TDD:
  1. Add regression test covering the failure condition.
  2. Implement minimal surgical fix in the target file.
  3. Verify regression test passes.
  4. Run full test suite to guarantee zero side effects.

## 3. Verification & Clean Close
- Run type checks and project validation (`npm run check`).
- Close the issue with explicit proof: repro test passed, suite green.
