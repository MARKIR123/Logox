// Terminal input plumbing owned by the full-screen app: enables SGR mouse and focus reporting for as long as the app is
// mounted, and wraps `stdin.read` so mouse sequences reach the mouse handler and focus reports never reach the key parser.
import {useEffect, type MutableRefObject} from 'react';
import type {useStdin, useStdout} from 'ink';
import {FocusReportFilter, FOCUS_REPORTING_OFF, FOCUS_REPORTING_ON} from './focus.js';
import {parseSgrMouse, type SgrMouseEvent} from './mouse.js';

export function useTerminalInput(stdin: ReturnType<typeof useStdin>['stdin'], stdout: ReturnType<typeof useStdout>['stdout'],
  mouseHandlerRef: MutableRefObject<(event: SgrMouseEvent) => void>, foldTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>): void {
  useEffect(() => {
    if (!stdin) return;
    stdout?.write('\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[2 q' + FOCUS_REPORTING_ON);
    const originalRead = stdin.read.bind(stdin);
    let carry = '';
    const focusFilter = new FocusReportFilter();
    stdin.read = ((size?: number) => {
      // A chunk that held only focus reports is swallowed and the next read is taken from the stream itself: answering `null` while the
      // stream still owes its own end-of-buffer read stalls the TTY handle, and the process exits with an empty event loop.
      for (;;) {
        const chunk = originalRead(size);
        if (chunk === null || chunk === undefined) return chunk;
        const raw = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        const text = carry + raw;
        const events = parseSgrMouse(text);
        for (let i = 0; i < events.length; i++) {
          const ev = events[i]!;
          if (ev.action === 'drag' && i + 1 < events.length && events[i + 1]!.action === 'drag') continue;
          if (ev.action === 'move' && i + 1 < events.length && events[i + 1]!.action === 'move') continue;
          mouseHandlerRef.current(ev);
        }
        const tail = /\[<[\d;]*$/.exec(text);
        carry = tail ? tail[0] : '';
        // Focus reports (`ESC [ I` / `ESC [ O`) update the terminal focus state and never reach the key parser.
        let cleaned = raw;
        try {cleaned = focusFilter.push(raw);} catch {cleaned = raw;}
        if (cleaned === raw) return chunk;
        if (cleaned === '') continue;
        return (typeof chunk === 'string' ? cleaned : Buffer.from(cleaned)) as typeof chunk;
      }
    }) as typeof stdin.read;
    return () => {
      if (foldTimerRef.current) clearTimeout(foldTimerRef.current);
      stdin.read = originalRead;
      stdout?.write('\x1b[0 q\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l' + FOCUS_REPORTING_OFF);
    };
  }, [stdin, stdout]);
}
