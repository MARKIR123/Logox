import {createContext, useContext, useEffect, useRef} from 'react';
import {useStdin} from 'ink';
import {parseSgrMouse, type SgrMouseEvent} from './viewport.js';
export type MouseSubscriber = (handler: (event: SgrMouseEvent) => void) => () => void;
export const MouseContext = createContext<MouseSubscriber | null>(null);

/** Ink reads stdin directly; observe its read without consuming keys or enabling another input mode. */
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
