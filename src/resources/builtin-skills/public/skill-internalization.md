---
name: skill-internalization
description: Standard operating procedure for ingesting external skills and transforming them into actor SOPs
---

# Skill Internalization SOP (Meta-SOP)

## 1. Context & Purpose
Available to all ensemble actors and Director Logox. Use this procedure whenever adopting, porting, or internalizing external skills, community prompts, or third-party engineering/design recipes into the LOGOX skill library. This ensures third-party knowledge is restructured into high-discipline, actor-aligned SOPs without losing original operational fidelity.

## 2. Core Invariants & Boundaries
- **Strict English System Interface**: All written SOP files, frontmatter keys, section titles, and taxonomy descriptions must be **strictly 100% English**, with no bilingual noise or parallel translations.
- **Preserve Operational Semantics**: Extract and preserve all core parameters, hard thresholds, command flags, invariants, and step sequences verbatim from the source material.
- **Zero Extraneous Tools**: Internalization is conducted via standard `Read`, `Write`, `Edit`, and `AskUserQuestion` tools; do not create or invoke ad-hoc internalization scripts.
- **Interactive User Consent on Ambiguity**: When target actor ownership or storage scope (global vs project) is not specified by the user, explicitly ask via `AskUserQuestion` before writing.

## 3. Step-by-Step Execution Procedure

### Step 1: Read & Analyze External Material
1. Read the entire raw source material using `Read` or `WebFetch`.
2. Extract the core intent, algorithmic procedures, configuration keys, and completion criteria.
3. Identify whether the capability is role-specific (aesthetic -> Kalon, engineering -> Techne, inspection/audit -> Aletheia, workflow -> Logox) or cross-cutting (Public).

### Step 2: Determine Target Actor Ownership
1. **If the user explicitly specified the actor** (e.g. "Have Kalon internalize this flat styling recipe"):
   - Adopt that actor immediately without asking.
2. **If the user did not specify the actor**:
   - Evaluate against the actor taxonomies in `skills/<actor>/agent.md`.
   - Formulate a clear recommendation with rationale.
   - Invoke `AskUserQuestion` (in the user's conversational language, e.g., Chinese) providing options:
     - Recommended Actor (e.g., Kalon / Techne / Aletheia)
     - Alternative Actor or Public
     - Explain why the recommendation fits that actor's persona.

### Step 3: Determine Storage Scope
1. **If the user specified scope** (e.g., `--global` or `--project`):
   - Use the designated location directly.
2. **If the user did not specify scope**:
   - Invoke `AskUserQuestion` asking whether to store in:
     - **User Global (`~/.logox-ts/skills/`)**: Available across all projects for this user (Recommended for general SOPs).
     - **Project Private (`<cwd>/.logox/skills/`)**: Isolated to this specific repository.

### Step 4: Standardized SOP Rewrite (Strict 100% English)
Structure the rewritten SOP using the standardized 4-section format:
```markdown
---
name: <kebab-case-slug>
description: <concise one-line summary>
actors: [<target-actor>]
---

# <Title> SOP

## 1. Context & Purpose
(When and why to invoke this procedure, aligned with the actor's persona)

## 2. Core Invariants & Boundaries
(Hard rules, parameter limits, safety constraints, preserved from source)

## 3. Step-by-Step Procedure
(Actionable CLI commands, file paths, and deterministic operational checkpoints)

## 4. Verification & Done Criteria
(Concrete evidence required before declaring completion)
```

### Step 5: Write File & Update Taxonomy
1. Write the new SOP file to the target directory:
   - For L0 Core Principles: `<targetDir>/<slug>.md`
   - For L1 Domain Repositories: `<targetDir>/<category>/<slug>.md`
2. If introducing an entirely new category directory:
   - Read the actor's `agent.md`.
   - Update its frontmatter `categories` mapping by adding `<category>: <one-line description>`.
   - Save via `Edit`.

## 4. Verification & Done Criteria
- The newly written SOP is valid Markdown with correct YAML frontmatter.
- If a new category was created, the actor's `agent.md` successfully reflects the new entry under `categories`.
- The actor can locate the new SOP via progressive discovery and execute its steps reliably.
