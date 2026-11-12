import {setTimeout as delay} from 'node:timers/promises';
import {FALLBACK_CAPABILITIES} from '../providers/capabilities.js';
import {ProviderError, isProviderInterruption} from '../providers/http.js';
import type {Delta, ModelRequest, ModelTurn, Provider} from '../runtime/messages.js';
import {extractNarration} from '../runtime/narration.js';
import type {ReadyRequest} from './request.js';
import type {AgentRun} from './run.js';

/** A drafting update reaches the store when the call grew by this many characters or this many milliseconds passed (or its tool or target changed). */
const DRAFT_CHARS_STEP = 1024, DRAFT_MS_STEP = 250;

/** What one request came to: a turn, or an instruction to the loop. */
export type ModelTurnResult =
  | {readonly kind: 'turn'; readonly turn: ModelTurn; readonly request: ModelRequest; readonly thinkingId: string; readonly textId: string | undefined;
    readonly usedProvider: Provider; readonly requestedAt: number}
  /** Build the request again: input arrived, the tools changed, images were downgraded or the task model was replaced. */
  | {readonly kind: 'rebuild'}
  /** The closing follow-up failed after the answer was delivered: the round is complete. */
  | {readonly kind: 'finished'};

/** Sends one request with retries, backoff and streaming display. Persists the partial reply when the request fails for good. */
export async function requestTurn(run: AgentRun, ready: ReadyRequest): Promise<ModelTurnResult> {
  const {options, state, steps, taskModel, messages} = run;
  const {instruction, appendUpdate} = ready;
  let request = ready.request;
  let emitted = false, textId: string | undefined;
  let thinkingId = steps.thinking();
  // Tool arguments can stream for minutes with no text or reasoning; the running step shows them as drafting (store writes throttled).
  let draftId: string | undefined, drafted: {tool: string; target: string | undefined; chars: number; at: number} | undefined;
  const draft = (delta: Extract<Delta, {kind: 'tool'}>) => {
    const at = Date.now();
    if (drafted && drafted.tool === delta.name && drafted.target === delta.target && delta.chars - drafted.chars < DRAFT_CHARS_STEP && at - drafted.at < DRAFT_MS_STEP) return;
    drafted = {tool: delta.name, target: delta.target, chars: delta.chars, at};
    let id = thinkingId;
    if (steps.get(id).state !== 'running') id = draftId ??= steps.draftStep(); // prose already closed the thinking step
    steps.drafting(id, {tool: delta.name, ...(delta.target ? {target: delta.target} : {}), chars: delta.chars});
  };
  const endDraft = (end: 'completed' | 'failed' | 'cancelled') => {
    if (draftId && steps.get(draftId).state === 'running') steps.finish(draftId, end);
    draftId = undefined; drafted = undefined;
  };
  let usedProvider: Provider | undefined, requestedAt = 0;
  state.turnStarted();
  for (let attempt = 0;; attempt++) {
    if (attempt > 0) {
      let changed = await run.drainInbox();
      if (options.requestBase) {
        const retryProvider = taskModel?.provider() ?? options.provider();
        const refreshed = await options.requestBase(run.context, {capabilities: await retryProvider.resolveCapabilities?.(run.context.signal) ?? retryProvider.capabilities ?? FALLBACK_CAPABILITIES, history: messages});
        changed ||= refreshed.system !== instruction.system || JSON.stringify(refreshed.tools) !== JSON.stringify(instruction.tools);
        for (const update of refreshed.contextUpdates ?? []) changed = await appendUpdate(update) || changed;
      }
      if (changed) {
        steps.finish(thinkingId, 'completed'); steps.endGroup('completed');
        return {kind: 'rebuild'};
      }
    }
    let streamedText = '';
    let streamNarrationExtracted = false;
    try {
      usedProvider = taskModel?.provider() ?? options.provider();
      options.keepAlive?.wake(run.context);
      requestedAt = Date.now();
      const turn = await usedProvider.respond(request, delta => {
        if (delta.kind === 'tool') return draft(delta);
        emitted = true;
        const kind = delta.kind;
        if (state.closing && kind === 'text') return;
        if (kind === 'text' && steps.get(thinkingId).state === 'running') {
          steps.finish(thinkingId, 'completed'); steps.endGroup('completed'); steps.phase('text');
        }
        if (kind === 'text') {
          streamedText += delta.text;
          if (!streamNarrationExtracted && (streamedText.includes('\n') || streamedText.length >= 40)) {
            const early = extractNarration(streamedText);
            if (early) {
              streamNarrationExtracted = true;
              options.store.activities.update(run.context.sessionId, run.context.activityId, {
                progress: {label: early.narration},
              });
            }
          }
        }
        let id = kind === 'text' ? textId : thinkingId;
        if (!id) {
          id = options.store.message(run.context.sessionId, run.context.ownerId, 'assistant', '', {
            activityId: run.context.activityId, ...(kind === 'reasoning' ? {kind: 'thinking' as const} : {}),
          });
          if (kind === 'text') textId = id;
        }
        options.store.appendMessage(id, delta.text);
      }, run.context.signal);
      endDraft('completed');
      options.store.flush();
      state.providerAnswered();
      return {kind: 'turn', turn, request, thinkingId, textId, usedProvider, requestedAt};
    } catch (error) {
      endDraft(run.context.signal.aborted ? 'cancelled' : 'failed');
      options.store.flush();
      if (error instanceof ProviderError && error.diagnostic?.issue === 'too_many_images' && options.context && !run.context.signal.aborted && state.imageRetry()) {
        options.context.downgradeImages(run.context);
        steps.finish(thinkingId, 'failed'); steps.endGroup('failed');
        return {kind: 'rebuild'};
      }
      const interruption = isProviderInterruption(error);
      const retry = !run.context.signal.aborted && error instanceof ProviderError && error.retryable && attempt < options.retries &&
        (interruption ? await (options.retryProvider?.(run.context, error) ?? Promise.resolve(attempt < 2)) : !emitted);
      if (retry && interruption) {
        const snapshot = options.store.getSnapshot();
        const text = snapshot.messages.find(message => message.id === textId)?.text ?? '';
        const reasoning = snapshot.messages.find(message => message.id === thinkingId)?.text;
        const step = steps.finish(thinkingId, 'failed'); steps.endGroup('failed');
        // A failed attempt is kept for history reading only. Retries reuse the original request and never splice partial replies or run half-received tool arguments.
        if (emitted) await run.context.record({role: 'assistant', text, ...(reasoning ? {reasoning} : {}), contextExcluded: true}, step);
        thinkingId = steps.thinking(); textId = undefined; emitted = false;
        run.context.report('Network retry', 'Connection interrupted. Retrying (' + (attempt + 1) + '/' + options.retries + ')...');
        const resume = steps.wait(thinkingId, 'Waiting for retry');
        try {await delay(Math.min(30_000, 500 * 2 ** attempt), undefined, {signal: run.context.signal});} finally {resume();}
        // Aligned with Claude Code: after a long streaming connection is reset by a proxy or intermediate gateway, retries downgrade to non-streaming requests to avoid long-stream timeouts entirely
        request = {...request, stream: false};
        continue;
      }
      if (retry) {
        run.context.report('Network retry', '[Network] Service unavailable' + (error instanceof ProviderError && error.diagnostic?.status ? ' (HTTP ' + error.diagnostic.status + ')' : '') +
          '. Retrying (' + (attempt + 1) + '/' + options.retries + ')...');
        const resume = steps.wait(thinkingId, 'Waiting for retry');
        try {await delay(Math.min(30_000, 500 * 2 ** attempt), undefined, {signal: run.context.signal});} finally {resume();}
        continue;
      }
      // Already displayed increments are saved too, so the next round can see output from before the interruption.
      const snapshot = options.store.getSnapshot();
      const text = snapshot.messages.find(message => message.id === textId)?.text ?? '';
      const reasoning = snapshot.messages.find(message => message.id === thinkingId)?.text;
      const step = steps.finish(thinkingId, run.context.signal.aborted ? 'cancelled' : 'failed');
      // The store keeps the raw `⏵` line for the timeline; the ledger never does.
      const partial = extractNarration(text);
      await run.persist({role: 'assistant', text: partial ? partial.cleanText : text, ...(partial ? {stage: partial.narration} : {}), ...(reasoning ? {reasoning} : {}), ...(state.closing ? {memoryOnly: true as const} : {})}, step);
      if (state.closing && !run.context.signal.aborted) {
        if (await run.drainInbox(true)) return {kind: 'rebuild'};
        run.context.signal.throwIfAborted();
        return {kind: 'finished'};
      }
      if (await taskModel?.fallback(error)) {
        state.foreignModelSignatures(messages.flatMap(message => message.role === 'assistant' && message.signature ? [message.signature] : []));
        options.context?.meter(run.context).invalidate();
        state.taskModelChanged('The task model changed. Continue from preserved results without replaying completed operations.');
        return {kind: 'rebuild'};
      }
      if (error instanceof ProviderError) error.context = {...taskModel?.selection(), attempts: attempt + 1};
      throw error;
    }
  }
}
