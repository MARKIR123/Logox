import {existsSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import type {ActorDefinition} from '../actors/definitions.js';
import type {ContextPolicy} from '../config/config.js';
import {modelLabel} from '../config/model-preferences.js';
import {watermarks} from '../context/budget.js';
import type {SkillResource} from '../resources/manager.js';
import type {RuntimeSnapshot} from '../runtime/contracts.js';
import type {EnsembleActor, EnsembleData, EnsemblePrompt, EnsembleSkill, EnsembleTool, EnsembleToolParam} from '../runtime/ensemble-view.js';
import type {StageStatus} from '../runtime/stage-status.js';
import type {ToolRoles} from '../tools/metadata.js';
import type {ResolvedTool} from '../tools/catalog.js';

/** Tab order of the page: the Director first, then the companions, then any custom actors in catalog order. */
export const ensembleRoster: readonly string[] = ['logox', 'kalon', 'techne', 'aletheia'];

export interface McpFolder {readonly server: string; readonly tools: readonly {readonly name: string; readonly description: string; readonly inputSchema: Record<string, unknown>}[]; readonly listed: boolean}
export interface EnsembleSources {
  readonly actors: () => readonly ActorDefinition[];
  readonly cwd: string; readonly home: string;
  readonly status: (ownerId: string) => StageStatus;
  readonly policy: (ownerId: string) => ContextPolicy;
  /** Tools the actor actually gets (`ToolRegistry.resolveForActor`), MCP registrations included. */
  readonly tools: (ownerId: string) => readonly ResolvedTool[];
  readonly mcp?: () => readonly McpFolder[];
  readonly skills: (actor: ActorDefinition) => readonly SkillResource[];
  readonly snapshot: () => RuntimeSnapshot;
  readonly usage: (ownerId: string) => {input: number; output: number; cost?: string};
  /** Injectable for tests; defaults to `fs.existsSync`. */
  readonly exists?: (path: string) => boolean;
}

const compact = (value: number) => value < 1000 ? String(Math.round(value)) : value < 1_000_000 ? String(Math.round(value / 1000)) + 'k' : (value / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
const plural = (count: number, one: string, many: string) => count + ' ' + (count === 1 ? one : many);

/** `keeps 0 rounds and 2 tool results · compacts at 84% (168k)`, from the real window and watermark. */
export function contextSentence(policy: ContextPolicy, window: number | undefined): string {
  const keeps = 'keeps ' + plural(policy.keep_recent_rounds, 'round', 'rounds') + ' and ' + plural(policy.keep_recent_tools, 'tool result', 'tool results');
  if (!window) return keeps + ' · compacts at ' + Math.round(policy.high_watermark_ratio * 100) + '% of the model window';
  const high = watermarks({identity: 'ensemble', window}, policy).high;
  return keeps + ' · compacts at ' + Math.round(high / window * 100) + '% (' + compact(high) + ')';
}

type Json = Record<string, unknown>;
function typeText(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return 'any';
  const node = schema as Json;
  if (Array.isArray(node.enum)) return node.enum.map(String).join(' | ');
  const union = (node.anyOf ?? node.oneOf) as unknown;
  if (Array.isArray(union)) return [...new Set(union.map(typeText))].join(' | ');
  if (node.type === 'array') return typeText(node.items) + '[]';
  if (Array.isArray(node.type)) return node.type.map(String).join(' | ');
  return typeof node.type === 'string' ? node.type : node.properties ? 'object' : 'any';
}
export function toolParams(parameters: Json): readonly EnsembleToolParam[] {
  const properties = (parameters.properties ?? {}) as Record<string, unknown>;
  const required = new Set(Array.isArray(parameters.required) ? parameters.required.map(String) : []);
  return Object.entries(properties).map(([name, schema]) => ({name, type: typeText(schema), required: required.has(name),
    description: String(((schema ?? {}) as Json).description ?? '').trim()}));
}
function rolesText(roles: ToolRoles, names: ReadonlyMap<string, string>): string {
  if (roles === 'all') return 'everyone';
  if (roles === 'director') return 'Director only';
  if (roles === 'actors') return 'companions only';
  return roles.map(id => names.get(id) ?? id).join(', ') || 'nobody';
}
const firstLine = (text: string) => (text.split(/\r?\n/).find(line => line.trim()) ?? '').trim();

export function toolsFor(actor: ActorDefinition, sources: EnsembleSources, names: ReadonlyMap<string, string>): EnsembleTool[] {
  const result: EnsembleTool[] = [];
  for (const tool of sources.tools(actor.id)) {
    // Every tool the actor receives is listed, protocol tools included: hiding a tool from the timeline is not hiding it from the catalog.
    const category = tool.metadata.category;
    result.push({name: tool.definition.name, folder: category === 'core' ? [] : category.split('/'),
      summary: firstLine(tool.metadata.description ?? tool.definition.description), description: tool.definition.description.trim(),
      params: toolParams(tool.definition.parameters), loading: tool.metadata.loading, roles: rolesText(tool.metadata.roles, names),
      visibility: tool.metadata.terminalVisibility, source: 'builtin'});
  }
  for (const server of sources.mcp?.() ?? []) {
    for (const remote of server.tools) {
      result.push({name: remote.name, folder: ['mcp:' + server.server], summary: firstLine(remote.description), description: remote.description.trim(),
        params: toolParams(remote.inputSchema), loading: 'deferred', roles: 'everyone', visibility: 'card', source: 'mcp'});
    }
  }
  return result.sort((a, b) => a.folder.join('/').localeCompare(b.folder.join('/')) || a.name.localeCompare(b.name));
}

export function skillScope(path: string, cwd: string, home: string): {scope: EnsembleSkill['scope']; folder: string[]} {
  const roots: [EnsembleSkill['scope'], string][] = [['project', join(cwd, '.logox', 'skills')], ['user', join(home, '.logox', 'skills')]];
  for (const [scope, root] of roots) {
    const rel = relative(resolve(root), resolve(path)).replaceAll('\\', '/');
    if (rel && !rel.startsWith('..') && !/^[a-zA-Z]:/.test(rel)) return {scope, folder: rel.split('/').slice(0, -1)};
  }
  const parts = resolve(path).replaceAll('\\', '/').split('/'), at = parts.findIndex(part => part.toLowerCase() === 'builtin-skills');
  return {scope: 'built-in', folder: at >= 0 ? parts.slice(at + 1, -1) : []};
}
export function skillsFor(actor: ActorDefinition, sources: EnsembleSources): EnsembleSkill[] {
  return sources.skills(actor).map(skill => {
    const {scope, folder} = skillScope(skill.path, sources.cwd, sources.home);
    return {name: skill.name, description: skill.description, path: skill.path, scope, folder};
  }).sort((a, b) => a.scope.localeCompare(b.scope) || a.folder.join('/').localeCompare(b.folder.join('/')) || a.name.localeCompare(b.name));
}

const promptFiles: readonly {id: EnsemblePrompt['id']; heading: string; file: string; read: (actor: ActorDefinition) => string | undefined}[] = [
  {id: 'persona', heading: 'Persona', file: 'persona.md', read: actor => actor.prompt},
  {id: 'execution', heading: 'Execution', file: 'execution.md', read: actor => actor.execution},
  {id: 'collaboration', heading: 'Collaboration', file: 'collaboration.md', read: actor => actor.collaboration},
  {id: 'memory', heading: 'Memory priorities', file: 'compression.md', read: actor => actor.compression},
];

export function buildEnsemble(sources: EnsembleSources, initial?: string): EnsembleData {
  const exists = sources.exists ?? existsSync;
  const catalog = sources.actors();
  const names = new Map(catalog.map(actor => [actor.id, actor.name]));
  const order = [...ensembleRoster.filter(id => names.has(id)), ...catalog.map(actor => actor.id).filter(id => !ensembleRoster.includes(id))];
  const snapshot = sources.snapshot();
  const actors = order.map((id): EnsembleActor => {
    const actor = catalog.find(item => item.id === id)!;
    const status = sources.status(id), policy = sources.policy(id);
    const userPath = join(sources.home, '.logox', 'actors', id), projectDir = join(sources.cwd, '.logox', 'actors', id), projectFile = join(sources.cwd, '.logox', 'actors', id + '.md');
    const projectLayer = exists(projectDir) ? projectDir : exists(projectFile) ? projectFile : undefined;
    const prompts: EnsemblePrompt[] = [];
    for (const spec of promptFiles) {
      const text = spec.read(actor);
      if (!text) continue;
      const userFile = join(userPath, spec.file), projectLayerFile = join(projectDir, spec.file);
      const project = exists(projectLayerFile) || (spec.id === 'persona' && exists(projectFile));
      const path = exists(userFile) ? userFile : exists(projectLayerFile) ? projectLayerFile : spec.id === 'persona' && exists(projectFile) ? projectFile : undefined;
      prompts.push({id: spec.id, heading: spec.heading, file: spec.file, text, project, ...(path ? {path} : {})});
    }
    const own = snapshot.activities.filter(activity => activity.ownerId === id && activity.kind !== 'anamnesis');
    const calls = snapshot.messages.filter(message => message.ownerId === id && message.kind === 'tool' && message.step?.terminalVisibility !== 'silent' && message.step?.state !== 'queued');
    const usage = sources.usage(id);
    const model = status.model ? modelLabel(status.model.model, status.effort && !['Unsupported', 'Unavailable'].includes(status.effort) ? status.effort : undefined) : 'no model';
    return {id, name: actor.name, title: actor.title, glyph: actor.symbol, color: actor.color, description: actor.description,
      model: {text: model, source: actor.defaultModel ? 'set' : 'follows'},
      context: contextSentence(policy, status.modelInfo?.window ?? status.context?.window),
      userPath, ...(projectLayer ? {projectPath: projectLayer} : {}),
      tools: toolsFor(actor, sources, names), skills: skillsFor(actor, sources),
      stats: {completed: own.filter(activity => activity.status === 'completed').length, failed: own.filter(activity => activity.status === 'failed').length,
        toolCalls: calls.length, toolsFailed: calls.filter(message => message.step?.state === 'failed').length,
        approvals: snapshot.interactions.filter(item => item.kind === 'permission' && item.ownerId === id).length,
        tokensIn: usage.input, tokensOut: usage.output, ...(usage.cost ? {cost: usage.cost} : {})},
      prompts};
  });
  return {actors, ...(initial ? {initial} : {})};
}
