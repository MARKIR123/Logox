import {homedir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {immutable} from '../runtime/contracts.js';
import {StateFile} from './model-preferences.js';

export const statusbarIds = ['role', 'model', 'effort', 'permission', 'context', 'state', 'tokens', 'cost', 'session', 'project'] as const;
export type StatusbarId = typeof statusbarIds[number];
export interface StatusbarModule {readonly id: StatusbarId; readonly enabled: boolean}
export const statusbarLabels: Readonly<Record<StatusbarId, string>> = {
  role: '角色', model: '模型', effort: '思考强度', permission: '权限模式', context: '上下文占用', state: '运行状态',
  tokens: '累计 Token', cost: '费用', session: '会话名', project: '项目目录',
};
export const defaultStatusbar: readonly StatusbarModule[] = immutable(statusbarIds.map((id, index) => ({id, enabled: index < 6})));
const modulesSchema = z.array(z.strictObject({id: z.enum(statusbarIds), enabled: z.boolean()})).length(statusbarIds.length)
  .refine(items => new Set(items.map(item => item.id)).size === statusbarIds.length, '状态栏模块不能重复或缺失');
const schema = z.strictObject({version: z.literal(1), modules: modulesSchema, motion: z.boolean().optional()});
export interface StatusbarSnapshot {readonly revision: number; readonly modules: readonly StatusbarModule[]; readonly motion: boolean}

/** 用户级布局；先原子保存，再发布，失败不改变正在使用的布局。 */
export class StatusbarPreferences {
  private readonly file: StateFile<z.infer<typeof schema>>;
  private readonly fallbackFile?: StateFile<z.infer<typeof schema>>;
  private state: StatusbarSnapshot = immutable({revision: 0, modules: defaultStatusbar, motion: true});
  private listeners = new Set<() => void>();
  constructor(path = join(homedir(), '.logox-ts', 'statusbar.json'), fallbackPath?: string) {
    this.file = new StateFile(path, schema);
    const effectiveFallback = fallbackPath ?? (path === join(homedir(), '.logox-ts', 'statusbar.json') ? join(homedir(), '.logox', 'statusbar.json') : undefined);
    if (effectiveFallback) this.fallbackFile = new StateFile(effectiveFallback, schema);
  }
  getSnapshot = (): StatusbarSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {this.listeners.add(listener); return () => this.listeners.delete(listener);};
  async load(): Promise<void> {
    let saved = await this.file.read();
    if (!saved && this.fallbackFile) {
      try {saved = await this.fallbackFile.read();} catch {}
    }
    if (saved) this.publish(saved.modules, saved.motion ?? true);
  }
  async save(modules: unknown): Promise<void> {
    const parsed = modulesSchema.parse(modules);
    await this.file.save({version: 1, modules: parsed, motion: this.state.motion}); this.publish(parsed, this.state.motion);
  }
  async saveMotion(motion: boolean): Promise<void> {
    await this.file.save({version: 1, modules: [...this.state.modules], motion}); this.publish(this.state.modules, motion);
  }
  private publish(modules: readonly StatusbarModule[], motion: boolean): void {
    this.state = immutable({revision: this.state.revision + 1, modules: [...modules], motion});
    for (const listener of this.listeners) listener();
  }
}
