import type {RuntimeSnapshot} from '../src/runtime/contracts.js';
import type {RuntimeStore} from '../src/runtime/store.js';
import {createApplication as productionApplication} from '../src/application.js';
import type {ModelTurn, Provider} from '../src/runtime/messages.js';
import {summarizeRound} from '../src/context/contracts.js';

/** Adapt legacy successful fixtures to the new terminal protocol, never recovery/error turns. */
export function finalizingProvider(provider: Provider): Provider {
  let ordinal = 0;
  return {async respond(request, delta, signal) {
    const turn = await provider.respond(request, delta, signal);
    if (!request.tools.some(tool => tool.name === '_FinishRound') || turn.stop !== 'complete' || !turn.message.text.trim() || turn.message.toolCalls?.length) return turn;
    const summary = summarizeRound([turn.message], 'completed');
    return {...turn, stop: 'tools', message: {...turn.message, toolCalls: [{id: 'fixture-finish-' + ++ordinal, name: '_FinishRound',
      arguments: JSON.stringify({title: summary.title.slice(0, 120), verification: null, carry_forward: []})}]}} satisfies ModelTurn;
  }};
}
export function createTestApplication(options: Parameters<typeof productionApplication>[0]) {
  return productionApplication({...options, ...(options.provider ? {provider: finalizingProvider(options.provider)} : {})});
}

export function waitForSnapshot(store: RuntimeStore, predicate: (snapshot: RuntimeSnapshot) => boolean, timeoutMs = 3000): Promise<void> {
  if (predicate(store.getSnapshot())) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {unsubscribe(); reject(new Error('运行时未到达预期状态'));}, timeoutMs);
    const unsubscribe = store.subscribe(() => {
      if (predicate(store.getSnapshot())) {clearTimeout(timeout); unsubscribe(); resolve();}
    });
  });
}
