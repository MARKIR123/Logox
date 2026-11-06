import {homedir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {immutable} from '../runtime/contracts.js';
import {StateFile} from './model-preferences.js';

export const statusbarIds = ['role', 'model', 'effort', 'permission', 'context', 'cache', 'state', 'tokens', 'cost', 'session', 'project', 'git'] as const;
export type StatusbarId = typeof statusbarIds[number];
export type StatusbarStyle = 'pipes' | 'starship';
export type StatusbarColorScheme = 'theme' | 'gruvbox' | 'dracula';
export const gaugeCellChoices = [8, 12, 16, 20, 24] as const;
export const defaultGaugeCells = 16;
/** `gaugeCells` is the context gauge width in cells (default 16); the planner may still shrink it to 8 on a narrow bar. */
export interface StatusbarAppearance {readonly style: StatusbarStyle; readonly colorScheme: StatusbarColorScheme; readonly gaugeCells?: number}
export interface StatusbarModule {readonly id: StatusbarId; readonly enabled: boolean}
export const statusbarLabels: Readonly<Record<StatusbarId, string>> = {
  role: 'Role', model: 'Model', effort: 'Thinking effort', permission: 'Permission mode', context: 'Context gauge', cache: 'Cache hit rate', state: 'Run state',
  tokens: 'Session tokens', cost: 'Session cost', session: 'Session', project: 'Project directory', git: 'Git branch',
};
export const defaultStatusbar: readonly StatusbarModule[] = immutable(statusbarIds.map((id, index) => ({id, enabled: index < 6})));
const modulesSchema = z.array(z.strictObject({id: z.enum(statusbarIds), enabled: z.boolean()})).max(statusbarIds.length)
  .refine(items => new Set(items.map(item => item.id)).size === items.length, 'Statusbar modules must not repeat')
  .transform(items => [...items, ...statusbarIds.filter(id => !items.some(item => item.id === id)).map(id => ({id, enabled: false}))]);
const gaugeSchema = z.number().int().min(4).max(40);
const appearanceSchema = z.strictObject({style: z.enum(['pipes', 'starship']), colorScheme: z.enum(['theme', 'gruvbox', 'dracula']), gaugeCells: gaugeSchema.optional()});
const schema = z.union([
  z.strictObject({version: z.literal(1), modules: modulesSchema, motion: z.boolean().optional(),
    style: appearanceSchema.shape.style.optional(), colorScheme: appearanceSchema.shape.colorScheme.optional(), gaugeCells: gaugeSchema.optional()}),
  z.strictObject({version: z.literal(2), modules: modulesSchema, motion: z.boolean(), ...appearanceSchema.shape}),
]);
export interface StatusbarSnapshot extends StatusbarAppearance {readonly gaugeCells: number; readonly revision: number; readonly modules: readonly StatusbarModule[]; readonly motion: boolean}

/** User layout and appearance are persisted together before becoming visible. */
export class StatusbarPreferences {
  private readonly file: StateFile<z.infer<typeof schema>>;
  private state: StatusbarSnapshot = immutable({revision: 0, modules: defaultStatusbar, motion: true, style: 'pipes', colorScheme: 'theme', gaugeCells: defaultGaugeCells});
  private listeners = new Set<() => void>();
  private pending: Promise<void> = Promise.resolve();
  constructor(path = join(homedir(), '.logox', 'statusbar.json')) {
    this.file = new StateFile(path, schema);
  }
  getSnapshot = (): StatusbarSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {this.listeners.add(listener); return () => this.listeners.delete(listener);};
  load(): Promise<void> {
    return this.enqueue(async () => {
      const saved = await this.file.read();
      if (saved) this.publish(saved.modules, saved.motion ?? true, {style: saved.style ?? 'pipes', colorScheme: saved.colorScheme ?? 'theme', gaugeCells: saved.gaugeCells ?? defaultGaugeCells});
    });
  }
  async save(modules: unknown, appearance?: StatusbarAppearance): Promise<void> {
    // Parse and detach caller input now; choose inherited values inside the queue.
    const parsed = modulesSchema.parse(modules);
    const selected = appearance === undefined ? undefined : appearanceSchema.parse({style: appearance.style, colorScheme: appearance.colorScheme, ...(appearance.gaugeCells !== undefined ? {gaugeCells: appearance.gaugeCells} : {})});
    return this.enqueue(async () => {await this.persist(parsed, this.state.motion, selected ? {style: selected.style, colorScheme: selected.colorScheme, gaugeCells: selected.gaugeCells ?? this.state.gaugeCells} : this.state);});
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
    await this.file.save({version: 2, modules: [...modules], motion, style: appearance.style, colorScheme: appearance.colorScheme, gaugeCells: appearance.gaugeCells ?? defaultGaugeCells});
    this.publish(modules, motion, appearance);
  }
  private publish(modules: readonly StatusbarModule[], motion: boolean, appearance: StatusbarAppearance): void {
    this.state = immutable({revision: this.state.revision + 1, modules: [...modules], motion, style: appearance.style, colorScheme: appearance.colorScheme, gaugeCells: appearance.gaugeCells ?? defaultGaugeCells});
    for (const listener of this.listeners) listener();
  }
}
