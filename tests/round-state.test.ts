import test from 'node:test';
import assert from 'node:assert/strict';
import {ASK_CLOSE_REMINDERS, REFUSED_BATCH_LIMIT, RoundState} from '../src/kernel/round-state.js';
import {EMPTY_REPLY_REMINDER} from '../src/prompts/runtime/recovery.js';

/** A state with a delivered answer awaiting its closing call, a recovery note and one owed-reply reminder spent. */
function busy(): RoundState {
  const state = new RoundState();
  state.replyOwed('owed');
  state.answerDelivered('answer');
  state.closingCallRequested();
  state.recovering('no_delivery', repeated => 'note ' + repeated);
  return state;
}

test('newInput withdraws the close and keeps the recovery note and kind', () => {
  const state = busy();
  assert.equal(state.closing, true);
  state.newInput();
  assert.equal(state.closing, false);
  assert.equal(state.finalText, '');
  assert.equal(state.recovery, 'note false');
  assert.equal(state.recoveringKind, 'no_delivery');
});

test('newInput restarts the owed-reply reminders', () => {
  const state = new RoundState();
  for (let index = 0; index < ASK_CLOSE_REMINDERS; index++) state.replyOwed('owed');
  assert.equal(state.mayRemindOwed, false);
  state.newInput();
  assert.equal(state.mayRemindOwed, true);
});

test('waitEnded does what newInput does and also drops the recovery note and kind', () => {
  const state = busy();
  state.waitEnded();
  assert.equal(state.closing, false);
  assert.equal(state.finalText, '');
  assert.equal(state.recovery, '');
  assert.equal(state.recoveringKind, undefined);
  assert.equal(state.mayRemindOwed, true);
});

test('replyOwed counts a reminder, replaces the note, clears the kind and withdraws the close', () => {
  const state = busy();
  state.replyOwed('you owe a reply');
  assert.equal(state.recovery, 'you owe a reply');
  assert.equal(state.recoveringKind, undefined);
  assert.equal(state.closing, false);
  assert.equal(state.finalText, '');
  assert.equal(state.mayRemindOwed, false);
});

test('closingCallRequested keeps the answer, starts the follow-up and clears the recovery note', () => {
  const state = new RoundState();
  state.recovering('no_delivery', () => 'note');
  state.answerDelivered('the answer');
  state.closingCallRequested();
  assert.equal(state.closing, true);
  assert.equal(state.finalText, 'the answer');
  assert.equal(state.recovery, '');
  assert.equal(state.recoveringKind, undefined);
});

test('recovering renders a repeated note from the second recovery on', () => {
  const state = new RoundState();
  const seen: boolean[] = [];
  state.recovering('truncated_tools', repeated => { seen.push(repeated); return 'one'; });
  state.recovering('truncated_text', repeated => { seen.push(repeated); return 'two'; });
  assert.deepEqual(seen, [false, true]);
  assert.equal(state.recovery, 'two');
  assert.equal(state.recoveringKind, 'truncated_text');
});

test('the empty-reply reminder is given once and does not count as a recovery', () => {
  const state = new RoundState();
  assert.equal(state.emptyReplyReminder(), true);
  assert.equal(state.recovery, EMPTY_REPLY_REMINDER);
  assert.equal(state.recoveringKind, 'no_delivery');
  assert.equal(state.emptyReplyReminder(), false);
  const seen: boolean[] = [];
  state.recovering('no_delivery', repeated => { seen.push(repeated); return 'x'; });
  assert.deepEqual(seen, [false]);
});

test('a task model change replaces the note but keeps the recovery kind, and remembers foreign signatures', () => {
  const state = new RoundState();
  state.recovering('truncated_text', () => 'old');
  state.foreignModelSignatures(['sig-a', 'sig-b']);
  state.taskModelChanged('model changed');
  assert.equal(state.recovery, 'model changed');
  assert.equal(state.recoveringKind, 'truncated_text');
  assert.deepEqual([...state.foreignSignatures], ['sig-a', 'sig-b']);
});

test('batchRan clears the recovery note and kind only', () => {
  const state = busy();
  state.batchRan();
  assert.equal(state.recovery, '');
  assert.equal(state.recoveringKind, undefined);
  assert.equal(state.closing, true);
  assert.equal(state.finalText, 'answer');
});

test('refused batches end the exchange on the limit-th in a row and the count restarts', () => {
  const state = new RoundState();
  for (let index = 1; index < REFUSED_BATCH_LIMIT; index++) assert.equal(state.batchSettled(true), false);
  assert.equal(state.batchSettled(true), true);
  assert.equal(state.batchSettled(true), false);
  assert.equal(state.batchSettled(false), false);
  assert.equal(state.batchSettled(true), false);
  assert.equal(state.batchSettled(true), true);
});

test('the iteration budget ignores the closing follow-up and can be extended', () => {
  const state = new RoundState();
  assert.equal(state.iterationsSpent(0), false);
  state.requestSent(); state.requestSent();
  assert.equal(state.iteration, 2);
  assert.equal(state.iterationsSpent(2), true);
  assert.equal(state.iterationsSpent(3), false);
  state.iterationsExtended();
  assert.equal(state.iteration, 0);
  state.answerDelivered('a'); state.closingCallRequested();
  state.requestSent();
  assert.equal(state.iteration, 0);
  assert.equal(state.iterationsSpent(1), false);
});

test('the image retry is spent once until the provider answers', () => {
  const state = new RoundState();
  assert.equal(state.imageRetry(), true);
  assert.equal(state.imageRetry(), false);
  state.providerAnswered();
  assert.equal(state.imageRetry(), true);
});

test('turn usage is handed to the first eligible assistant message only', () => {
  const state = new RoundState();
  const usage = {input: 1, output: 2} as never;
  state.turnMetered(usage);
  assert.equal(state.takeUsage({role: 'user', text: 'hi'}), undefined);
  assert.equal(state.takeUsage({role: 'assistant', text: 'failed attempt', contextExcluded: true}), undefined);
  assert.equal(state.takeUsage({role: 'assistant', text: 'real'}), usage);
  assert.equal(state.takeUsage({role: 'assistant', text: 'second'}), undefined);
  state.turnMetered(usage);
  state.turnStarted();
  assert.equal(state.takeUsage({role: 'assistant', text: 'after reset'}), undefined);
});

test('owed-question sightings count per question', () => {
  const state = new RoundState();
  assert.equal(state.owedSeen('a'), 1);
  assert.equal(state.owedSeen('a'), 2);
  assert.equal(state.owedSeen('b'), 1);
});
