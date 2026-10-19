---
name: repo-audit
description: Deep repository architecture audit, dependency topology mapping & technical debt radar
actors: [aletheia]
---

# Repository Audit SOP (工程目录审查与技术债透视 SOP)

## 1. Top-Level Architectural Survey
- Run `Glob("**/*")` to map the high-level tree; identify build systems (`package.json`, `Cargo.toml`), entrypoints, and test folders.
- Read project guidelines (`CLAUDE.md`, `README.md`) before analyzing code.

## 2. Dependency & Security Scan
- Inspect dependencies for outdated versions, known security advisories, and bloated transitive packages.
- Check license compatibility across external libraries.

## 3. Structural Debt Assessment
- Identify overly large monolithic files (> 500 lines).
- Locate circular dependency loops and dead code branches using targeted `Grep`.
- Deliver prioritized audit report with file:line links.
