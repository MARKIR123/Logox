import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

type Params = Record<string, any>;
type Message = {id?: number; method?: string; params?: Params; result?: Params; error?: {message: string}};
export interface ShotOptions {url: string; width: number; height: number; fullPage: boolean; times: number[]}

export function findBrowser(): string {
  const candidates = [process.env['CHROME_PATH'], 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  for (const path of candidates) if (path && existsSync(path)) return path;
  for (const name of ['chrome', 'msedge', 'chromium', 'google-chrome']) {
    const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {encoding: 'utf8'});
    const path = result.stdout?.trim().split(/\r?\n/)[0];
    if (path && existsSync(path)) return path;
  }
  throw new Error('No Chromium browser found');
}

class Connection {
  private id = 0;
  private pending = new Map<number, {resolve: (value: Params) => void; reject: (error: Error) => void}>();
  private listeners = new Map<string, Set<(params: Params) => void>>();
  private socket: WebSocket;
  constructor(url: string, private signal: AbortSignal) {
    const WS = (globalThis as any).WebSocket as typeof WebSocket;
    this.socket = new WS(url);
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as Message;
      if (message.id !== undefined) {
        const item = this.pending.get(message.id);
        if (!item) return;
        this.pending.delete(message.id);
        if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result ?? {});
      } else if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
      }
    });
    const fail = () => this.fail(new Error('CDP connection closed'));
    this.socket.addEventListener('close', fail);
    this.socket.addEventListener('error', fail);
    signal.addEventListener('abort', () => {this.fail(new Error('CDP deadline exceeded')); this.close();}, {once: true});
  }
  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (this.signal.aborted) {reject(new Error('CDP aborted')); return;}
      const done = (error?: Error) => {clearTimeout(timer); this.socket.removeEventListener('open', opened); this.socket.removeEventListener('error', failed); error ? reject(error) : resolve();};
      const opened = () => done();
      const failed = () => done(new Error('CDP WebSocket unavailable'));
      const timer = setTimeout(failed, 3000);
      this.socket.addEventListener('open', opened, {once: true});
      this.socket.addEventListener('error', failed, {once: true});
    });
  }
  private fail(error: Error): void {for (const item of this.pending.values()) item.reject(error); this.pending.clear();}
  send(method: string, params: Params = {}, sessionId?: string): Promise<Params> {
    this.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, {resolve, reject});
      try {this.socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));}
      catch (error) {this.pending.delete(id); reject(error);}
    });
  }
  on(method: string, listener: (params: Params) => void): () => void {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener); this.listeners.set(method, listeners);
    return () => {listeners.delete(listener);};
  }
  once(method: string, timeout = 10000): Promise<Params> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, params: Params = {}) => {clearTimeout(timer); off(); this.signal.removeEventListener('abort', aborted); error ? reject(error) : resolve(params);};
      const off = this.on(method, params => finish(undefined, params));
      const aborted = () => finish(new Error(`Aborted waiting for ${method}`));
      const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${method}`)), timeout);
      this.signal.addEventListener('abort', aborted, {once: true});
    });
  }
  close(): void {try {this.socket.close();} catch { /* Already closed. */ }}
}

// Native headless rAF delivery follows compositor wall time, even under virtual time.
// Queue only rAF callbacks, then pump fixed timestamps after explicit CDP budgets.
// Timers/CSS/network remain Chromium-managed; target source is never rewritten.
const FRAME_CLOCK = `(() => {
  let id = 0, queue = new Map();
  window.requestAnimationFrame = callback => { queue.set(++id, callback); return id; };
  window.cancelAnimationFrame = key => queue.delete(key);
  Object.defineProperty(window, '__browserShotFrame', { value: time => {
    const batch = [...queue]; queue.clear();
    for (const [, callback] of batch) { try { callback(time); } catch (error) { console.error(error); } }
  }});
})();`;

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    await new Promise<void>(resolve => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
      killer.once('error', () => resolve()); killer.once('close', () => resolve());
    });
  } else child.kill('SIGKILL');
  await Promise.race([new Promise<void>(resolve => child.once('close', () => resolve())), sleep(1500)]);
}

export async function capture(options: ShotOptions): Promise<Buffer[]> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 20000);
  const signal = controller.signal;
  const profile = await mkdtemp(join(tmpdir(), 'browser-shot-cdp-'));
  let child: ChildProcess | undefined;
  let connection: Connection | undefined;
  let launchError: Error | undefined;
  try {
    child = spawn(findBrowser(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=1', '--disable-background-networking', '--disable-extensions', 'about:blank'],
    {windowsHide: true, stdio: 'ignore'});
    child.once('error', error => {launchError = error; controller.abort();});
    let port = '', wsPath = '';
    while (!port || !wsPath) {
      signal.throwIfAborted();
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error(`Chrome exited ${child.exitCode}`);
      try {[port = '', wsPath = ''] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);} catch { /* File appears after startup. */ }
      if (!port || !wsPath) await sleep(25, undefined, {signal});
    }
    connection = new Connection(`ws://127.0.0.1:${port}${wsPath}`, signal);
    await connection.open();
    const cdp = connection;
    const {targetInfos} = await cdp.send('Target.getTargets');
    const target = targetInfos.find((item: Params) => item['type'] === 'page');
    if (!target) throw new Error('No page target');
    const {sessionId} = await cdp.send('Target.attachToTarget', {targetId: target.targetId, flatten: true});
    const send = (method: string, params: Params = {}) => cdp.send(method, params, sessionId);
    const evaluate = async (expression: string, awaitPromise = false) => {
      const result = await send('Runtime.evaluate', {expression, awaitPromise, returnByValue: true});
      if (result['exceptionDetails']) throw new Error(JSON.stringify(result['exceptionDetails']));
      return result['result']?.value;
    };
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', {width: options.width, height: options.height, deviceScaleFactor: 1, mobile: false});
    // The virtual clock must NOT be paused before navigation: a paused clock never
    // delivers Page.loadEventFired, so every capture would time out and fall back.
    // Freeze immediately after the page is ready instead (see below).
    await send('Page.addScriptToEvaluateOnNewDocument', {source: FRAME_CLOCK});
    const inFlight = new Set<string>();
    let lastNetwork = Date.now();
    const off = [
      cdp.on('Network.requestWillBeSent', p => {inFlight.add(p['requestId']); lastNetwork = Date.now();}),
      ...['Network.loadingFinished', 'Network.loadingFailed'].map(event => cdp.on(event, p => {inFlight.delete(p['requestId']); lastNetwork = Date.now();})),
    ];
    const loaded = cdp.once('Page.loadEventFired');
    // Attach rejection handling immediately if navigation itself fails.
    void loaded.catch(() => {});
    const navigation = await send('Page.navigate', {url: options.url});
    if (navigation['errorText']) throw new Error(navigation['errorText']);
    await loaded;
    await evaluate('document.fonts.ready.then(() => true)', true);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); window.__browserShotFrame(0); window.__browserShotFrame(0);', false);
    while (inFlight.size || Date.now() - lastNetwork < 150) {signal.throwIfAborted(); await sleep(25, undefined, {signal});}
    for (const unsubscribe of off) unsubscribe();
    // Freeze only now: load has completed, so the remaining budget is pure animation time.
    await send('Emulation.setVirtualTimePolicy', {policy: 'pause'});
    let elapsed = 0;
    const shots: Buffer[] = [];
    for (const targetTime of options.times) {
      while (elapsed + 0.000001 < targetTime) {
        const next = Math.min(targetTime, (Math.floor((elapsed + 0.000001) / (1000 / 60)) + 1) * (1000 / 60));
        const expired = cdp.once('Emulation.virtualTimeBudgetExpired'); void expired.catch(() => {});
        await send('Emulation.setVirtualTimePolicy', {policy: 'advance', budget: next - elapsed});
        await expired;
        await evaluate(`window.__browserShotFrame(${next})`);
        elapsed = next;
      }
      await send('Emulation.setVirtualTimePolicy', {policy: 'pause'});
      const params: Params = {format: 'png', captureBeyondViewport: options.fullPage};
      if (options.fullPage) {
        const layout = await send('Page.getLayoutMetrics');
        params['clip'] = {x: 0, y: 0, width: layout['cssContentSize'].width, height: layout['cssContentSize'].height, scale: 1};
      }
      const result = await send('Page.captureScreenshot', params);
      shots.push(Buffer.from(result['data'], 'base64'));
    }
    await cdp.send('Browser.close').catch(() => {});
    return shots;
  } finally {
    clearTimeout(deadline);
    connection?.close();
    if (child) {
      await Promise.race([new Promise<void>(resolve => {if (child!.exitCode !== null || child!.signalCode !== null) resolve(); else child!.once('close', () => resolve());}), sleep(1000)]);
      await terminate(child);
    }
    await rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  }
}
