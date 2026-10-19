---
name: browser-screenshot
description: Standard headless browser screenshot procedure using built-in browser-shot CLI
---

# Browser Screenshot Public SOP (标准无头截图操作手册)

Available to all actors via `Shell`. Pre-injected into subshell `PATH`.

## Command Syntax
```bash
browser-shot <fileOrUrl> [outputPng] [--time <ms>] [--size <width,height>]
```

## Features
- **Auto-Detection**: Automatically locates Chrome or Edge on Windows, Linux, and macOS.
- **Profile Isolation**: Uses an isolated temporary `--user-data-dir` for every invocation to prevent singleton collision.
- **Deadlock-Free**: Guards against `--virtual-time-budget=0` deadlocks.
- **Self-Terminating**: Hard 15-second timeout with process tree termination.
- **Default Output**: If `outputPng` is omitted, saves to `<scratchpad>/shots/shot-<timestamp>.png` and prints the absolute path.
