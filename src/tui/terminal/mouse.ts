import {createContext, useContext, useEffect, useRef} from 'react';
import {useStdin} from 'ink';

export interface SgrMouseEvent {
  readonly button: number; readonly x: number; readonly y: number;
  readonly action: 'press' | 'move' | 'drag' | 'release' | 'wheel_up' | 'wheel_down';
}
const sgrMouseRe = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
export function parseSgrMouse(chunk: string): readonly SgrMouseEvent[] {
  const events: SgrMouseEvent[] = [];
  for (const match of chunk.matchAll(sgrMouseRe)) {
    const button = Number.parseInt(match[1]!, 10), x = Math.max(0, Number.parseInt(match[2]!, 10) - 1), y = Math.max(0, Number.parseInt(match[3]!, 10) - 1);
    const action: SgrMouseEvent['action'] = button === 64 ? 'wheel_up' : button === 65 ? 'wheel_down' : match[4] === 'm' ? 'release' : (button & 32) !== 0 ? ((button & 3) === 3 ? 'move' : 'drag') : 'press';
    events.push({button: button & 3, x, y, action});
  }
  return events;
}
export type MouseSubscriber = (handler: (event: SgrMouseEvent) => void) => () => void;
export const MouseContext = createContext<MouseSubscriber | null>(null);
/** Observe Ink's reads without consuming keys or enabling another input mode. */
export function useMouse(handler: (event: SgrMouseEvent) => void): void {
  const {stdin} = useStdin(), subscribe = useContext(MouseContext), current = useRef(handler); current.current = handler;
  useEffect(() => {
    if (subscribe) return subscribe(event => current.current(event));
    const read = stdin.read.bind(stdin);
    let carry = '';
    stdin.read = ((size?: number) => {
      const chunk = read(size);
      if (chunk !== null && chunk !== undefined) {
        const text = carry + String(chunk);
        for (const event of parseSgrMouse(text)) current.current(event);
        carry = /\x1b\[<[\d;]*$/.exec(text)?.[0] ?? '';
      }
      return chunk;
    }) as typeof stdin.read;
    return () => {stdin.read = read;};
  }, [stdin, subscribe]);
}
