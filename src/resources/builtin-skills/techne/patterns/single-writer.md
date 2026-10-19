---
name: single-writer
description: Single-writer isolation pattern, file locking & concurrency safety SOP
actors: [techne]
---

# Single-Writer Pattern SOP (单一写入者隔离与并发安全模式)

## 1. Principle of Single Ownership
- A state file or core source code artifact must have strictly **one active writer** at any given moment.
- In multi-actor execution: Director assigns file ownership exclusively to Techne; peers (Kalon, Aletheia) contribute parameters and verification, never competing write handles.

## 2. In-Memory Write Serialization
- Use promise tail chains (`this.tail = this.tail.then(...)`) to serialize concurrent writes within the same process.
- Across multiple processes: use advisory file locks (`.lock` directories or OS file locking) with backoff retries and stale lock timeouts.
