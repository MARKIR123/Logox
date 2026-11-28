# Module: Resources & Skills (`src/resources/`)

## 1. Scope
- **Owns**: Guideline loading (project-level LOGOX, AGENTS and CLAUDE markdown files), the hierarchical skill library and its built-in seed copy (`builtin-skills/`), custom slash command templates (`.logox/commands/`), skill prompt sections, skill usage counting (`skill-usage.ts`), the skill curator and its archive (`skill-curator.ts`, `skill-archive.ts`), and `/reload`.
- **Does not own**: Tool execution ([`src/tools/AGENTS.md`](../tools/AGENTS.md), [`src/actors/AGENTS.md`](../actors/AGENTS.md)); prompt topic ordering ([`src/prompts/AGENTS.md`](../prompts/AGENTS.md)); MCP, Playwright and hook code (`src/extensions/`, routed through [`src/tools/AGENTS.md`](../tools/AGENTS.md)).
- **Design rationale**: [docs/modules/resources-and-extensions.md](../../docs/modules/resources-and-extensions.md)

## 2. Start Here
| If you need to... | Start at | Then check |
|---|---|---|
| Change which actors see a skill | `manager.ts:Resources.skillsFor()` | `manager.ts:Resources.reload()` (path-inferred `actors`), `manager.ts:Resources.assignSkill()` |
| Change what skills the system prompt discloses | `manager.ts:Resources.promptSections()` | `manager.ts:Resources.categoriesFor()`, `src/kernel/agent.ts` |
| Change how a category lists its skills in the prompt (count, order, cut) | `manager.ts:categoryListing()` | `manager.ts:usageRanks()`, `manager.ts:Resources.usage`, `skill-usage.ts:SkillUsage.entriesFor()` |
| Change guideline discovery, size limits or ordering | `manager.ts:Resources.reload()` | `maxBytes` and `ancestors()` in `manager.ts` |
| Change category descriptions shown to an actor | `builtin-skills/<actor>/agent.md` frontmatter `categories:` | `manager.ts:Resources.categoriesFor()` |
| Change first-run seeding or shipped-skill refresh | `manager.ts:ensureUserSkillsSeeded()` | `skill-defaults.ts:previousBrowserSkills` |
| Change `/reload` behavior or its report | `reload.ts:reloadResources()` | `/reload` branch in `src/app/submit.ts` |
| Add or expand a custom slash command | `manager.ts:Resources.expand()` | `.logox/commands/*.md`, `src/commands.ts:commandCatalog` (built-in names are reserved) |
| Change how skill use is counted (what counts, where it is stored, active days) | `skill-usage.ts:SkillUsage` | `manager.ts:Resources.skillAt()`, the `Read` branch of `src/tools/index.ts:Tools.execute()` (`onSkillRead`), wiring in `src/project-host.ts` |
| Change when idle skills turn stale or are archived, how archive and restore move files, or the restore count | `skill-curator.ts:SkillCurator`, the `STALE_ACTIVE_DAYS` and `ARCHIVE_ACTIVE_DAYS` constants | `skill-archive.ts:archiveSkillFile()`, `skill-archive.ts:restoreSkillFile()`, `skill-usage.ts:SkillUsage.update()`, run in `src/project-host.ts:ProjectHost.createSession()` |
| Change the `/skills` page (stale marks, Archived tab, restore keys) | `src/commands/skills-page.ts:createSkillsPage` | `src/application-commands.ts:createCommandTabsFor()`, `src/commands/pages.ts`, `/<name>` restore in `src/app/submit.ts` |
| Meta-procedure for adopting a third-party skill | `builtin-skills/public/skill-internalization.md` | `builtin-skills/<actor>/agent.md` |

## 3. Common Changes
### Add a built-in skill
1. Pick the tier by path: `builtin-skills/<actor>/<name>.md` is a core principle (always listed with its path), `builtin-skills/<actor>/<category>/<name>.md` is a domain SOP (collapsed to its category), `builtin-skills/public/` is visible to every actor. `<actor>` is `logox`, `techne`, `kalon` or `aletheia`.
2. Write frontmatter with `name` and `description`; optional `actors: [...]` overrides path-based visibility. Follow the 4-section SOP shape in `builtin-skills/public/skill-internalization.md`.
3. For a new category directory, add `<category>: <one-line English description>` to the `categories:` frontmatter of `builtin-skills/<actor>/agent.md`, and add the file to the tree listed in `builtin-skills/agent.md`. Without a description the prompt falls back to a generic one.
4. Existing users only receive missing files: seeding never overwrites an edited file. Refreshing an old shipped default needs its previous SHA-256 in `skill-defaults.ts:previousBrowserSkills`.
- Tests: `tests/hierarchical-skills.test.ts`

### Add a guideline source or skill root
1. Guideline files and their per-level candidate order live in `manager.ts:Resources.reload()` (user level: `AGENTS.md`, `CLAUDE.md`; project ancestors additionally accept a LOGOX markdown file; each candidate is also looked up under `.logox/`).
2. Skill roots are the `skillRoots` list in the same method, scanned built-in, then user, then project, so later roots override same-named skills. Command roots are `commandRoots`.
3. Keep the file in the result of `reload()`; failures must be reported via `issue(...)` so `/reload` can show them.
- Tests: `tests/resources.test.ts`, `tests/hierarchical-skills.test.ts`

### Expose a new resource kind in `/reload`
1. Extend `ResourceKind` and `ResourceSnapshot` in `manager.ts`, and populate it in `reload()`.
2. Add its label to `labels` in `reload.ts:reloadResources()`. If it affects prompts, include it in `promptRevision` so token estimates are invalidated.
- Tests: `tests/resources.test.ts`, `tests/prompt-disclosure-integration.test.ts`

## 4. Hard Boundaries
- **Skill precedence is project > user > built-in**: later roots in `skillRoots` override same-named skills. Enforced by `tests/hierarchical-skills.test.ts`.
- **Seeding is non-destructive**: built-ins are copied to `~/.logox/skills/` only when missing; an existing file is replaced only if it still matches a known shipped default. Enforced by `tests/hierarchical-skills.test.ts`.
- **Path is the default visibility**: `skills/<actor>/...` is visible to that actor, `skills/public/...` to all; the prompt lists core skills individually and each domain category with its description plus up to five of its skills (name and a cut description, no path; more than five show the top four and `+N more`), found with the `Skill` tool. Enforced by `tests/hierarchical-skills.test.ts`. Frontmatter `actors:` overriding the path default is *Unenforced*.
- **Guidelines and skills stay separate, bodies stay on disk**: `promptSections()` returns them apart and never injects a skill body (public skills also reach custom actors); bodies are read on demand with `Read`. Enforced by `tests/prompt-composition.test.ts`.
- **The category listing order is frozen per reload**: `reload()` reads usage through `Resources.usage` (wired in `src/project-host.ts`) and stores each skill's position in `ResourceSnapshot.ranks`; `promptSections()` is synchronous and reads only those ranks (usage count, then last use, then name; no provider or a failing one means name order), so counts changing mid-session never change the system prompt (prompt cache). A new order shows after `/reload` or a new app start, and `reload.ts` counts `ranks` in `promptRevision`. Enforced by `tests/hierarchical-skills.test.ts`.
- **Reload invalidation covers every role**: a Worker-only skill change counts as a prompt change. Enforced by `tests/prompt-disclosure-integration.test.ts`.
- **Guidelines are bounded**: per-file and total size caps, real-path de-duplication, invalid files reported and skipped, paths containing a `legacy` segment ignored. Enforced by `tests/resources.test.ts`.
- **Custom commands cannot shadow built-ins**: names in `commandCatalog` are rejected with an issue. Enforced by `tests/resources.test.ts`.
- **Usage counts never live in the project**: user and built-in skills count in `~/.logox/skills/.usage.json`, project skills in `<project data>/skill-usage.json`; a skill counts once per activity (worker reads included), `agent.md` and failed reads never. Writes are fire-and-forget and never fail a tool call. Enforced by `tests/skill-usage.test.ts`.
- **Learned skills are written by the harvest, never by `reload()`**: `src/anamnesis/skills.ts:SkillStore` creates `<root>/<actor>/<category>/<name>.md` (frontmatter `origin: learned`, `learned_at`, `learned_by`, built by the runtime) and registers a new category under `categories:` of `<root>/<actor>/agent.md` through the yaml document API (comments and other keys survive; a missing agent.md is created with only that frontmatter). Nothing here reloads: `Resources` reads them on the next `/reload` or start, which is why the prompt prefix never changes mid-session; a name that already exists (built-in included) is never overwritten, and only `origin: learned` skills may be patched. Enforced by `tests/harvest-skills.test.ts`.
- **The curator never deletes**: `skill-curator.ts:SkillCurator.run()` runs once per session start in `src/project-host.ts:ProjectHost.createSession()`, after `SkillUsage.recordDay()`. Idle time counts active days, not calendar days: stale after `STALE_ACTIVE_DAYS` (14, shown in `/skills` only), archived after `ARCHIVE_ACTIVE_DAYS` (30) without a use. Archiving moves the file (or the SKILL.md folder) to `<skill root>/.archive/<same relative path>` in the user or project root; a move whose target exists is refused. A skill never seen before starts its clock at first sight (`seen` in the usage file), `pinned: true` in the frontmatter exempts it, learned and user-installed skills are both archived, and a built-in skill is archived through its seeded copy. The archive record (`archivedAt`, `restores`) lives in the usage store. Enforced by `tests/skill-curator.test.ts`.
- **Archived skills are invisible except to search and recovery**: skill scans skip every dot folder, `ensureUserSkillsSeeded()` and the shipped-root scan in `reload()` skip a skill whose copy sits in the user skill root's .archive folder, and the prompt carries only the one line `N archived skills — searchable with Skill search` (N > 0, counted at reload like the ranks). `Skill` search lists them marked `archived`; `Skill` load, `/<name>` and the Archived tab of `/skills` call `SkillCurator.restore()`, which moves the skill back, restarts its idle clock and counts the restore; the skill is usable at once (`Resources.adopt()`) but the prompt only lists it again after the next reload. The second restore posts a read notice suggesting `pinned: true`. Enforced by `tests/skill-curator.test.ts`.
- **Resource roots are `~/.logox/` and `<cwd>/.logox/` only**: no other legacy home directory is read. *Unenforced*.

## 5. Dependencies
- **Depends on**: `src/commands.ts` (`commandCatalog` reserved names), `src/actors/definitions.ts` (`actorIdSchema`), `yaml` (frontmatter parsing).
- **Used by**: `src/application.ts` (instantiates `Resources`), `src/app/submit.ts` (`/reload`, `/skills`), `src/kernel/agent.ts` (skill and guideline prompt sections), `src/tui/commands/` (custom command suggestions).

## 6. Verification & Gaps
- Fast run: `node --test dist/tests/skill-usage.test.js dist/tests/skill-curator.test.js dist/tests/skill-tool.test.js dist/tests/resources.test.js dist/tests/hierarchical-skills.test.js dist/tests/prompt-composition.test.js dist/tests/prompt-disclosure-integration.test.js`
- Not covered offline: provider-native skill search does not exist; discovery is file-based with no automatic body injection.
- The mixed `prompt()` formatter remains a compatibility wrapper; production assembly consumes `promptSections()` and snapshots.
