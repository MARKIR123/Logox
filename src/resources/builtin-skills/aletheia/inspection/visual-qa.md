---
name: visual-qa
description: Inspect rendered interfaces and real user interactions through Playwright MCP
actors: [aletheia]
---

# Visual QA

## 1. Context & Purpose
Verify the assembled frontend, not a substitute test harness. Follow `skills/public/browser-screenshot.md` for browser operation.

## 2. Boundaries
Aletheia reports evidence and does not modify the production artifact. Coordinate browser ownership before using a shared page.

## 3. Procedure
1. Identify the visible outcome and interaction to verify.
2. Open the assembled page through Playwright MCP and inspect the layout.
3. Check clipping, alignment, layer ordering, and responsive dimensions relevant to the task.
4. Perform the real interaction and confirm the resulting visible state in the same page.
5. Capture and inspect the resulting screenshot. For animation, distinguish observed motion from exact timing measurements.

## 4. Verification & Done Criteria
Report concrete pass/fail observations and untested paths. Screenshots demonstrate appearance; interaction assertions demonstrate the tested behavior. Neither substitutes for the other.
