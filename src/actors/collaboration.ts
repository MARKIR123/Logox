import {randomUUID} from 'node:crypto';
import {sendMessageSchema, sendMessageTool} from '../tools/SendMessageTool/SendMessageTool.js';
import type {ActorContext, TaskHandle, TaskOrigin} from './ensemble.js';
import type {ToolCall, ToolDefinition, ModelMessage} from '../runtime/messages.js';
import type {CollaborationRecord, Journal} from '../store/journal.js';
import {appendProjectBulletin} from './bulletin.js';

export interface CollaborationOptions {
  sessionId: string;
  journal: Journal;
  member(ownerId: string): boolean;
  /** 仅登记到 Ensemble；禁止等待返回句柄的 done。 */
  enqueue(ownerId: string, prompt: string, source: string, origin?: TaskOrigin): TaskHandle;
  getActiveTask?: ((ownerId: string) => { activityId: string } | undefined) | undefined;
  injectMessage?: ((targetOwnerId: string, message: string, source: string, summary?: string, mode?: 'interrupt' | 'queue') => Promise<boolean> | boolean) | undefined;
  interrupt?: ((targetOwnerId: string, message: string, source: string, summary?: string) => boolean) | undefined;
  projectDir?: string | undefined;
  members?: (() => string[]) | undefined;
  coordinate?(callId: string, message: string, summary: string | undefined, context: ActorContext): Promise<void>;
}
/** Direct inter-actor messaging; messages are data, never authority over the user or Director. */
export class Collaboration {
  private readonly deliveries = new Map<string, TaskHandle[]>();
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly options: CollaborationOptions) {}
  tools(_ownerId: string): readonly ToolDefinition[] {
    return [sendMessageTool];
  }
  execute(call: ToolCall, context: ActorContext<string>): Promise<Extract<ModelMessage, {role: 'tool'}>> {
    const operation = this.tail.then(async () => {
      try {
        context.signal.throwIfAborted();
        if (context.sessionId !== this.options.sessionId || !this.options.member(context.ownerId)) throw new Error('Invalid collaboration identity');
        if (!this.tools(context.ownerId).some(tool => tool.name === call.name)) throw new Error('Actor is not authorized to use this collaboration tool');
        const records = await this.options.journal.collaborations(context.sessionId);
        const sendInput = sendMessageSchema.parse(JSON.parse(call.arguments));
        const to = sendInput.to;
        const isBroadcast = to.toLowerCase() === 'all';
        if (!isBroadcast && to !== 'logox' && !this.options.member(to)) {
          throw new Error('Unknown or unavailable collaboration target: ' + to);
        }

        if (!isBroadcast && to === 'logox' && context.ownerId !== 'logox' && this.options.coordinate) {
          await this.options.coordinate(call.id, sendInput.message, sendInput.summary, context);
          return {role: 'tool' as const, callId: call.id, name: call.name,
            text: 'Assistance request admitted for Director coordination. No in-flight request or process was cancelled.', isError: false};
        }
        if (isBroadcast) {
          const targets = (this.options.members?.() ?? ['techne', 'kalon', 'aletheia']).filter(id => id !== context.ownerId);
          for (const target of targets) {
            if (target === 'logox' && this.options.coordinate) {
              await this.options.coordinate(call.id + ':broadcast', sendInput.message, sendInput.summary, context);
              continue;
            }
            const active = this.options.getActiveTask?.(target);
            const injected = active && this.options.injectMessage &&
              await this.options.injectMessage(target, sendInput.message, context.ownerId, sendInput.summary, sendInput.mode);
            if (!injected) {
              this.options.enqueue(target, `[Broadcast from ${context.ownerId}${sendInput.summary ? ` · ${sendInput.summary}` : ''}]\n${sendInput.message}`, context.ownerId, {inputKind: 'collaboration'});
            }
          }
          if (this.options.projectDir) {
            await appendProjectBulletin(this.options.projectDir, context.ownerId, sendInput.summary || 'Broadcast', sendInput.message);
          }
          return {role: 'tool' as const, callId: call.id, name: call.name, text: `Broadcast message sent to: ${targets.join(', ')} and recorded in bulletin.md`, isError: false};
        }

        // An active recipient receives the message in its running context instead of a queued card.
        const active = this.options.getActiveTask?.(to);
        if (active && this.options.injectMessage) {
          const mode = sendInput.mode ?? 'queue';
          const injected = await this.options.injectMessage(to, sendInput.message, context.ownerId, sendInput.summary, mode);
          if (injected) {
            const actionDesc = mode === 'interrupt' ? 'interrupted and injected' : 'delivered';
            return {
              role: 'tool' as const,
              callId: call.id,
              name: call.name,
              text: `Successfully ${actionDesc} message into active task of ${to} without creating a new card.`,
              isError: false,
            };
          }
        }

        if (sendInput.mode === 'interrupt' && this.options.interrupt) {
          const interrupted = this.options.interrupt(to, sendInput.message, context.ownerId, sendInput.summary);
          if (interrupted) {
            return {role: 'tool' as const, callId: call.id, name: call.name, text: `Successfully interrupted ${to} and injected message into its active activity without queueing.`, isError: false};
          }
        }

        const channelId = randomUUID();
        const receipt = `Delivered message to ${to}.`;
        const delivery = {
          owner: to,
          source: context.ownerId,
          prompt: `[Message from ${context.ownerId}${sendInput.summary ? ` · ${sendInput.summary}` : ''}]\n${sendInput.message}`,
        };
        records.push({
          id: channelId,
          sessionId: context.sessionId,
          activityId: context.activityId,
          requester: context.ownerId,
          target: to,
          reason: sendInput.summary ? sendInput.summary.slice(0, 2000) : sendInput.message.slice(0, 100),
          status: 'closed',
          messages: [{from: context.ownerId, text: sendInput.message.slice(0, 2000), activityId: context.activityId}],
          relatedActivities: [],
        });
        context.signal.throwIfAborted();
        await this.options.journal.saveCollaborations(context.sessionId, records);
        context.signal.throwIfAborted();
        try {
          const handle = this.options.enqueue(delivery.owner, delivery.prompt, delivery.source, {inputKind: 'collaboration',
            authorization: context.reviewMessages?.().filter(message => message.role === 'user').map(message => message.text).slice(-8) ?? context.authorization ?? []});
          this.deliveries.set(channelId, [...this.deliveries.get(channelId) ?? [], handle]);
          const remove = () => {
            const remaining = (this.deliveries.get(channelId) ?? []).filter(item => item !== handle);
            if (remaining.length) this.deliveries.set(channelId, remaining); else this.deliveries.delete(channelId);
          };
          void handle.done.then(remove, remove);
        } catch (error) {
          for (const record of records) if (record.id === channelId) record.status = 'interrupted';
          await this.options.journal.saveCollaborations(context.sessionId, records);
          throw error;
        }
        return {role: 'tool' as const, callId: call.id, name: call.name, text: receipt, isError: false};
      } catch (error) {
        return {role: 'tool' as const, callId: call.id, name: call.name, text: error instanceof Error ? error.message : 'Collaboration delivery failed', isError: true};
      }
    });
    this.tail = operation.then(() => {}, () => {});
    return operation;
  }
  private update(change: (record: CollaborationRecord) => void): Promise<void> {
    const operation = this.tail.then(async () => {
      const records = await this.options.journal.collaborations(this.options.sessionId);
      records.forEach(change);
      await this.options.journal.saveCollaborations(this.options.sessionId, records);
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
  settle(activityId: string, status: string): Promise<void> {
    if (status === 'completed') return Promise.resolve();
    return this.update(record => {
      if ((record.activityId === activityId || record.relatedActivities?.includes(activityId) || record.messages.some(message => message.activityId === activityId)) && ['pending', 'approved', 'closed'].includes(record.status)) {
        record.status = 'closed';
        for (const handle of this.deliveries.get(record.id) ?? []) handle.cancel();
        this.deliveries.delete(record.id);
      }
    });
  }
  recover(): Promise<void> {
    return this.update(record => {if (['pending', 'approved'].includes(record.status)) record.status = 'interrupted';});
  }
}
