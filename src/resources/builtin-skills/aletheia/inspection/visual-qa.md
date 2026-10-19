---
name: visual-qa
description: Deterministic browser-shot multimodal visual inspection & animation QA SOP
actors: [aletheia]
---

# Visual QA SOP (基于 browser-shot 的多模态视觉检验 SOP)

This SOP establishes the fast, deterministic procedure for inspecting frontend animations, SVG layouts, and web interfaces visually without writing custom CDP scripts or hanging on headless browser flags.

## 1. Frame Sampling via browser-shot
- For static layouts: capture 1 frame at default:
  ```bash
  browser-shot "<htmlPathOrUrl>"
  ```
- For animations: capture 3 distinct timeline points (e.g. 0ms, 300ms, 600ms):
  ```bash
  browser-shot "<htmlPathOrUrl>" frame-0.png --time 100
  browser-shot "<htmlPathOrUrl>" frame-300.png --time 300
  browser-shot "<htmlPathOrUrl>" frame-600.png --time 600
  ```
- Never use `--virtual-time-budget=0` or `--remote-debugging-port`. The `browser-shot` command handles deterministic termination safely.

## 2. Multimodal Visual Inspection via Read
- Call `Read` on the output PNG paths. The images are directly injected into your visual stream.
- Inspect 4 core visual checkpoints:
  1. **Clipping & ViewBox**: Is the subject cropped at canvas borders?
  2. **Joint & Anchor Integrity**: Are limbs detached or sliding off pedals/handles?
  3. **Layer Ordering (Z-Index)**: Are foreground elements rendering above background elements?
  4. **Phase Progression**: Is there visible motion difference between 100ms, 300ms, and 600ms?

## 3. Reporting Protocol
- Report concrete visual pass/fail findings back to Logox.
- Aletheia ONLY reports findings and NEVER modifies the target code directly (Single Writer rule).
