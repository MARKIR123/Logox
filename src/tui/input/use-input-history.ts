// Per-session, per-window input history: the human messages already in the store are recorded as they appear, so Up/Down
// recall survives a session restore and a window switch. History objects live in refs and are never recreated.
import {useRef} from 'react';
import type {RuntimeSnapshot} from '../../runtime/contracts.js';
import {inputKind} from '../../runtime/provenance.js';
import {InputHistory} from './editor.js';

export function useInputHistory(snapshot: RuntimeSnapshot, sessionId: string) {
  const inputHistories = useRef(new Map<string, InputHistory>());
  const historyMessages = useRef(new Set<string>());
  const historyFor = (ownerId: string) => {
    const key = sessionId + ':' + ownerId;
    let history = inputHistories.current.get(key);
    if (!history) {history = new InputHistory(); inputHistories.current.set(key, history);}
    return history;
  };
  for (const message of snapshot.messages) {
    if (message.sessionId !== sessionId || historyMessages.current.has(message.id)) continue;
    historyMessages.current.add(message.id);
    if (message.role === 'user' && inputKind(message) === 'human') historyFor(message.ownerId).record(message.text);
  }
  return historyFor;
}
