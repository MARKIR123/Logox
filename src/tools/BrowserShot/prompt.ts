/**
 * Usage contract for the pre-injected `browser-shot` CLI.
 *
 * This is NOT a registered agent tool. It is a command available on PATH inside
 * ShellTool; this description is appended to the Shell tool description so the
 * model knows when the CLI is the right answer, and when it is not.
 */
export const BROWSER_SHOT_CLI = 'browser-shot';

export const BROWSER_SHOT_DESCRIPTION = `**Screenshots — pre-injected \`browser-shot\` CLI (available on PATH inside Shell)**

Usage:
\`\`\`
browser-shot <fileOrUrl> [out.png] [--time <ms>] [--size <w,h>] [--full] [--frames <a,b,c>] [--diff]
\`\`\`
Then **Read the produced PNG** — running the command is not the same as having seen the result.

- **\`--time\` is animation time, not a load wait.** The virtual clock is frozen only after the page is ready (load + fonts + network idle) and then advanced in exact 16.67ms steps. \`--time 800\` means exactly 800ms into the animation, every single run. Identical arguments produce byte-identical PNGs, so you can prove a visual change by capturing the same time before and after an edit.
- **\`--time 0\` (default)** captures the settled first frame. For static pages this is always what you want.
- **\`--frames a,b,c\`** captures several moments in one call (1 frame = 16.6667ms each). Use it to review motion instead of guessing from one still.
- **\`--diff\`** reports whether consecutive captures are byte-identical, and flags \`page is static\` — use it to prove an animation actually moves.

**Use it when** you need to *see* rendered output: front-end layout, SVG artwork, canvas, CSS states, responsive breakpoints, or an animation at a specific moment. If you are about to describe what a page "should" look like, capture it instead.

**Do not use it when**
- Reading source code or markup — use Read. This shows pixels, not the truth about the code.
- Fetching documentation or articles — use WebFetch, which returns Markdown instead of an image.
- Inspecting the user's own desktop or an application they are running — use AskUserQuestion to ask for an image path.

**Boundaries**
- Read-only rendering: it cannot click, type, or scroll. If a state needs interaction, the page must expose a URL/query flag to reach it.
- Write output into the session scratchpad unless the user asked for a specific path.
- Very tall pages: use \`--full\` deliberately, the resulting image is large.
- If the deterministic CDP path fails, the command falls back to the legacy capture path and says so on stderr — a slow or unusually long run is not an error.`;
