# Module: Resources & Skills (`src/resources/`)

## 1. Quick Route (核心文件导航)
- `manager.ts`: `Resources` loader managing guidelines (`AGENTS.md`, `CLAUDE.md`), hierarchical skills, and custom slash commands.
- `builtin-skills/agent.md`: The semantic skill navigation map (Path as Prompt / Semantic Signposts).
- `builtin-skills/`: Bundled official SOP library (`logox/workflows`, `kalon/`, `techne/`, `aletheia/`, `public/`).
- `reload.ts`: Background resource hot-reloading.

## 2. Invariants (刚性边界与底线)
- **Path as Prompt / Semantic Signposts**:
  - Skills are organized hierarchically: `skills/<actor>/<domain>/<name>.md`.
  - Directory prefixes dictate default role visibility (`skills/kalon/...` visible to Kalon; `skills/public/...` visible to all).
  - Frontmatter `actors: [...]` explicitly overrides path-based visibility when declared.
- **Three-Tier Waterfall Priority**:
  - Hierarchy: **Project Private (`<cwd>/.logox/skills/`) > User Global (`~/.logox-ts/skills/`) > Built-in Standard Skills**.
  - Skills with identical names automatically override lower tiers on load.
- **Two-Stage Progressive Discovery**:
  - System prompts only receive lightweight skill metadata (`name`, `description`, `path` ~30 tokens each).
  - Agents read the complete SOP markdown instructions on-demand via `Read` before executing the task.

## 3. Cross-Reference (关联路标)
- Root signpost: [`../../AGENTS.md`](../../AGENTS.md)
- Builtin skills navigation: [`builtin-skills/agent.md`](builtin-skills/agent.md)
- Architectural rationale & design history: [`../../docs/`](../../docs/)
