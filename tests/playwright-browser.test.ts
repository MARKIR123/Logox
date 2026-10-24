import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../src/config/config.js';
import {ProjectExtensions} from '../src/extensions/runtime.js';
import {playwrightServer} from '../src/extensions/playwright.js';
import type {ActorContext} from '../src/actors/ensemble.js';

const enabled = process.env.LOGOX_BROWSER_TEST === '1';

test('local Playwright preserves page state and returns screenshots while offline', {skip: !enabled, timeout: 120_000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-playwright-'));
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html><head><title>Offline browser verification</title></head><body>' +
      '<h1>Local verification</h1><button onclick="const s=document.getElementById(\'status\');s.textContent=s.textContent===\'Running\'?\'Paused\':\'Running\'">START</button>' +
      '<p id="status" role="status">Running</p></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = await loadConfig(cwd, {}, {}, cwd, cwd);
  const browser = playwrightServer(cwd);
  config.mcp.servers.playwright = {...browser, args: [...browser.args, '--caps', 'network']};
  const extensions = new ProjectExtensions(cwd, config, {home: cwd, boundary: cwd}, async () => true);
  const context: ActorContext = {sessionId: 'browser-test', activityId: 'verify', ownerId: 'logox', history: [],
    signal: new AbortController().signal, report() {}, say() {}, record: async () => {},
    permission: async () => false, ask: async () => ({status: 'cancelled', reason: 'test'})};
  const invoke = async (tool: string, args: Record<string, unknown> = {}) => {
    const result = await extensions.mcp.execute({id: tool, name: 'mcp', arguments: JSON.stringify({
      server: 'playwright', action: 'call', tool, arguments: args,
    })}, context);
    assert.equal(result.isError, false, result.text);
    return result;
  };
  const startRef = (text: string) => {
    const match = /button "START"[^\n]*\[ref=([^\]]+)\]/.exec(text);
    assert.ok(match, text);
    return match[1]!;
  };
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    await invoke('browser_navigate', {url: `http://127.0.0.1:${address.port}`});
    const page = await invoke('browser_snapshot');
    assert.match(page.text, /Running/);
    await invoke('browser_network_state_set', {state: 'offline'});
    await invoke('browser_click', {element: 'START', target: startRef(page.text)});
    const paused = await invoke('browser_snapshot');
    assert.match(paused.text, /Paused/);
    const shot = await invoke('browser_take_screenshot', {type: 'png', scale: 'css'});
    assert.equal(shot.images?.length, 1);
    assert.equal(shot.images[0]!.mimeType, 'image/png');
    const png = Buffer.from(shot.images[0]!.data, 'base64');
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.ok(png.length > 100);
    const state = await invoke('browser_snapshot');
    await invoke('browser_click', {element: 'START', target: startRef(state.text)});
    const resumed = await invoke('browser_snapshot');
    assert.match(resumed.text, /Running/);
    await invoke('browser_close');
    const args = extensions.mcp.servers.playwright!.args;
    const output = args[args.indexOf('--output-dir') + 1]!;
    const screenshots = (await readdir(output)).filter(file => file.endsWith('.png'));
    assert.ok(screenshots.length);
    console.log('Browser evidence: ' + join(output, screenshots[0]!));
  } finally {
    await extensions.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(cwd, {recursive: true, force: true});
  }
});
