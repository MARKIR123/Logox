import {randomUUID} from 'node:crypto';
import {immutable} from '../runtime/contracts.js';
import type {CommandSurface, CommandTab, CommandResult, PickerItem} from '../runtime/command-surface.js';
export type PickerSpec = Pick<Extract<CommandSurface, {kind: 'picker'}>, 'title' | 'description' | 'current'>;
/** 拥有命令界面生命周期；回调与查询取消信号留在业务层。 */
export class CommandSurfaces {
  private state: CommandSurface | null = null;
  private listeners = new Set<() => void>();
  private controller: AbortController | undefined;
  private select: ((id: string) => CommandResult | Promise<CommandResult>) | undefined;
  getSnapshot = (): CommandSurface | null => this.state;
  subscribe = (listener: () => void): (() => void) => {this.listeners.add(listener); return () => this.listeners.delete(listener);};
  constructor(private readonly onDone: (result: CommandResult) => void) {}
  private publish(state: CommandSurface | null): void {this.state = immutable(state); for (const listener of this.listeners) listener();}
  private assertIdle(): void {if (this.state) throw new Error('请先关闭当前命令界面');}
  openPage(title: string, tabs: readonly CommandTab[], initialTab: string): void {
    this.assertIdle();
    if (!tabs.length || !tabs.some(tab => tab.id === initialTab)) throw new Error('页面缺少有效页签');
    this.publish({id: randomUUID(), kind: 'page', title, tabs, initialTab});
  }
  updatePage(tabs: readonly CommandTab[]): void {if (this.state?.kind === 'page') this.publish({...this.state, tabs});}
  async openPicker(spec: PickerSpec, load: (signal: AbortSignal) => Promise<{items: readonly PickerItem[]; warning?: string}>,
    select: (id: string) => CommandResult | Promise<CommandResult>): Promise<void> {
    this.assertIdle();
    const id = randomUUID(), controller = new AbortController();
    this.controller = controller; this.select = select;
    this.publish({id, kind: 'picker', ...spec, items: [], status: 'loading', error: ''});
    try {
      const result = await load(controller.signal);
      if (this.state?.id === id && this.state.kind === 'picker' && !controller.signal.aborted)
        this.publish({...this.state, items: result.items, status: 'ready', error: result.warning ?? ''});
    } catch (error) {
      if (this.state?.id === id && this.state.kind === 'picker' && !controller.signal.aborted)
        this.publish({...this.state, status: 'ready', error: error instanceof Error ? error.message : '查询失败'});
    }
  }
  async choose(surfaceId: string, itemId: string): Promise<void> {
    const state = this.state;
    if (!state || state.kind !== 'picker' || state.id !== surfaceId || state.status !== 'ready' || !this.select) return;
    const item = state.items.find(item => item.id === itemId);
    if (!item || item.disabled) return;
    const select = this.select;
    this.publish({...state, status: 'saving', error: ''});
    try {
      const result = await select(itemId);
      if (this.state?.id === surfaceId) {this.dismiss(); this.onDone(result);}
    } catch (error) {
      if (this.state?.id === surfaceId) this.publish({...state, error: error instanceof Error ? error.message : '操作失败'});
    }
  }
  cancel(): void {if (this.state?.kind !== 'picker' || this.state.status !== 'saving') this.dismiss();}
  private dismiss(): void {this.controller?.abort(); this.controller = undefined; this.select = undefined; this.publish(null);}
  close(): void {this.dismiss();}
}
