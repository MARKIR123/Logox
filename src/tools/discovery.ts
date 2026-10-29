import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {ModelMessage, ToolDiscoveryProtocol} from '../runtime/messages.js';
import {createRuntimeContextMessage, type RuntimeContextMessage} from '../runtime/context-updates.js';
import type {ResolvedTool} from './catalog.js';
import type {ToolRegistry} from './registry.js';
import {canonicalToolName} from './types.js';

export function resolveToolLoad(args: {names: readonly string[]}, pool: readonly ResolvedTool[], discovered: ReadonlySet<string>):
  {loaded: readonly string[]; alreadyLoaded: readonly string[]; unavailable: readonly string[]} {
  const loaded: string[] = [], alreadyLoaded: string[] = [], unavailable: string[] = [], seen = new Set<string>();
  for (const name of args.names) {
    const canonical = canonicalToolName(name) ?? name;
    const item = pool.find(tool => tool.definition.name.toLowerCase() === canonical.toLowerCase());
    const key = (item?.definition.name ?? canonical).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!item) unavailable.push(name);
    else if (item.metadata.loading === 'eager' || discovered.has(item.definition.name)) alreadyLoaded.push(item.definition.name);
    else loaded.push(item.definition.name);
  }
  return {loaded, alreadyLoaded, unavailable};
}
export function resolveExposureProtocol(pool: readonly ResolvedTool[], supported: ToolDiscoveryProtocol): ToolDiscoveryProtocol {
  return supported !== 'none' && pool.some(item => item.definition.name === 'LoadTools' && item.metadata.loading === 'eager') &&
    pool.some(item => item.metadata.loading === 'deferred') ? supported : 'none';
}
export function buildToolExposure(pool: readonly ResolvedTool[], discovered: ReadonlySet<string>, protocol: ToolDiscoveryProtocol) {
  protocol = resolveExposureProtocol(pool, protocol);
  if (protocol === 'none') return pool.filter(item => item.definition.name !== 'LoadTools').map(item => item.definition);
  const eager = pool.filter(item => item.metadata.loading === 'eager').map(item => item.definition);
  const deferred = pool.filter(item => item.metadata.loading === 'deferred' && discovered.has(item.definition.name))
    .map(item => ({...item.definition, deferLoading: true as const}));
  return [...eager, ...deferred];
}
export function extractDiscoveredToolNames(messages: readonly ModelMessage[], carried: readonly string[] = []): ReadonlySet<string> {
  const names = [...carried];
  for (const message of messages) if (message.role === 'tool' && message.name === 'LoadTools' && !message.isError) names.push(...message.discoveredTools ?? []);
  return new Set([...new Set(names)].sort());
}

export function collectDiscoveredTools(messages: readonly ModelMessage[], previous: readonly string[] = []): readonly string[] {
  return [...extractDiscoveredToolNames(messages, previous)];
}
/** Keep only real completed discovery pairs; names without evidence cannot expand a contract. */
export function retainDiscoveryPairs(messages: readonly ModelMessage[], names: ReadonlySet<string>): readonly ModelMessage[] {
  const pending = new Map<string, Extract<ModelMessage, {role: 'assistant'}>>();
  const covered = new Set<string>(), output: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && !message.contextExcluded && !message.toolsExcluded) {
      for (const call of message.toolCalls ?? []) if (canonicalToolName(call.name) === 'LoadTools') pending.set(call.id, message);
    } else if (message.role === 'tool') {
      const assistant = pending.get(message.callId);
      pending.delete(message.callId);
      if (!assistant || message.name !== 'LoadTools' || message.isError ||
        !message.discoveredTools?.some(name => names.has(name) && !covered.has(name))) continue;
      const call = assistant.toolCalls!.find(call => call.id === message.callId)!;
      output.push({...assistant, text: '', toolCalls: [call]}, message);
      for (const name of message.discoveredTools) covered.add(name);
    }
  }
  return output;
}

const catalogState = z.strictObject({scope: z.literal('tool-catalog'), names: z.array(z.string()),
  fingerprint: z.string(), catalog: z.string(), baseline: z.boolean()});
export function planToolCatalog(registry: ToolRegistry, pool: readonly ResolvedTool[], protocol: ToolDiscoveryProtocol,
  history: readonly ModelMessage[]): {catalog: string; updates: readonly RuntimeContextMessage[]} {
  const catalog = registry.formatDiscoveryCatalog(pool, protocol);
  const names = pool.map(item => item.definition.name).sort();
  const fingerprint = createHash('sha256').update(JSON.stringify([protocol, pool])).digest('hex');
  const states = history.flatMap(message => {
    if (message.role !== 'context' || message.kind !== 'capability-change') return [];
    const parsed = catalogState.safeParse(message.data);
    return parsed.success ? [parsed.data] : [];
  });
  const previous = states.at(-1), baseline = states[0]?.catalog ?? catalog;
  if (previous?.fingerprint === fingerprint) return {catalog: baseline, updates: []};
  const added = names.filter(name => !previous?.names.includes(name));
  const removed = previous?.names.filter(name => !names.includes(name)) ?? [];
  const text = previous ? ['Tool capability pool updated.', ...(added.length ? ['Added: ' + added.join(', ')] : []),
    ...(removed.length ? ['Removed: ' + removed.join(', ')] : []),
    ...(!added.length && !removed.length ? ['Tool contracts or disclosure mode changed.'] : []), ...(catalog ? [catalog] : [])].join('\n') : '';
  const update = createRuntimeContextMessage('capability-change', text, {scope: 'tool-catalog', names, fingerprint, catalog, baseline: !previous});
  return {catalog: baseline, updates: [update]};
}
