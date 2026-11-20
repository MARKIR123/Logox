import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DynamicEnsemble, type ActorContext, type ActorExecutor} from '../src/actors/ensemble.js';
import {ActorServices, type ActorServicesOptions} from '../src/actors/services.js';
import {DeliveryQueue} from '../src/actors/delivery-queue.js';
import {ActorCatalog} from '../src/actors/catalog.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {Resources} from '../src/resources/manager.js';
import {loadConfig} from '../src/config/config.js';
import {Journal} from '../src/store/journal.js';
import {RuntimeStore} from '../src/runtime/store.js';

/** The Actor tool call a Director makes. */
export const actorCall = (tasks: readonly Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({id: 'dispatch', name: 'Actor', arguments: JSON.stringify({tasks, ...extra})});

/** An ensemble, its services, a store and a journal over a temp directory, with `execute` as every actor's behaviour. */
export async function delegationFixture(execute: (prompt: string, context: ActorContext, services: ActorServices) => Promise<void>, options: Partial<ActorServicesOptions> = {}, concurrency: 'serial' | 'actor' = 'serial') {
  const directory = await mkdtemp(join(tmpdir(), 'logox-delegation-'));
  const config = await loadConfig(directory, {}, {}, directory, directory);
  const catalog = new ActorCatalog(directory, {home: directory}); await catalog.load();
  const journal = new Journal(join(directory, 'journal')), store = new RuntimeStore();
  const deliveries = new DeliveryQueue('s', journal);
  let services!: ActorServices;
  const run: ActorExecutor<string> = async (prompt, context) => {
    services.definition(context);
    await context.drainInbox?.();
    await execute(prompt, context, services);
  };
  const ensemble = new DynamicEnsemble('s', store, journal, run, {deliveries, concurrency, member: owner => catalog.find(owner),
    handoff: result => services.handoff(result), settled: (activity, status) => services.settled(activity, status)});
  services = new ActorServices({sessionId: 's', catalog, config, journal, deliveries, registry: new ProviderRegistry(config, {}),
    resources: new Resources(directory, {home: directory, boundary: directory}), requireIdle() {}, outageDelaysMs: [5], approve: async () => false,
    getSnapshot: () => store.getSnapshot(), getActiveTask: owner => ensemble.getActiveTask(owner), canReceiveMessage: owner => ensemble.canReceiveMessage(owner),
    enqueue: (owner, prompt, source, origin) => ensemble.dispatch(owner, prompt, source, origin),
    pauseBatch: id => ensemble.pauseBatch(id), resumeBatch: id => ensemble.resumeBatch(id), coordinationPath: join(directory, 'coordination.json'), ...options});
  await services.recover();
  const idle = async () => {
    const deadline = Date.now() + 5000;
    while (ensemble.isBusy() || services.outageWaiting) {if (Date.now() > deadline) throw new Error('The ensemble did not settle'); await new Promise(resolve => setTimeout(resolve, 5));}
  };
  return {directory, ensemble, services, store, journal, idle, catalog,
    async close() {await ensemble.close(); await services.flush(); await rm(directory, {recursive: true, force: true});}};
}
export function barrier() {let resolve!: () => void; const promise = new Promise<void>(finish => {resolve = finish;}); return {promise, resolve};}
