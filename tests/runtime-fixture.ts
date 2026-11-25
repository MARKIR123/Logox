import type {RuntimeSnapshot} from '../src/runtime/contracts.js';
import type {RuntimeStore} from '../src/runtime/store.js';
import {createApplication as productionApplication} from '../src/application.js';
import type {ModelTurn, Provider} from '../src/runtime/messages.js';
import {summarizeRound} from '../src/context/contracts.js';
import {parseSynopsis, synopsisBlock} from '../src/context/synopsis.js';
import {realpath} from 'node:fs/promises';
import {projectDataDir} from '../src/config/project-data.js';

/** Adapt plain successful fixtures to the round-memory protocol: a complete text reply without calls ends with a synopsis, so the round closes without the follow-up that asks for one. Recovery and error turns are left alone. */
export function finalizingProvider(provider: Provider): Provider {
  return {async respond(request, delta, signal) {
    const turn = await provider.respond(request, delta, signal);
    if (!request.tools.length) return turn; // summaries and Anamnesis runs offer no tools and never close a round
    if (turn.stop !== 'complete' || !turn.message.text.trim() || turn.message.toolCalls?.length || parseSynopsis(turn.message.text).synopsis) return turn;
    const summary = summarizeRound([turn.message], 'completed');
    return {...turn, message: {...turn.message, text: turn.message.text + '\n\n' + synopsisBlock({title: summary.title.slice(0, 120), summary: summary.report.slice(0, 200) || 'Round outcome.'})}} satisfies ModelTurn;
  }};
}
/** The project data folder (`<home>/.logox/projects/<key>`) an application started on `cwd` with `resourceOptions.home = home` uses; `home` defaults to `cwd`, the usual test isolation. */
export async function projectData(cwd: string, home: string = cwd): Promise<string> {
  return projectDataDir(await realpath(cwd), home);
}
export function createTestApplication(options: Parameters<typeof productionApplication>[0]) {
  return productionApplication({...options, ...(options.provider ? {provider: finalizingProvider(options.provider)} : {})});
}

export function waitForSnapshot(store: RuntimeStore, predicate: (snapshot: RuntimeSnapshot) => boolean, timeoutMs = 15000): Promise<void> {
  if (predicate(store.getSnapshot())) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {unsubscribe(); reject(new Error('运行时未到达预期状态（等待 ' + timeoutMs + 'ms 后超时）: ' + JSON.stringify(store.getSnapshot().activities.map(a => [a.ownerId, a.status, a.phase]))));}, timeoutMs);
    const unsubscribe = store.subscribe(() => {
      if (predicate(store.getSnapshot())) {clearTimeout(timeout); unsubscribe(); resolve();}
    });
  });
}
