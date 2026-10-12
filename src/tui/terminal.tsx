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
  const plane = new TerminalPlane(text => {terminal.write(text);}, options.onHistoryFrame);
  const output = new class extends Writable {
    get isTTY(): boolean {return Boolean(terminal.isTTY);}
    get columns(): number {return terminal.columns ?? 80;}
    get rows(): number {return terminal.rows ?? 24;}
    override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
      terminal.write(chunk, error => {if (!error) plane.afterInkWrite(chunk.toString()); done(error);});
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
