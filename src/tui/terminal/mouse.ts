import {createContext, createElement, useContext, useEffect, useRef, useState, type ReactNode} from 'react';
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

/** Colour a hovered control takes: the window actor's colour, set once by the host. */
export const HoverColorContext = createContext<string | null>(null);
/** Provides the shared mouse feed and the window hover colour to a surface. */
export function MouseHost({subscribe, color, children}: {readonly subscribe: MouseSubscriber; readonly color: string; readonly children?: ReactNode}) {
  return createElement(MouseContext.Provider, {value: subscribe}, createElement(HoverColorContext.Provider, {value: color}, children));
}
export function useHoverColor(fallback: string): string {return useContext(HoverColorContext) ?? fallback;}
export interface Pointer {readonly x: number; readonly y: number}
/** Last known pointer cell (moves, presses and drags); null before the first event. Wheel and release keep it. */
export function usePointer(): Pointer | null {
  const [pointer, setPointer] = useState<Pointer | null>(null);
  useMouse(event => {
    if (event.action === 'wheel_up' || event.action === 'wheel_down' || event.action === 'release') return;
    setPointer(previous => previous && previous.x === event.x && previous.y === event.y ? previous : {x: event.x, y: event.y});
  });
  return pointer;
}
/** A hit region in screen cells: columns [x0, x1) on row y. */
export interface Region {readonly y: number; readonly x0: number; readonly x1: number}
export function inRegion(pointer: Pointer | null, region: Region): boolean {
  return pointer !== null && pointer.y === region.y && pointer.x >= region.x0 && pointer.x < region.x1;
}
