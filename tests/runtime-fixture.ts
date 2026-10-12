import type {RuntimeSnapshot} from '../src/runtime/contracts.js';
import type {RuntimeStore} from '../src/runtime/store.js';

export function waitForSnapshot(store: RuntimeStore, predicate: (snapshot: RuntimeSnapshot) => boolean): Promise<void> {
  if (predicate(store.getSnapshot())) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {unsubscribe(); reject(new Error('运行时未到达预期状态'));}, 3000);
    const unsubscribe = store.subscribe(() => {
      if (predicate(store.getSnapshot())) {clearTimeout(timeout); unsubscribe(); resolve();}
    });
  });
}
