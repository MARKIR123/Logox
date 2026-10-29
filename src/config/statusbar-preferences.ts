import {homedir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {immutable} from '../runtime/contracts.js';
import {StateFile} from './model-preferences.js';

export const statusbarIds = ['role', 'model', 'effort', 'permission', 'context', 'state', 'tokens', 'cost', 'session', 'project'] as const;
export type StatusbarId = typeof statusbarIds[number];
export type StatusbarStyle = 'pipes' | 'starship';
export type StatusbarColorScheme = 'theme' | 'gruvbox' | 'dracula';
export interface StatusbarAppearance {readonly style: StatusbarStyle; readonly colorScheme: StatusbarColorScheme}
export interface StatusbarModule {readonly id: StatusbarId; readonly enabled: boolean}
export const statusbarLabels: Readonly<Record<StatusbarId, string>> = {
  role: 'Role', model: 'Model', effort: 'Thinking effort', permission: 'Permission mode', context: 'Context usage', state: 'Run state',
  tokens: 'Total tokens', cost: 'Cost', session: 'Session', project: 'Project directory',
};
export const defaultStatusbar: readonly StatusbarModule[] = immutable(statusbarIds.map((id, index) => ({id, enabled: index < 6})));
const modulesSchema = z.array(z.strictObject({id: z.enum(statusbarIds), enabled: z.boolean()})).max(statusbarIds.length)
  .refine(items => new Set(items.map(item => item.id)).size === items.length, 'Statusbar modules must not repeat')
  .transform(items => [...items, ...statusbarIds.filter(id => !items.some(item => item.id === id)).map(id => ({id, enabled: false}))]);
const appearanceSchema = z.strictObject({style: z.enum(['pipes', 'starship']), colorScheme: z.enum(['theme', 'gruvbox', 'dracula'])});
const schema = z.union([
  z.strictObject({version: z.literal(1), modules: modulesSchema, motion: z.boolean().optional(),
    style: appearanceSchema.shape.style.optional(), colorScheme: appearanceSchema.shape.colorScheme.optional()}),
  z.strictObject({version: z.literal(2), modules: modulesSchema, motion: z.boolean(), ...appearanceSchema.shape}),
]);
export interface StatusbarSnapshot extends StatusbarAppearance {readonly revision: number; readonly modules: readonly StatusbarModule[]; readonly motion: boolean}

/** User layout and appearance are persisted together before becoming visible. */
export class StatusbarPreferences {
  private readonly file: StateFile<z.infer<typeof schema>>;
  private readonly fallbackFile?: StateFile<z.infer<typeof schema>>;
  private state: StatusbarSnapshot = immutable({revision: 0, modules: defaultStatusbar, motion: true, style: 'pipes', colorScheme: 'theme'});
  private listeners = new Set<() => void>();
  private pending: Promise<void> = Promise.resolve();
  constructor(path = join(homedir(), '.logox', 'statusbar.json'), fallbackPath?: string) {
    this.file = new StateFile(path, schema);
    const effectiveFallback = fallbackPath ?? (path === join(homedir(), '.logox', 'statusbar.json') ? join(homedir(), '.logox-ts', 'statusbar.json') : undefined);
    if (effectiveFallback) this.fallbackFile = new StateFile(effectiveFallback, schema);
  }
  getSnapshot = (): StatusbarSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {this.listeners.add(listener); return () => this.listeners.delete(listener);};
  load(): Promise<void> {
    return this.enqueue(async () => {
      const saved = await this.file.read() ?? await this.fallbackFile?.read();
      if (saved) this.publish(saved.modules, saved.motion ?? true, {style: saved.style ?? 'pipes', colorScheme: saved.colorScheme ?? 'theme'});
    });
  }
  async save(modules: unknown, appearance?: StatusbarAppearance): Promise<void> {
    // Parse and detach caller input now; choose inherited values inside the queue.
    const parsed = modulesSchema.parse(modules);
    const selected = appearance === undefined ? undefined : appearanceSchema.parse({style: appearance.style, colorScheme: appearance.colorScheme});
    return this.enqueue(async () => {await this.persist(parsed, this.state.motion, selected ?? this.state);});
  }
  saveMotion(motion: boolean): Promise<void> {
    return this.enqueue(async () => {await this.persist(this.state.modules, z.boolean().parse(motion), this.state);});
  }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.pending.then(operation).catch((cause: unknown) => {throw new Error('Unable to load or save statusbar preferences; the previous selection is unchanged.', {cause});});
    this.pending = result.catch(() => {});
    return result;
  }
  private async persist(modules: readonly StatusbarModule[], motion: boolean, appearance: StatusbarAppearance): Promise<void> {
    await this.file.save({version: 2, modules: [...modules], motion, style: appearance.style, colorScheme: appearance.colorScheme});
    this.publish(modules, motion, appearance);
  }
  private publish(modules: readonly StatusbarModule[], motion: boolean, appearance: StatusbarAppearance): void {
    this.state = immutable({revision: this.state.revision + 1, modules: [...modules], motion, style: appearance.style, colorScheme: appearance.colorScheme});
    for (const listener of this.listeners) listener();
  }
}
