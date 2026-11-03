import {RuntimeStore} from '../src/runtime/store.js';
import {Steps} from '../src/runtime/steps.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import type {SceneRow} from '../src/tui/timeline/scene.js';

/** One completed (or failed) tool call in the Director's timeline; `rows()` renders it open by default. */
export function toolFixture(name: string, args: Record<string, unknown>, result: string, state: 'completed' | 'failed' = 'completed') {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'main', ownerId: 'logox', kind: 'director', title: 'Main', status: 'running', stage: 'x', detail: ''});
  store.message('s', 'user', 'user', 'Go.', {activityId: 'main', inputKind: 'human'});
  const steps = new Steps(store, {sessionId: 's', activityId: 'main', ownerId: 'logox'});
  const id = steps.tool({id: 'c1', name, arguments: JSON.stringify(args)});
  steps.start(id); steps.finish(id, state, name + '\n' + result, state === 'failed' ? 'error' : undefined);
  const rows = (folds: Record<string, boolean> = {}, hovered: string | null = null, width = 100): readonly SceneRow[] =>
    buildStageRows(store.getSnapshot(), 's', 'logox', width, {[id]: true, ...folds}, hovered);
  return {id, rows};
}
export const rowText = (row: SceneRow) => row.displayText ?? row.text;
