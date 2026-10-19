---
name: defensive-coding
description: Industrial-grade defensive programming, error unrolling, resource unwinding & leak prevention
actors: [techne]
---

# Defensive Coding SOP (工业级防御式编程与资源解开)

## 1. Resource Unwinding Guarantee
- Every acquired file descriptor, socket, timer, or child process must be closed in a `finally` block or disposable pattern.
- In child process management: always attach error and exit handlers; never allow orphan processes.

## 2. Unrolling Error Causes
- Never catch an exception and print only `error.message` (e.g. Node.js `TypeError: fetch failed`).
- Always recursively inspect `error.cause` to surface the root syscall (`connect`, `read`), error code (`ECONNREFUSED`, `ETIMEDOUT`), and address.

## 3. Atomic File Writes
- Never write directly to target configuration or state files.
- Always write to `<target>.tmp.<uuid>`, call `handle.sync()`, close the descriptor, and atomically rename over `<target>`.
