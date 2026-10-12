import {randomUUID} from 'node:crypto';
import {immutable, interactionInputSchema, responseSchema, type Interaction, type InteractionOutcome, type InteractionResponse} from './contracts.js';

export interface InteractionTicket {readonly requestId: string; readonly result: Promise<InteractionOutcome>}
interface Pending {
  resolve: (outcome: InteractionOutcome) => void;
  detach: () => void;
}
export class Interactions {
  private readonly records = new Map<string, Interaction>();
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  constructor(private readonly onChange: () => void) {}
  list(): readonly Interaction[] { return Object.freeze([...this.records.values()]); }

  open(raw: unknown, signal?: AbortSignal): InteractionTicket {
    const input = interactionInputSchema.parse(raw);
    const requestId = randomUUID();
    let resolve!: Pending['resolve'];
    const result = new Promise<InteractionOutcome>(done => { resolve = done; });
    const cancel = () => this.cancel(requestId, '任务已取消');
    this.records.set(requestId, immutable({...input, requestId, status: 'pending'}));
    this.pending.set(requestId, {resolve, detach: () => signal?.removeEventListener('abort', cancel)});
    signal?.addEventListener('abort', cancel, {once: true});
    if (this.closed || signal?.aborted) this.cancel(requestId, this.closed ? '运行时已关闭' : '任务已取消');
    else this.onChange();
    return {requestId, result};
  }

  respond(raw: unknown): {ok: true} | {ok: false; reason: string} {
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) return {ok: false, reason: '回答格式不正确'};
    const response = parsed.data;
    const request = this.records.get(response.requestId);
    if (!request || request.status !== 'pending') return {ok: false, reason: '请求不存在或已结束'};
    if (request.sessionId !== response.sessionId || request.activityId !== response.activityId ||
        request.ownerId !== response.ownerId || request.kind !== response.kind) {
      return {ok: false, reason: '回答与请求身份不匹配'};
    }
    if (request.kind === 'question' && response.kind === 'question') {
      const keys = Object.keys(response.answers);
      if (keys.length !== request.questions.length || request.questions.some(question => {
        const answer = response.answers[question.id];
        return !answer || (answer.type === 'option' &&
          !question.options?.some(option => option.id === answer.optionId));
      })) return {ok: false, reason: '请完整回答每个问题并使用有效选项'};
    }
    this.settle(request, {status: 'answered', response: immutable(response)});
    return {ok: true};
  }

  cancel(requestId: string, reason = '用户取消'): boolean {
    const request = this.records.get(requestId);
    if (!request || request.status !== 'pending') return false;
    this.settle(request, {status: 'cancelled', reason});
    return true;
  }
  cancelActivity(sessionId: string, activityId: string): void {
    for (const request of this.records.values()) {
      if (request.sessionId === sessionId && request.activityId === activityId) this.cancel(request.requestId, '活动已结束');
    }
  }
  close(): void {
    this.closed = true;
    for (const requestId of this.pending.keys()) this.cancel(requestId, '运行时已关闭');
  }
  private settle(request: Interaction, outcome: InteractionOutcome): void {
    const pending = this.pending.get(request.requestId);
    if (!pending) return;
    pending.detach();
    this.pending.delete(request.requestId);
    this.records.set(request.requestId, immutable({...request, ...outcome}));
    pending.resolve(outcome);
    this.onChange();
  }
}
export function answerEnvelope(request: Interaction, response: Omit<Extract<InteractionResponse, {kind: 'permission'}>, 'requestId' | 'sessionId' | 'activityId' | 'ownerId'> |
  Omit<Extract<InteractionResponse, {kind: 'question'}>, 'requestId' | 'sessionId' | 'activityId' | 'ownerId'>): InteractionResponse {
  return {...response, requestId: request.requestId, sessionId: request.sessionId, activityId: request.activityId, ownerId: request.ownerId};
}
