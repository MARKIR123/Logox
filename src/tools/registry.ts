import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import type {ToolDefinition} from '../runtime/messages.js';
import {
  type ToolMetadata,
  type ToolTerminalVisibility,
  type ToolPromptVisibility,
  type UserToolConfig,
  userToolConfigSchema,
  isToolAllowedForActor,
} from './metadata.js';
import {schemas, descriptions, canonicalToolName} from './index.js';
import {sendMessageSchema, sendMessageTool} from './coordination/SendMessageTool/SendMessageTool.js';

const defaultMetadataList: readonly ToolMetadata[] = [
  // Core: First-class citizens, always present in top-level prompt
  {name: 'Read', category: 'core', roles: 'all', promptVisibility: 'always', terminalVisibility: 'card', description: 'Read local file contents and inspect visual images'},
  {name: 'Write', category: 'core', roles: 'all', promptVisibility: 'always', terminalVisibility: 'card', description: 'Write or overwrite file contents completely'},
  {name: 'Edit', category: 'core', roles: 'all', promptVisibility: 'always', terminalVisibility: 'card', description: 'Perform exact string replacement in a file'},
  {name: 'Glob', category: 'core', roles: 'all', promptVisibility: 'always', terminalVisibility: 'card', description: 'Fast pattern matching of file paths'},
  {name: 'Grep', category: 'core', roles: 'all', promptVisibility: 'always', terminalVisibility: 'card', description: 'Regex search in file contents via built-in ripgrep'},
  {name: 'Shell', category: 'core', roles: 'all', promptVisibility: 'always', terminalVisibility: 'card', description: 'Execute shell commands with timeout and permission controls'},
  {name: 'AskUserQuestion', category: 'core', roles: 'all', promptVisibility: 'always', terminalVisibility: 'card', description: 'Present structured clarification questions to user'},
  {name: 'WebFetch', category: 'core', roles: 'all', promptVisibility: 'always', terminalVisibility: 'card', description: 'Fetch URL contents and convert to clean markdown'},

  // Protocol: Lifecycle & environment state inspection
  {name: '_FinishRound', category: 'protocol', roles: 'all', promptVisibility: 'explicit', terminalVisibility: 'silent', description: 'Record internal round memory and deliver turn'},
  {name: '_GitStatus', category: 'protocol', roles: 'all', promptVisibility: 'explicit', terminalVisibility: 'silent', description: 'Fetch current Git branch, tracking status, and clean/dirty working tree state on demand'},

  // Coordination: Team collaboration & communication
  {name: 'SendMessage', category: 'coordination', roles: 'actors', promptVisibility: 'explicit', terminalVisibility: 'notice', description: 'Deliver message to director or peer actor'},
  {name: 'ListActors', category: 'coordination', roles: 'all', promptVisibility: 'explicit', terminalVisibility: 'card', description: 'List available actors in the active ensemble'},
  {name: 'BorrowSkill', category: 'coordination', roles: 'actors', promptVisibility: 'explicit', terminalVisibility: 'card', description: 'Borrow a specialized skill on demand'},

  // Orchestration: Director dispatch & task control
  {name: 'Actor', category: 'orchestration', roles: 'director', promptVisibility: 'explicit', terminalVisibility: 'card', description: 'Dispatch tasks to ensemble actors'},
  {name: 'CraftActor', category: 'orchestration', roles: 'director', promptVisibility: 'explicit', terminalVisibility: 'card', description: 'Create and register a new persistent actor persona'},
  {name: 'ReadActor', category: 'orchestration', roles: 'director', promptVisibility: 'explicit', terminalVisibility: 'card', description: 'Inspect persona details of a specific actor'},
  {name: 'CancelActor', category: 'orchestration', roles: 'director', promptVisibility: 'explicit', terminalVisibility: 'card', description: 'Cancel an active actor task'},
  {name: 'UpdateTaskProgress', category: 'orchestration', roles: 'director', promptVisibility: 'explicit', terminalVisibility: 'card', description: 'Update current high-level task progress'},
  {name: 'Automa', category: 'orchestration', roles: 'director', promptVisibility: 'explicit', terminalVisibility: 'card', description: 'Dispatch a stateless mechanical subtask to Automa'},
];

export class ToolRegistry {
  private readonly metadata = new Map<string, ToolMetadata>();
  private readonly definitions = new Map<string, ToolDefinition>();
  private readonly userOverrides = new Map<string, UserToolConfig>();
  readonly projectDir: string;
  readonly userHomeDir: string;

  constructor(
    projectDir: string = process.cwd(),
    userHomeDir: string = homedir()
  ) {
    this.projectDir = projectDir;
    this.userHomeDir = userHomeDir;
    this.initializeDefaults();
  }

  private initializeDefaults(): void {
    for (const meta of defaultMetadataList) {
      this.metadata.set(meta.name, meta);

      // Create ToolDefinition from schemas/descriptions if available
      if (meta.name === 'SendMessage') {
        this.definitions.set(meta.name, sendMessageTool);
      } else if (Object.hasOwn(schemas, meta.name)) {
        const schema = schemas[meta.name as keyof typeof schemas];
        const desc = descriptions[meta.name as keyof typeof descriptions] || meta.description || '';
        this.definitions.set(meta.name, {
          name: meta.name,
          description: desc,
          parameters: z.toJSONSchema(schema),
        });
      }
    }
  }

  register(meta: ToolMetadata, definition?: ToolDefinition): void {
    this.metadata.set(meta.name, meta);
    if (definition) {
      this.definitions.set(meta.name, definition);
    }
  }

  getMetadata(toolName: string): ToolMetadata | undefined {
    const canonical = canonicalToolName(toolName) ?? toolName;
    const base = this.metadata.get(canonical);
    if (!base) return undefined;

    const override = this.userOverrides.get(canonical);
    if (!override) return base;

    return {
      ...base,
      ...(override.roles !== undefined ? {roles: override.roles} : {}),
      ...(override.promptVisibility !== undefined ? {promptVisibility: override.promptVisibility} : {}),
      ...(override.terminalVisibility !== undefined ? {terminalVisibility: override.terminalVisibility} : {}),
    };
  }

  getTerminalVisibility(toolName: string): ToolTerminalVisibility {
    return this.getMetadata(toolName)?.terminalVisibility ?? 'card';
  }

  getPromptVisibility(toolName: string): ToolPromptVisibility {
    return this.getMetadata(toolName)?.promptVisibility ?? 'always';
  }

  getToolsForActor(actorId: string): readonly ToolDefinition[] {
    const result: ToolDefinition[] = [];
    for (const [name, def] of this.definitions) {
      const meta = this.getMetadata(name);
      if (!meta) continue;
      if (meta.promptVisibility === 'hidden') continue;
      if (isToolAllowedForActor(meta.roles, actorId)) {
        result.push(def);
      }
    }
    return result;
  }

  formatTieredToolsPrompt(actorId: string): string {
    const lines: string[] = ['tools:'];

    // 1. First-class Core tools (at root)
    for (const [name] of this.metadata) {
      const effective = this.getMetadata(name)!;
      if (effective.category !== 'core') continue;
      if (effective.promptVisibility === 'hidden') continue;
      if (!isToolAllowedForActor(effective.roles, actorId)) continue;

      const desc = effective.description || descriptions[effective.name as keyof typeof descriptions] || '';
      lines.push(`  ${effective.name}: ${desc.split('\n')[0]}`);
    }

    // 2. Second-class Subdirectory tools
    const categoryLabels: Record<string, string> = {
      protocol: '流程规范工具 (Protocol): 轮次规范与环境状态检查',
      coordination: '团队协作工具 (Coordination): 跨角色即时通信与协作',
      orchestration: '调度编排工具 (Orchestration): Director 派工与任务控制',
      extension: '扩展工具 (Extensions)',
    };

    const categorized: Record<string, {name: string; description: string}[]> = {};

    for (const [name] of this.metadata) {
      const effective = this.getMetadata(name)!;
      if (effective.category === 'core') continue;
      if (effective.promptVisibility !== 'explicit') continue;
      if (!isToolAllowedForActor(effective.roles, actorId)) continue;

      const catKey = effective.category;
      categorized[catKey] = categorized[catKey] || [];
      categorized[catKey].push({
        name: effective.name,
        description: effective.description || descriptions[effective.name as keyof typeof descriptions] || '',
      });
    }

    for (const [catKey, tools] of Object.entries(categorized)) {
      if (tools.length === 0) continue;
      const label = categoryLabels[catKey] || (catKey.charAt(0).toUpperCase() + catKey.slice(1));
      lines.push(`  - ${label}:`);
      for (const t of tools) {
        lines.push(`    - ${t.name}: ${t.description.split('\n')[0]}`);
      }
    }

    return lines.join('\n');
  }

  formatExplicitPromptSection(actorId: string): string {
    return this.formatTieredToolsPrompt(actorId);
  }

  async reloadUserConfigs(): Promise<void> {
    this.userOverrides.clear();

    const candidates = [
      join(this.userHomeDir, '.logox', 'tools.json'),
      join(this.userHomeDir, '.logox-ts', 'tools.json'),
      join(this.projectDir, '.logox', 'tools.json'),
    ];

    for (const file of candidates) {
      try {
        const raw = await readFile(file, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          for (const [toolName, config] of Object.entries(parsed)) {
            const validated = userToolConfigSchema.safeParse(config);
            if (validated.success) {
              const canonical = canonicalToolName(toolName) ?? toolName;
              this.userOverrides.set(canonical, {
                ...this.userOverrides.get(canonical),
                ...validated.data,
              });
            }
          }
        }
      } catch {}
    }
  }
}

export const defaultToolRegistry = new ToolRegistry();
