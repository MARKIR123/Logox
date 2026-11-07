---
name: browser-screenshot
description: Verify local web pages through one Playwright MCP session with real interaction and visible screenshots
---

# Browser Verification

## 1. Context & Purpose
Use the local `playwright` MCP server for HTML, SVG, canvas, and browser UI verification. The installed server and prepared browser run without Internet access; page resources and model providers have independent network requirements.

## 2. Boundaries
- Keep navigation, interaction, assertions, and screenshots in the same page session.
- Every actor has its own isolated browser instance. Never wait for another actor to release a browser, and never send "browser free" handoffs.
- Local files open directly with `file:///` URLs (for example `file:///G:/project/index.html`, forward slashes, three slashes); the server runs with unrestricted file access, so workspace and scratchpad paths both work. Prefer this over starting an HTTP server. Use HTTP only when the page needs a real origin (fetch, ES modules, service workers).
- Save temporary screenshots and other artifacts in scratchpad. Omit a screenshot filename to use the server's isolated scratchpad output directory.
- `browser_run_code` runs in a sandbox without `require` or dynamic `import`: use only the Playwright `page` object it provides, and run Node-side work (file reads, scripts) with `Shell` instead.
- Never replace real clicks with synthetic DOM events to claim an interaction passed.
- Ordinary screenshots capture the current state; they do not promise deterministic animation time or byte-identical images.

## 3. Procedure
1. Start the HTTP preview for local files and verify its port is listening.
2. Call `mcp` with `server: "playwright", action: "list"` to discover available tools and parameters.
3. Navigate to the page, then call `browser_snapshot` without a filename for inline accessibility content and current element references. Navigation and click responses may link to saved snapshots instead.
4. Click, type, or press keys using the listed parameter schema and current element references. Call `browser_snapshot` again to observe the resulting state.
5. Verify the expected visible state, then take a screenshot without reopening the page.
6. Inspect the image returned by MCP directly. Use `Read` only if the result provides a saved image path instead of image content.
7. Close your browser and stop any preview server you started when verification finishes.

## 4. Verification & Done Criteria
Report the action performed, observed state, screenshot evidence, and any unverified behavior. A rendered page or simulated DOM test alone does not prove real interaction. If browser prerequisites are missing, report the setup requirement rather than downloading a browser during an offline task.
