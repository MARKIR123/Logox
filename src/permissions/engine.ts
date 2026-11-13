import {randomUUID} from 'node:crypto';
import {readFile, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {isAbsolute, join, relative, sep} from 'node:path';
import {z} from 'zod';
import {withFileLock} from '../store/file-lock.js';
import {StateFile} from '../config/model-preferences.js';

import {shellWords, shellImpact, shellCommands, routineShell} from './shell.js';
import {RUNTIME_WRITE_DANGER, riskyPath} from './paths.js';
import {isScratchpadPath} from '../kernel/scratchpad.js';
export {shellWords} from './shell.js';
export const permissionModeSchema = z.enum(['default', 'auto', 'creative']);
/** Mode used when neither the config nor the project file names one. */
export const DEFAULT_PERMISSION_MODE: z.infer<typeof permissionModeSchema> = 'auto';
export const permissionScopeSchema = z.enum(['session', 'project', 'user']);
export const permissionDecisionSchema = z.enum(['allow', 'ask', 'deny']);
export const permissionRuleSchema = z.strictObject({
  id: z.string().min(1), scope: permissionScopeSchema, decision: permissionDecisionSchema,
  tool: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]*$/), pattern: z.string().min(1).max(2000),
  /** Evaluation statistics: how often this rule decided a call, and when last. Persisted for project and user rules. */
  hits: z.number().int().min(0).optional(), lastHit: z.number().int().min(0).optional(),
});
export type PermissionRule = z.infer<typeof permissionRuleSchema>;
export type PermissionScope = z.infer<typeof permissionScopeSchema>;
export type PermissionDecision = z.infer<typeof permissionDecisionSchema>;
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export type NewPermissionRule = Omit<PermissionRule, 'id' | 'hits' | 'lastHit'>;
const modeFileSchema = z.strictObject({version: z.literal(1), mode: permissionModeSchema});
const userFileSchema = z.strictObject({version: z.literal(1), rules: z.array(permissionRuleSchema)});
export interface PermissionTarget {tool: string; paths: readonly string[]; risky: boolean; command?: string; effect?: 'read' | 'write' | 'unknown'; danger?: string}
function globMatch(pattern: string, value: string): boolean {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*' && pattern[i + 1] === '*') {source += '.*'; i++;}
    else if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + source + '$', process.platform === 'win32' ? 'i' : '').test(value.replaceAll('\\', '/'));
}
/** Rule order for attribution only (decisions never depend on scope): the narrowest scope is credited first. */
const SCOPE_ORDER: readonly PermissionScope[] = ['session', 'project', 'user'];
const STATS_FLUSH_MS = 1500;
export class PermissionEngine {
  private rules: PermissionRule[] = [];
  private scratchpadDir?: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly pendingHits = new Map<string, {hits: number; lastHit: number}>();
  private statsTimer: NodeJS.Timeout | undefined;
  private readonly userStore?: StateFile<z.infer<typeof userFileSchema>>;
  private readonly modeStore?: StateFile<z.infer<typeof modeFileSchema>>;
  subscribe(listener: () => void): () => void {this.listeners.add(listener); return () => {this.listeners.delete(listener);};}
  private changed(): void {for (const listener of this.listeners) listener();}
  setScratchpadDir(dir: string): void {this.scratchpadDir = dir;}
  /**
   * `userFile` is the user-global rule file (`~/.logox/user-permissions.json`); without it the user scope is unavailable, so tests never touch the real home.
   * `modeFile` (`~/.logox/permission-mode.json`) remembers the mode the user chose, shared by every project; without it a chosen mode lasts for this engine only.
   * `mode` is the configured mode, used when nothing was remembered.
   */
  constructor(readonly root: string, public mode: PermissionMode = DEFAULT_PERMISSION_MODE, private readonly file = join(root, '.logox', 'permissions.json'), userFile?: string, modeFile?: string) {
    if (userFile) this.userStore = new StateFile(userFile, userFileSchema);
    if (modeFile) this.modeStore = new StateFile(modeFile, modeFileSchema);
  }
  get userScopeAvailable(): boolean {return this.userStore !== undefined;}
  private async readProject() {
    let raw: string;
    try {raw = await readFile(this.file, 'utf8');} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;}
    const saved = z.strictObject({root: z.string(), mode: permissionModeSchema.optional(), rules: z.array(permissionRuleSchema)}).parse(JSON.parse(raw));
    const currentRoot = await realpath(this.root);
    const samePath = process.platform === 'win32'
      ? saved.root.toLowerCase() === currentRoot.toLowerCase()
      : saved.root === currentRoot;
    if (!samePath || saved.rules.some(rule => rule.scope !== 'project')) throw new Error('Permission file project identity mismatch');
    if (new Set(saved.rules.map(rule => rule.id)).size !== saved.rules.length) throw new Error('Duplicate permission rule ID; original file preserved');
    return saved;
  }
  private async readUser(): Promise<PermissionRule[]> {
    const saved = await this.userStore?.read();
    if (!saved) return [];
    if (saved.rules.some(rule => rule.scope !== 'user')) throw new Error('User permission file scope mismatch; original file preserved');
    if (new Set(saved.rules.map(rule => rule.id)).size !== saved.rules.length) throw new Error('Duplicate permission rule ID; original file preserved');
    return saved.rules;
  }
  private of(scope: PermissionScope): PermissionRule[] {return this.rules.filter(rule => rule.scope === scope);}
  private put(scope: PermissionScope, next: PermissionRule[]): void {
    const merged = [...this.rules.filter(rule => rule.scope !== scope), ...next];
    this.rules = SCOPE_ORDER.flatMap(item => merged.filter(rule => rule.scope === item));
  }
  async load(): Promise<void> {
    const saved = await this.readProject(), user = await this.readUser();
    this.rules = [...this.of('session'), ...saved?.rules ?? [], ...user];
    // Remembered mode, highest first: the user-level file, then a mode an older version saved in this project's rule file (read only; never written again), then the configured mode.
    const remembered = await this.modeStore?.read().catch(() => undefined);
    if (remembered) this.mode = remembered.mode;
    else if (saved?.mode) this.mode = saved.mode;
  }
  snapshot(): readonly PermissionRule[] {return this.rules.map(rule => ({...rule}));}
  /** Identity of the authorization state; hit statistics are deliberately excluded so counting never invalidates a pending approval. */
  policyKey(): string {return JSON.stringify([this.mode, this.rules.map(({id, scope, decision, tool, pattern}) => [id, scope, decision, tool, pattern])]);}
  /** Adds un-persisted hits to a copy of the stored rules; `applied` records how many were taken so concurrent hits are never lost. */
  private drain(stored: readonly PermissionRule[], applied: Map<string, number>): PermissionRule[] {
    return stored.map(rule => {
      const pending = this.pendingHits.get(rule.id);
      if (!pending) return rule;
      applied.set(rule.id, pending.hits);
      return {...rule, hits: (rule.hits ?? 0) + pending.hits, lastHit: Math.max(rule.lastHit ?? 0, pending.lastHit)};
    });
  }
  private settle(applied: ReadonlyMap<string, number>, rules: PermissionRule[]): PermissionRule[] {
    for (const [id, count] of applied) {
      const pending = this.pendingHits.get(id);
      if (!pending) continue;
      pending.hits -= count;
      if (pending.hits <= 0) this.pendingHits.delete(id);
    }
    // Hits that arrived while the write was in flight stay visible until the next flush.
    return rules.map(rule => {
      const rest = this.pendingHits.get(rule.id);
      return rest ? {...rule, hits: (rule.hits ?? 0) + rest.hits, lastHit: Math.max(rule.lastHit ?? 0, rest.lastHit)} : rule;
    });
  }
  /** Changes the rules of one scope. Persistent scopes re-read their file under its lock; `quiet` skips listeners (statistics are not an authorization change). */
  private mutate(scope: PermissionScope, change: (rules: PermissionRule[]) => PermissionRule[], options: {quiet?: boolean} = {}): Promise<void> {
    const operation = this.queue.then(async () => {
      if (scope === 'session') {this.put('session', change(this.of('session')));}
      else if (scope === 'user') {
        const store = this.userStore;
        if (!store) throw new Error('The user rule scope is not available');
        const applied = new Map<string, number>();
        let result: PermissionRule[] = [];
        await store.update(current => {
          applied.clear();
          if (current?.rules.some(rule => rule.scope !== 'user')) throw new Error('User permission file scope mismatch; original file preserved');
          result = change(this.drain(current?.rules ?? [], applied));
          return {version: 1 as const, rules: result};
        });
        this.put('user', this.settle(applied, result));
      } else {
        await withFileLock(this.file, async () => {
          const saved = await this.readProject();
          const applied = new Map<string, number>();
          const next = change(this.drain(saved?.rules ?? [], applied));
          // A mode an older version saved here is carried along untouched; this file never receives a new one.
          const nextMode = saved?.mode;
          if (JSON.stringify(next) !== JSON.stringify(saved?.rules ?? [])) {
            const temporary = this.file + '.' + randomUUID() + '.tmp';
            try {
              await writeFile(temporary, JSON.stringify({root: await realpath(this.root), ...nextMode ? {mode: nextMode} : {}, rules: next}, null, 2) + '\n', {flag: 'wx', mode: 0o600});
              await rename(temporary, this.file);
            } finally {await rm(temporary, {force: true});}
          }
          this.put('project', this.settle(applied, next));
        });
      }
      if (!options.quiet) this.changed();
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async add(input: NewPermissionRule): Promise<PermissionRule> {
    const rule = permissionRuleSchema.parse({id: randomUUID(), scope: input.scope, decision: input.decision, tool: input.tool, pattern: input.pattern});
    if (rule.tool.toLowerCase() === 'shell' && rule.pattern !== '*') {
      const parsed = shellWords(rule.pattern);
      if (parsed.compound || parsed.dynamic) throw new Error('Shell rules must be static token prefixes');
    }
    let result = rule;
    await this.mutate(rule.scope, rules => {
      const same = rules.find(item => item.decision === rule.decision && item.tool.toLowerCase() === rule.tool.toLowerCase() && item.pattern === rule.pattern);
      if (same) {result = same; return rules;}
      return [...rules, rule];
    });
    return result;
  }
  /** Switches the mode and remembers it in the user-level mode file, so every project starts with it from now on. */
  async setMode(mode: PermissionMode): Promise<void> {
    const next = permissionModeSchema.parse(mode);
    const operation = this.queue.then(async () => {
      await this.modeStore?.save({version: 1, mode: next});
      this.mode = next;
      this.changed();
    });
    this.queue = operation.catch(() => {});
    await operation;
  }
  clearSession(): void {this.put('session', []);}
  async revoke(id: string): Promise<void> {
    const rule = this.rules.find(item => item.id === id);
    if (!rule) throw new Error('Permission rule not found');
    await this.mutate(rule.scope, rules => {
      if (!rules.some(item => item.id === id)) throw new Error('Permission rule not found');
      return rules.filter(item => item.id !== id);
    });
  }
  /** Records that a rule decided a call; project and user statistics are written lazily (and by `flushStats()`). */
  private hit(rule: PermissionRule): void {
    const now = Date.now();
    rule.hits = (rule.hits ?? 0) + 1; rule.lastHit = now;
    if (rule.scope === 'session') return;
    const pending = this.pendingHits.get(rule.id) ?? {hits: 0, lastHit: 0};
    pending.hits++; pending.lastHit = now; this.pendingHits.set(rule.id, pending);
    this.statsTimer ??= setTimeout(() => {this.statsTimer = undefined; void this.flushStats();}, STATS_FLUSH_MS).unref();
  }
  /** Persists pending hit statistics now; failures are ignored because statistics are advisory. */
  async flushStats(): Promise<void> {
    if (this.statsTimer) {clearTimeout(this.statsTimer); this.statsTimer = undefined;}
    for (const scope of ['project', 'user'] as const) {
      if (!this.rules.some(rule => rule.scope === scope && this.pendingHits.has(rule.id))) continue;
      if (scope === 'user' && !this.userStore) continue;
      await this.mutate(scope, rules => rules, {quiet: true}).catch(() => {});
    }
  }
  /** The danger class of a target (credentials, repositories, runtime tree, destructive shell), independent of the mode. */
  dangerOf(target: PermissionTarget): string | undefined {
    if (target.danger) return target.danger;
    const impact = target.command === undefined ? undefined : shellImpact(target.command, 0, this.root);
    return impact?.kind === 'danger' ? impact.reason : undefined;
  }
  /** A target is risky when it leaves the workspace; reaching only into the scratchpad (a script run from it, say) does not count. */
  private risky(target: PermissionTarget): boolean {
    if (!target.risky) return false;
    if (!this.scratchpadDir) return true;
    const outsideRoot = (path: string) => {const rest = relative(this.root, path); return rest === '..' || rest.startsWith('..' + sep) || isAbsolute(rest);};
    const outside = target.paths.filter(path => isAbsolute(path) && outsideRoot(path));
    if (!outside.length || !outside.every(path => isScratchpadPath(path, this.scratchpadDir!))) return true;
    return target.paths.some(path => riskyPath(path, target.effect));
  }
  evaluate(target: PermissionTarget): {decision: 'allow' | 'deny' | 'ask' | 'review'; reason: string} {
    const shell = target.command === undefined ? undefined : shellWords(target.command);
    const impact = target.command === undefined ? undefined : shellImpact(target.command, 0, this.root);
    if (impact?.kind === 'forbidden') return {decision: 'deny', reason: impact.reason};
    const toolLower = target.tool.toLowerCase();
    const matches = (rule: PermissionRule) => (rule.tool.toLowerCase() === toolLower || toolLower.startsWith(rule.tool.toLowerCase() + ':')) && (rule.pattern === '*' || (shell
      ? (() => {
        if (rule.decision === 'allow' && (shell.compound || shell.dynamic)) return false;
        const prefix = shellWords(rule.pattern).words;
        return shellCommands(target.command!).some(command => {const words = shellWords(command).words;
          return prefix.every((word, i) => word.toLowerCase() === words[i]?.toLowerCase());});
      })()
      : target.paths.some(path => globMatch(rule.pattern, path))));
    // Precedence is by decision, never by scope: deny, then ask, then allow. Credit goes to the narrowest scope that matches.
    const decided = (decision: PermissionDecision) => {
      const rule = SCOPE_ORDER.flatMap(scope => this.rules.filter(item => item.scope === scope)).find(item => item.decision === decision && matches(item));
      if (rule) this.hit(rule);
      return rule;
    };
    if (decided('deny')) return {decision: 'deny', reason: 'Matched an explicit deny rule'};
    // Paths are listed both absolute and workspace-relative; a `../` form of an outside path is only the twin of an absolute entry that is checked too.
    const scratchPaths = target.paths.filter(p => !/^\.\.(?:[\/]|$)/.test(p));
    const inScratchpad = Boolean(this.scratchpadDir) && scratchPaths.length > 0 && scratchPaths.every(p => isScratchpadPath(p, this.scratchpadDir!));
    const danger = target.danger ?? (impact?.kind === 'danger' ? impact.reason : undefined);
    // Creative mode refuses credential and repository dangers outright; an ask rule must not turn that refusal into a prompt.
    const refused = this.mode === 'creative' && danger !== undefined && danger !== RUNTIME_WRITE_DANGER && !inScratchpad;
    if (!refused && decided('ask')) return {decision: 'ask', reason: 'Matched an ask rule'};
    if (inScratchpad) return {decision: 'allow', reason: 'Scratchpad directory is allowed for temporary operations'};
    // Development mode (creative) may write its own runtime tree — skills, prompts,
    // journals. Credential and VCS-internal protection are separate dangers and stay.
    if (danger === RUNTIME_WRITE_DANGER && this.mode === 'creative') {
      return {decision: 'allow', reason: 'creative: development mode allows writes to the runtime directory (credentials and repositories remain protected)'};
    }
    if (danger) return {decision: this.mode === 'creative' ? 'deny' : 'ask', reason: danger};
    if (decided('allow')) return {decision: 'allow', reason: 'Matched an allow rule'};
    if (this.mode === 'creative') return {decision: 'allow', reason: 'creative: allowed by default after danger filtering'};
    const read = target.effect === 'read' || ['read', 'glob', 'grep', 'ask_user', 'askuserquestion', 'webfetch', 'web_fetch'].includes(toolLower) || impact?.kind === 'safe';
    if (!target.risky && read) return {decision: 'allow', reason: 'Ordinary read-only operation'};
    if (this.mode === 'auto') {
      // Only genuinely risky work reaches the review model; ordinary development proceeds.
      if (read) return {decision: 'allow', reason: 'auto: read-only access (credentials and repositories are protected separately)'};
      if (this.risky(target)) return {decision: 'review', reason: 'auto: the target is outside the workspace or sensitive; an independent model must assess the actual impact'};
      if (target.effect === 'write') return {decision: 'allow', reason: 'auto: routine file edit inside the project'};
      if (target.command !== undefined && routineShell(target.command)) return {decision: 'allow', reason: 'auto: routine development command inside the project'};
      if (toolLower.startsWith('mcp:playwright:')) return {decision: 'allow', reason: 'auto: local browser automation'};
      return {decision: 'review', reason: 'auto: an independent model must assess the actual impact'};
    }
    return {decision: 'ask', reason: target.risky ? 'Sensitive or out-of-scope target requires authorization' : 'default: operation not yet authorized'};
  }
}
