import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {ToolDefinition, ToolDiscoveryProtocol} from '../runtime/messages.js';
import {toolMetadataSchema, userToolConfigSchema, isToolAllowedForActor,
  type ToolMetadata, type ToolMetadataInput, type ToolTerminalVisibility, type ToolPromptVisibility, type UserToolConfig} from './metadata.js';
import {canonicalToolName} from './types.js';
import {builtinToolRegistrations, type ToolRegistration, type ResolvedTool} from './catalog.js';
import {readToolCategories} from './taxonomy.js';

export class ToolRegistry {
  private readonly registrations = new Map<string, ResolvedTool>();
  private readonly userOverrides = new Map<string, UserToolConfig>();
  private readonly categories: ReadonlyMap<string, string>;
  constructor(readonly projectDir = process.cwd(), readonly userHomeDir = homedir(),
    toolsDirectory = fileURLToPath(new URL('./', import.meta.url))) {
    this.categories = readToolCategories(toolsDirectory);
    for (const item of builtinToolRegistrations()) this.register(item.metadata, item.definition);
  }
  private canonical(name: string): string {
    return canonicalToolName(name) ?? [...this.registrations.keys()].find(key => key.toLowerCase() === name.toLowerCase()) ?? name;
  }
  register(meta: ToolMetadataInput, definition?: ToolDefinition): void {
    const name = this.canonical(meta.name);
    const previous = this.registrations.get(name);
    const value = definition ?? previous?.definition;
    if (!value) throw new Error('Tool registration requires a definition: ' + name);
    if (this.canonical(value.name) !== name) throw new Error('Tool metadata and definition names do not match: ' + name);
    if (previous && JSON.stringify({...value, name}) !== JSON.stringify(previous.definition)) throw new Error('Conflicting tool registration: ' + name);
    this.registrations.set(name, {metadata: toolMetadataSchema.parse({...meta, name}), definition: {...value, name}});
  }
  getMetadata(toolName: string): ToolMetadata | undefined {
    const name = this.canonical(toolName), base = this.registrations.get(name)?.metadata;
    if (!base) return undefined;
    const metadata = toolMetadataSchema.parse({...base, ...this.userOverrides.get(name)});
    // Terminal round closure is an internal protocol, never a user-disableable business capability.
    return name === '_FinishRound' ? {...metadata, roles: 'all', loading: 'eager', promptVisibility: 'explicit', terminalVisibility: 'silent'} : metadata;
  }
  getTerminalVisibility(name: string): ToolTerminalVisibility {return this.getMetadata(name)?.terminalVisibility ?? 'card';}
  getPromptVisibility(name: string): ToolPromptVisibility {return this.getMetadata(name)?.promptVisibility ?? 'always';}
  resolveForActor(actorId: string, extras: readonly ToolRegistration[] = []): readonly ResolvedTool[] {
    const entries = new Map(this.registrations);
    for (const item of extras) {
      const name = this.canonical(item.metadata.name);
      // Builtins always use their owning contract and policy, including when the caller is denied.
      if (this.registrations.has(name)) continue;
      const metadata = toolMetadataSchema.parse({...item.metadata, name, ...this.userOverrides.get(name)});
      if (this.canonical(item.definition.name) !== name) throw new Error('Tool metadata and definition names do not match: ' + name);
      const definition = {...item.definition, name};
      const previous = entries.get(name);
      if (previous && JSON.stringify(previous) !== JSON.stringify({metadata, definition})) throw new Error('Conflicting tool registration: ' + name);
      entries.set(name, {metadata, definition});
    }
    return [...entries.values()].map(item => ({...item, metadata: this.getMetadata(item.metadata.name) ?? item.metadata}))
      .filter(item => item.metadata.promptVisibility !== 'hidden' && isToolAllowedForActor(item.metadata.roles, actorId))
      .sort((a, b) => a.metadata.category.localeCompare(b.metadata.category) || a.definition.name.localeCompare(b.definition.name));
  }
  getToolsForActor(actorId: string): readonly ToolDefinition[] {return this.resolveForActor(actorId).map(item => item.definition);}
  formatDiscoveryCatalog(pool: readonly ResolvedTool[], protocol: ToolDiscoveryProtocol): string {
    if (protocol === 'none') return '';
    const categories = new Map<string, ResolvedTool[]>();
    for (const item of pool) {
      if (item.metadata.loading !== 'deferred') continue;
      const entries = categories.get(item.metadata.category) ?? [];
      entries.push(item); categories.set(item.metadata.category, entries);
    }
    const lines: string[] = [];
    for (const [category, tools] of [...categories].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  - ${category}/${this.categories.has(category) ? ': ' + this.categories.get(category) : ''}`);
      for (const item of tools.sort((a, b) => a.definition.name.localeCompare(b.definition.name))) {
        const description = (item.metadata.description ?? item.definition.description).split(/\r?\n/)[0]!.trim();
        lines.push(`    - ${item.definition.name}: ${description}`);
      }
    }
    const instruction = protocol === 'openai-responses' ? 'For the deferred tools listed below, use client tool search to load full contracts by exact name before first use.'
      : 'For the deferred tools listed below, load full contracts by exact name with LoadTools before first use.';
    return lines.length ? [instruction, ...lines].join('\n') : '';
  }
  formatTieredToolsPrompt(actorId: string): string {return this.formatDiscoveryCatalog(this.resolveForActor(actorId), 'anthropic');}
  formatExplicitPromptSection(actorId: string): string {return this.formatTieredToolsPrompt(actorId);}
  async reloadUserConfigs(): Promise<void> {
    const overrides = new Map<string, UserToolConfig>();
    const candidates = [join(this.userHomeDir, '.logox-ts', 'tools.json'), join(this.userHomeDir, '.logox', 'tools.json'), join(this.projectDir, '.logox', 'tools.json')];
    for (const file of candidates) {
      try {
        const value: unknown = JSON.parse(await readFile(file, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        for (const [key, config] of Object.entries(value)) {
          const parsed = userToolConfigSchema.safeParse(config);
          if (parsed.success) {
            const name = this.canonical(key);
            if (name === '_FinishRound' && (parsed.data.loading === 'deferred' || parsed.data.promptVisibility === 'hidden' ||
              parsed.data.roles !== undefined && parsed.data.roles !== 'all')) throw new Error('The mandatory _FinishRound tool cannot be disabled or deferred.');
            overrides.set(name, {...overrides.get(name), ...parsed.data});
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
    }
    this.userOverrides.clear();
    for (const [name, config] of overrides) this.userOverrides.set(name, config);
  }
}

/** Compatibility for stateless presentation helpers; application assembly owns its own registry. */
export const defaultToolRegistry = new ToolRegistry();
