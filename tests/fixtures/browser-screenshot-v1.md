---
name: browser-screenshot
description: Standard headless browser screenshot procedure using built-in browser-shot CLI
---

# Browser Screenshot Public SOP (标准无头截图操作手册)

Available to all actors via `Shell`. Pre-injected into the subshell `PATH`.

## Command

```bash
browser-shot <fileOrUrl> [out.png] [--time <ms>] [--size <w,h>] [--full] [--frames <a,b,c>] [--diff]
```

## Semantics that decide correctness

- **`--time` is animation time, not a load wait.** The virtual clock is frozen only after the page is ready (load + fonts + network idle), then advanced in exact 16.67ms steps. `--time 800` means 800ms into the animation, on every run.
- **Identical arguments produce byte-identical PNGs.** Use this to prove a visual change: capture the same `--time` before and after an edit and compare hashes.
- **`--frames a,b,c`** captures several moments in one call (1 frame = 16.6667ms, max 8). Use it to review motion instead of guessing from a single still.
- **`--diff`** byte-compares consecutive frames and prints `static (byte-identical)` when nothing moved.
- **`--full`** captures beyond the viewport. Deliberate use only — the image gets large.

## Mandatory procedure

1. Capture into scratchpad: `browser-shot <target> <scratchpad>/shot.png --time 800`
2. **`Read` the produced PNG.** Running the command is not the same as having seen the result.
3. Reviewing motion? Capture a sequence (`--frames 0,30,60 --diff`) and read every frame.

## Reading the log — this part is not optional

- `[browser-shot] time=800ms bytes=... sha256=...` → primary (deterministic CDP) path succeeded.
- `[browser-shot] fell back to legacy CLI: ...` → **the run is NOT deterministic.** The legacy path has no virtual-time control. Any timing or byte-stability claim from a fallback run is unverified; report it as a fallback, never as a pass.

A screenshot tool that "produced an image" has proven nothing about timing. Always check which path produced it.

## Boundaries

- Read-only rendering: no clicking, typing, or scrolling. If a state needs interaction, the page must expose a URL/query flag to reach it.
- Max 8 frames per invocation.
- Default output (no path given): system temp `logox-shots/`.
- If output is captured inside a project, put it in the session scratchpad unless the user asked for a specific path.
