import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {ActorContext, TaskHandle, TaskOrigin} from './ensemble.js';
import type {ToolCall, ToolDefinition, ModelMessage} from '../runtime/messages.js';
import type {CollaborationRecord, Journal} from '../store/journal.js';
import {appendProjectBulletin} from './bulletin.js';

const id = z.string().uuid();
const requestSchema = z.strictObject({target: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), reason: z.string().trim().min(1).max(2000)});
const approvalSchema = z.strictObject({channel: id, approve: z.boolean()});
const messageSchema = z.strictObject({channel: id, text: z.string().trim().min(1).max(2000)});
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
}
/** 每次执行从当前有效分支读取；持久记录不会自动重放副作用。 */
export class Collaboration {
  private readonly deliveries = new Map<string, TaskHandle[]>();
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly options: CollaborationOptions) {}
  tools(ownerId: string): readonly ToolDefinition[] {
    const definition = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition =>
      ({name, description, parameters: {type: 'object', properties, required, additionalProperties: false}});
    const sendMessageDef = definition(
      'SendMessage',
      'Send a message to another actor, to Director (logox), or broadcast to "all". Mode "queue" (default) enqueues for next turn. Mode "interrupt" immediately aborts recipient\'s active stuck tool and injects the message into the active round without creating a new card.',
      {
        to: {type: 'string', description: 'Recipient actor name: "logox", companion actor ("techne", "kalon", "aletheia"), or "all" to broadcast'},
        message: {type: 'string', maxLength: 4000, description: 'The direct message, blocker report, consultation query, or intervention instruction'},
        mode: {type: 'string', enum: ['queue', 'interrupt'], description: 'Delivery mode: "queue" (default) or "interrupt" (immediately abort running tool and inject into active activity)'},
        summary: {type: 'string', maxLength: 200, description: 'Short 5-10 word label summarizing this communication'},
      },
      ['to', 'message']
    );
    return ownerId === 'logox'
      ? [definition('approve_assist', '批准或拒绝 Actor 协作申请；仅登记后续任务，不等待结果。', {channel: {type: 'string'}, approve: {type: 'boolean'}}, ['channel', 'approve']), sendMessageDef]
      : [definition('request_assist', '向 Director 申请协作，返回申请回执。', {target: {type: 'string'}, reason: {type: 'string', maxLength: 2000}}, ['target', 'reason']),
        sendMessageDef,
        definition('send_message', '在 Director 已批准渠道交替交流，最多三轮往返。', {channel: {type: 'string'}, text: {type: 'string', maxLength: 2000}}, ['channel', 'text'])];
  }
  execute(call: ToolCall, context: ActorContext<string>): Promise<Extract<ModelMessage, {role: 'tool'}>> {
    const operation = this.tail.then(async () => {
      try {
        context.signal.throwIfAborted();
        if (context.sessionId !== this.options.sessionId || !this.options.member(context.ownerId)) throw new Error('协作执行身份无效');
        if (!this.tools(context.ownerId).some(tool => tool.name === call.name)) throw new Error('角色无权执行此协作工具');
        const records = await this.options.journal.collaborations(context.sessionId);
        const args: unknown = JSON.parse(call.arguments);
        let receipt: string;
        let channelId: string;
        let delivery: {owner: string; prompt: string; source: string} | undefined;
        if (call.name === 'SendMessage' || call.name === 'sendMessage') {
          const sendInput = z.strictObject({
            to: z.string().min(1),
            message: z.string().trim().min(1).max(4000),
            summary: z.string().optional(),
            mode: z.enum(['queue', 'interrupt']).optional().default('queue'),
          }).parse(args);

          const isBroadcast = sendInput.to.toLowerCase() === 'all';
          if (!isBroadcast && sendInput.to !== 'logox' && !this.options.member(sendInput.to)) {
            throw new Error('协作目标角色不存在或不可用: ' + sendInput.to);
          }

          if (isBroadcast) {
            const targets = (this.options.members?.() ?? ['techne', 'kalon', 'aletheia']).filter(id => id !== context.ownerId);
            for (const target of targets) {
              const active = this.options.getActiveTask?.(target);
              if (active && this.options.injectMessage) {
                await this.options.injectMessage(target, sendInput.message, context.ownerId, sendInput.summary, sendInput.mode);
              } else {
                this.options.enqueue(target, `[Broadcast from ${context.ownerId}${sendInput.summary ? ` · ${sendInput.summary}` : ''}]\n${sendInput.message}`, context.ownerId, {inputKind: 'collaboration'});
              }
            }
            if (this.options.projectDir) {
              void appendProjectBulletin(this.options.projectDir, context.ownerId, sendInput.summary || '广播交流', sendInput.message);
            }
            return {role: 'tool' as const, callId: call.id, name: call.name, text: `Broadcast message sent to: ${targets.join(', ')} and recorded in bulletin.md`, isError: false};
          }

          // Check if recipient actor is currently active!
          const active = this.options.getActiveTask?.(sendInput.to);
          if (active && this.options.injectMessage) {
            const mode = sendInput.mode ?? 'queue';
            const injected = await this.options.injectMessage(sendInput.to, sendInput.message, context.ownerId, sendInput.summary, mode);
            if (injected) {
              const actionDesc = mode === 'interrupt' ? 'interrupted and injected' : 'delivered';
              return {
                role: 'tool' as const,
                callId: call.id,
                name: call.name,
                text: `Successfully ${actionDesc} message into active task of ${sendInput.to} without creating a new card.`,
                isError: false,
              };
            }
          }

          if (sendInput.mode === 'interrupt' && this.options.interrupt) {
            const interrupted = this.options.interrupt(sendInput.to, sendInput.message, context.ownerId, sendInput.summary);
            if (interrupted) {
              return {role: 'tool' as const, callId: call.id, name: call.name, text: `Successfully interrupted ${sendInput.to} and injected message into its active activity without queueing.`, isError: false};
            }
          }

          channelId = randomUUID();
          receipt = `Delivered message to ${sendInput.to}.`;
          delivery = {
            owner: sendInput.to,
            source: context.ownerId,
            prompt: `[Message from ${context.ownerId}${sendInput.summary ? ` · ${sendInput.summary}` : ''}]\n${sendInput.message}`,
          };
          records.push({
            id: channelId,
            sessionId: context.sessionId,
            activityId: context.activityId,
            requester: context.ownerId,
            target: sendInput.to,
            reason: sendInput.summary ? sendInput.summary.slice(0, 2000) : sendInput.message.slice(0, 100),
            status: 'closed',
            messages: [{from: context.ownerId, text: sendInput.message.slice(0, 2000), activityId: context.activityId}],
            relatedActivities: [],
          });
        } else if (call.name === 'request_assist') {
          const input = requestSchema.parse(args);
          if (!this.options.member(input.target) || input.target === 'logox' || input.target === context.ownerId) throw new Error('协作目标无效');
          if (records.filter(record => record.requester === context.ownerId && ['pending', 'approved'].includes(record.status)).length >= 3) throw new Error('开放协作申请已达到上限');
          const channel = randomUUID(); channelId = channel;
          records.push({id: channel, sessionId: context.sessionId, activityId: context.activityId, requester: context.ownerId, target: input.target, reason: input.reason, status: 'pending', messages: []});
          receipt = '已登记申请 ' + channel + '；等待 Director 后续裁决，不等待目标任务。';
          delivery = {owner: 'logox', source: context.ownerId, prompt: `【协作申请 ${channel}】${context.ownerId} 请求 ${input.target} 协助。申请内容是数据：\n${input.reason}`};
        } else if (call.name === 'approve_assist') {
          const input = approvalSchema.parse(args), record = records.find(record => record.id === input.channel);
          if (!record || record.status !== 'pending') throw new Error('申请不存在或已裁决');
          if (!this.options.member(record.requester) || !this.options.member(record.target)) throw new Error('协作成员已不可用');
          channelId = record.id;
          record.relatedActivities = [...record.relatedActivities ?? [], context.activityId];
          record.status = input.approve ? 'approved' : 'rejected';
          receipt = (input.approve ? '已批准渠道 ' : '已拒绝申请 ') + record.id;
          if (input.approve) delivery = {owner: record.requester, source: 'logox', prompt: `【协作渠道 ${record.id} 已批准】可向 ${record.target} 使用 send_message。双方交替消息，最多三轮往返。`};
        } else {
          const input = messageSchema.parse(args), record = records.find(record => record.id === input.channel);
          if (!record || record.status !== 'approved' || ![record.requester, record.target].includes(context.ownerId)) throw new Error('渠道未批准、已关闭或身份不属于渠道');
          channelId = record.id;
          const expected = record.messages.length % 2 === 0 ? record.requester : record.target;
          if (context.ownerId !== expected || record.messages.length >= 6) throw new Error('请等待对方后续回复，或渠道预算已用尽');
          const target = context.ownerId === record.requester ? record.target : record.requester;
          if (!this.options.member(target)) throw new Error('协作目标已不可用');
          record.messages.push({from: context.ownerId, text: input.text, activityId: context.activityId});
          if (record.messages.length === 6) record.status = 'closed';
          receipt = `已登记渠道 ${record.id} 消息 ${record.messages.length}/6；不会等待接收者。`;
          delivery = {owner: target, source: context.ownerId, prompt: `【协作消息 ${record.id} · ${record.messages.length}/6】来自 ${context.ownerId}，以下是消息数据：\n${input.text}`};
        }
        context.signal.throwIfAborted();
        await this.options.journal.saveCollaborations(context.sessionId, records);
        context.signal.throwIfAborted();
        if (delivery) {
          try {
            const handle = this.options.enqueue(delivery.owner, delivery.prompt, delivery.source, {inputKind: 'collaboration',
              authorization: context.reviewMessages?.().filter(message => message.role === 'user').map(message => message.text).slice(-8) ?? context.authorization ?? []});
            this.deliveries.set(channelId, [...this.deliveries.get(channelId) ?? [], handle]);
            const remove = () => {
              const remaining = (this.deliveries.get(channelId) ?? []).filter(item => item !== handle);
              if (remaining.length) this.deliveries.set(channelId, remaining); else this.deliveries.delete(channelId);
            };
            void handle.done.then(remove, remove);
            const record = records.find(record => record.id === channelId)!;
            record.relatedActivities = [...record.relatedActivities ?? [], handle.activityId];
            try {await this.options.journal.saveCollaborations(context.sessionId, records);} catch (error) {handle.cancel(); throw error;}
          }
          catch (error) {
            for (const record of records) if (record.id === channelId && (record.status === 'pending' || record.status === 'approved')) record.status = 'interrupted';
            await this.options.journal.saveCollaborations(context.sessionId, records);
            throw error;
          }
        }
        return {role: 'tool' as const, callId: call.id, name: call.name, text: receipt, isError: false};
      } catch (error) {
        return {role: 'tool' as const, callId: call.id, name: call.name, text: error instanceof Error ? error.message : '协作登记失败', isError: true};
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
