import {createContext, type ReactNode} from 'react';
import {Writable} from 'node:stream';
import {render, type Instance, type RenderOptions} from 'ink';
import {TerminalPlane, type PlaneMetrics} from './terminal-plane.js';

export const TerminalPlaneContext = createContext<TerminalPlane | null>(null);
type TerminalStream = NodeJS.WritableStream & {readonly columns?: number; readonly rows?: number; readonly isTTY?: boolean};
export interface TerminalOptions extends RenderOptions {readonly onHistoryFrame?: (metrics: PlaneMetrics) => void}

/** One output owner orders Ink writes and the history canvas, without patching Ink internals. */
export function renderTerminal(node: ReactNode, options: TerminalOptions = {}): Instance {
  const terminal: TerminalStream = options.stdout ?? process.stdout;
  if (!options.alternateScreen || options.interactive === false || !terminal.isTTY || options.debug ||
      (options.interactive === undefined && process.env['CI'] && process.env['CI'] !== 'false') ||
      options.isScreenReaderEnabled || process.env['INK_SCREEN_READER'] === 'true') return render(node, options);
  const synchronized = /\x1b\[\?2026[hl]/g;
  let restoration: string[] | undefined;
  const plane = new TerminalPlane(text => {
    if (restoration) restoration.push(text.replace(synchronized, ''));
    else terminal.write(text);
  }, options.onHistoryFrame);
  const output = new class extends Writable {
    private batch: string[] | undefined;
    get isTTY(): boolean {return Boolean(terminal.isTTY);}
    get columns(): number {return terminal.columns ?? 80;}
    get rows(): number {return terminal.rows ?? 24;}
    override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
      const text = chunk.toString();
      if (text.includes('\x1b[?2026h') && !this.batch) {this.batch = []; plane.beginOutput();}
      if (this.batch) {
        this.batch.push(text.replace(synchronized, ''));
        if (!text.includes('\x1b[?2026l')) {done(); return;}
        const batch = this.batch.join(''); this.batch = undefined;
        this.commit(batch, done);
      } else this.commit(text, done);
    }
    private commit(text: string, done: (error?: Error | null) => void): void {
      // Ink writes BSU, content and ESU as separate chunks. Restore history before
      // the sole ESU; a nested plane ESU would expose Ink's cleared middle frame.
      plane.beginOutput(); restoration = [];
      try {
        plane.afterInkWrite(text); plane.endOutput();
        const content = text.replace(synchronized, '') + restoration.join('');
        restoration = undefined;
        if (content) terminal.write('\x1b[?2026h' + content + '\x1b[?2026l', done);
        else done();
      } catch (error) {restoration = undefined; done(error instanceof Error ? error : new Error(String(error)));}
    }
    override _final(done: (error?: Error | null) => void): void {
      if (this.batch) {const text = this.batch.join(''); this.batch = undefined; this.commit(text, done);}
      else done();
    }
  }();
  const resize = () => {plane.hide(); output.emit('resize');};
  terminal.on('resize', resize);
  let cleaned = false;
  const cleanup = () => {if (cleaned) return; cleaned = true; plane.dispose(); terminal.removeListener('resize', resize);};
  const wrap = (content: ReactNode) => <TerminalPlaneContext.Provider value={plane}>{content}</TerminalPlaneContext.Provider>;
  let ink: Instance;
  try {ink = render(wrap(node), {...options, stdout: output});}
  catch (error) {cleanup(); throw error;}
  const exited = ink.waitUntilExit().finally(() => {cleanup(); output.destroy();});
  // Consumers may use unmount without awaiting exit; detach immediately in that case as well.
  return {...ink, rerender: content => ink.rerender(wrap(content)), unmount: () => {cleanup(); ink.unmount();},
    clear: () => {plane.hide(); ink.clear();}, waitUntilExit: () => exited,
    waitUntilRenderFlush: async () => {
      await ink.waitUntilRenderFlush(); plane.flush();
      await new Promise<void>((resolve, reject) => terminal.write('', error => error ? reject(error) : resolve()));
    }};
}
