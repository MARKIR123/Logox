# Module: Resources & Skills (`src/resources/`)

## 1. Scope
- **Owns**: Project guidelines loading (`AGENTS.md`, `CLAUDE.md`), hierarchical skills library (`skills/<actor>/<domain>/*.md`), custom slash commands, and hot-reloading.
- **Does not own**: Low-level tool process execution (owned by `src/tools/`).

## 2. Start Here (Task Router)
| If investigating... | Start at... | Then check... |
|---|---|---|
| Hierarchical skill discovery or role visibility | `manager.ts:skillsFor()` | Directory prefix (`skills/<actor>/...`) and frontmatter |
| Built-in official skills library | `builtin-skills/agent.md` | `builtin-skills/<actor>/` |
| Background guideline or skill hot-reloading | `reload.ts:reloadResources()` | `/reload` slash command in `application.ts` |
| Custom slash command registration | `manager.ts:snapshot()` | `commands` list in `Resources` |

## 3. Hard Boundaries
- **Path as Prompt / Semantic Signposts**:
  - Skills are organized hierarchically: `skills/<actor>/<domain>/<name>.md`.
  - Directory prefixes dictate default role visibility (`skills/kalon/...` visible to Kalon; `skills/public/...` visible to all).
  - Frontmatter `actors: [...]` explicitly overrides path-based visibility when declared.
- **Two-Tier Runtime & Distribution Seeding**:
  - Runtime physical sources: **Project Private (`<cwd>/.logox/skills/`) > User Global (`~/.logox-ts/skills/`)**.
  - Built-in skills (`builtin-skills/`) serve as distribution seed templates, non-destructively seeded to `~/.logox-ts/skills/` on load.
- **Two-Stage Progressive Discovery**:
  - System prompts only receive lightweight skill metadata:
    - **L0 Core Principles** (`skills/<actor>/*.md`): Essential baselines whose metadata and path remain directly in the system prompt.
    - **L1 Domain Repositories** (`skills/<actor>/<category>/**/*.md`): Specific SOPs whose individual filenames are collapsed; only category folder names and concise one-line descriptions (from `agent.md` `categories`) appear in the prompt.
  - Agents inspect domain contents via `Glob("skills/<actor>/<category>/*.md")` and read complete SOP markdown instructions on-demand via `Read`.
- **Skill Internalization Meta-SOP**:
  - Public meta-procedure (`skills/public/skill-internalization.md`) governs adopting third-party skills, standardizing into 4-section English SOPs, and updating actor taxonomy without losing operational invariants.

## 4. Integration Points
```text
application.ts (instantiates Resources)
  → kernel/agent.ts (injects lightweight skill metadata into system prompt)
  → actors/services.ts (resolves single-task borrowing via BorrowSkill)
  → tools/ReadTool (agent reads full SOP markdown instructions on demand)
```

## 5. Verification
- **Targeted Test Suite**:
  - `tests/resources.test.ts`: Discovery, override hierarchy, and reloading.
  - `tests/hierarchical-skills.test.ts`: Role-based filtering and Path as Prompt.
- **Fast Run Command**:
  ```bash
  node --test dist/tests/resources.test.js dist/tests/hierarchical-skills.test.js
  ```
