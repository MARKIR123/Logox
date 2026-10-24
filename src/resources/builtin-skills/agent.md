# LOGOX Skill Directory Signpost (技能库路标地图)

Welcome to the LOGOX Semantic Skill Library. This directory is organized hierarchically as **Path as Prompt / Semantic Signposts (文件夹即路标)**.
You do NOT need to read all skills into memory. Use directory paths to locate the exact domain knowledge and read only the target SOP file.

---

## 1. Directory Tree (技能地图全景)

```
skills/
├── agent.md                        # You are here: Root navigation signpost
├── logox/                          # Director Logox orchestration & workflow SOPs
│   └── workflows/
│       ├── feature-assembly.md     # End-to-end agile feature assembly & delegation
│       ├── bugfix-rootcause.md     # Surgical root-cause diagnosis & test verification
│       ├── codebase-refactor.md    # Architecture decoupling & safe refactoring
│       └── deep-research.md        # Multi-source fact investigation & synthesis
├── kalon/                          # Kalon design, aesthetics & narrative SOPs
│   ├── color/
│   │   ├── morandi-palette.md      # Low-saturation elegant color harmony
│   │   └── semantic-palette.md     # Accessible UI contrast & semantic palette systems
│   ├── styling/
│   │   ├── material-design.md      # Elevation, physical motion & material metaphors
│   │   └── flat-design.md          # Clean typography, negative space & modern minimalism
│   └── literature/
│       └── text-polishing.md       # Narrative tone, storytelling rhythm & copy polish
├── techne/                         # Techne engineering standards & structural patterns
│   ├── engineering/
│   │   ├── tdd-workflow.md         # Red-green-refactor strict test-driven development
│   │   └── defensive-coding.md     # Boundary unwinding, error handling & zero-leakage
│   └── patterns/
│       ├── single-writer.md        # Single-writer isolation for file & data safety
│       └── state-machine.md        # Explicit state modeling & transition constraints
├── aletheia/                       # Aletheia reconnaissance, audit & academic review
│   ├── academic/
│   │   ├── literature-review.md    # Cross-referencing citations & rigorous claim checks
│   │   └── paper-writing.md        # Structured technical & academic publication standards
│   └── inspection/
│       ├── repo-audit.md           # Deep codebase topology & technical debt radar
│       └── visual-qa.md            # Browser visual and interaction verification
└── public/                         # Public cross-cutting utility SOPs
    └── browser-screenshot.md       # Playwright MCP interaction and screenshot procedure
```

---

## 2. Navigation Protocol (如何检索与使用)

1. **Step 1: Path Navigation (按路径下钻)**:
   - Identify your role and domain. For example, if Kalon needs color rules: `skills/kalon/color/`.
   - If unsure which file exists in a domain, use `Glob("skills/<role>/**/*")` to list available file signposts.
2. **Step 2: On-Demand Read (单文件读取)**:
   - Once the target SOP is identified, call `Read` on that specific `.md` file path.
   - Do NOT load multiple unrelated SOPs into context at once.
3. **Step 3: Execute Checkpoints (按检查清单执行)**:
   - Follow the numbered checkpoints in the SOP to ensure systematic, disciplined delivery.

---

## 3. Knowledge Promotion (从临时经验到正式 SOP)

- **Temporary Quirks & Scratchpad**: When encountering new environment quirks or temporary bash recipes during a task, first record them in the project bulletin board (`.logox/bulletin.md`) or session scratchpad.
- **Formal Skill Promotion**: Once an operational procedure proves stable and reusable across multiple tasks, distill it into a structured Markdown SOP under `skills/<domain>/<name>.md` to permanently expand the ensemble's library.
