---
name: browser-screenshot
description: Verify local web pages through one Playwright MCP session with real interaction and visible screenshots
---

# Browser Verification

## 1. Context & Purpose
Use the local `playwright` MCP server for HTML, SVG, canvas, and browser UI verification. The installed server and prepared browser run without Internet access; page resources and model providers have independent network requirements.

## 2. Boundaries
- Keep navigation, interaction, assertions, and screenshots in the same page session.
- Coordinate one browser operator at a time across actors. Other actors request the evidence they need.
- Use a local HTTP preview for local pages. Default filesystem restrictions remain enabled.
- Save temporary screenshots in scratchpad. Omit a screenshot filename to use the server's isolated scratchpad output directory.
- Ordinary screenshots capture the current state; they do not promise deterministic animation time or byte-identical images.

## 3. Procedure
1. Call `mcp` with `server: "playwright", action: "list"` to discover available tools and parameters.
2. Navigate to the page, then call `browser_snapshot` without a filename for inline accessibility content and current element references. Navigation and click responses may link to saved snapshots instead.
3. Click, type, or press keys using the listed parameter schema and current element references. Call `browser_snapshot` again to observe the resulting state.
4. Verify the expected visible state, then take a screenshot without reopening the page.
5. Inspect the image returned by MCP directly. Use `Read` only if the result provides a saved image path instead of image content.
6. Close the browser when verification finishes.

## 4. Verification & Done Criteria
Report the action performed, observed state, screenshot evidence, and any unverified behavior. A rendered page or simulated DOM test alone does not prove real interaction. If browser prerequisites are missing, report the setup requirement rather than attempting an offline package download.
