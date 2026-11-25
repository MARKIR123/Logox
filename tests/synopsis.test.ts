import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSynopsis, visibleWhileStreaming} from '../src/context/synopsis.js';

const ANSWER = 'Fixed the wheel alignment in `pelican-bike.html` and checked it in the browser.';
const BLOCK = '<synopsis title="Wheel alignment">\nAligned both wheels to ground y=610; verified 4 phases in Playwright; nothing open.\n</synopsis>';
const SYNOPSIS = {title: 'Wheel alignment', summary: 'Aligned both wheels to ground y=610; verified 4 phases in Playwright; nothing open.'};

test('a block ending the reply is split from the answer', () => {
  assert.deepEqual(parseSynopsis(ANSWER + '\n\n' + BLOCK), {answer: ANSWER, synopsis: SYNOPSIS});
  assert.deepEqual(parseSynopsis(ANSWER + '\n\n' + BLOCK + '\n  \n'), {answer: ANSWER, synopsis: SYNOPSIS}, 'trailing blank space after the block');
  assert.deepEqual(parseSynopsis(ANSWER.replace(/ /g, ' ') + '\r\n\r\n' + BLOCK.replace(/\n/g, '\r\n')), {answer: ANSWER, synopsis: SYNOPSIS}, 'CRLF');
  assert.deepEqual(parseSynopsis(BLOCK), {answer: '', synopsis: SYNOPSIS}, 'a reply that is only a block delivers nothing');
});

test('the block is read leniently: tag spelling, title forms, a missing closing tag', () => {
  const body = 'Aligned both wheels; nothing open.';
  for (const block of [
    `<SYNOPSIS title='Wheel alignment'>\n${body}\n</SYNOPSIS>`,
    `<Synopsis title=Wheel>\n${body}`,
    `<synopsis>\nTitle: Wheel alignment\n${body}\n</synopsis>`,
    `<synopsis>\n标题：车轮对齐\n${body}`,
    `  <synopsis title="Wheel alignment"> ${body} </synopsis >`,
  ]) {
    const parsed = parseSynopsis(ANSWER + '\n' + block);
    assert.equal(parsed.answer, ANSWER, block);
    assert.equal(parsed.synopsis?.summary, body, block);
    assert.ok(parsed.synopsis?.title, block);
  }
  const untitled = parseSynopsis(ANSWER + '\n<synopsis>\nDid it.\nTitle: not a title line\n</synopsis>');
  assert.deepEqual(untitled.synopsis, {title: '', summary: 'Did it.\nTitle: not a title line'}, 'only a leading title line names the block');
});

test('an empty block is removed from the answer but carries no synopsis', () => {
  assert.deepEqual(parseSynopsis(ANSWER + '\n<synopsis title="x">\n  \n</synopsis>'), {answer: ANSWER});
});

test('a quoted tag never cuts the answer: mid-sentence, inline code, fenced, or followed by more text', () => {
  const replies = [
    'The marker is <synopsis title="..."> followed by the summary and a closing tag.',
    'Write `<synopsis title="x">` on its own line at the end.',
    'It looks like this:\n\n```xml\n<synopsis title="Example">\nWhat changed.\n</synopsis>\n```\n\nThat is all.',
    'It looks like this:\n\n~~~\n<synopsis title="Example">\nWhat changed.\n~~~',
    'An example:\n<synopsis title="Example">\nWhat changed.\n</synopsis>\nThe runtime strips it from what you see.',
  ];
  for (const reply of replies) assert.deepEqual(parseSynopsis(reply), {answer: reply}, reply);
});

test('a reply that quotes the format and then writes its real block keeps the quote and yields the real block', () => {
  const quoted = 'The format:\n\n```\n<synopsis title="Example">\nWhat changed.\n</synopsis>\n```\n\nAnd outside a fence:\n<synopsis title="Example">\nWhat changed.\n</synopsis>\nDone.';
  assert.deepEqual(parseSynopsis(quoted + '\n\n' + BLOCK), {answer: quoted, synopsis: SYNOPSIS});
});

test('a reply without a block is delivered unchanged', () => {
  for (const reply of ['', ANSWER, ANSWER + '\n\n', '<div>\n<roundabout>\n</div>', '<synopses>x</synopses>']) {
    assert.deepEqual(parseSynopsis(reply), {answer: reply}, JSON.stringify(reply));
  }
});

test('while streaming, no character of an ending block is ever shown, and the stream settles on the answer', () => {
  const replies = [
    ANSWER + '\n\n' + BLOCK,
    'Steps:\n\n```html\n<synopsis title="in a fence">\n```\n\n' + ANSWER + '\n' + BLOCK,
    'Quoted <synopsis> inline.\n<synopsis>\nTitle: T\nBody line.',
    ANSWER + '\r\n' + BLOCK.replace(/\n/g, '\r\n'),
  ];
  for (const reply of replies) {
    const {answer} = parseSynopsis(reply);
    for (let end = 0; end <= reply.length; end++) {
      const shown = visibleWhileStreaming(reply.slice(0, end));
      assert.ok(answer.startsWith(shown), `prefix ${end} of ${JSON.stringify(reply.slice(0, 40))} showed ${JSON.stringify(shown.slice(-30))}`);
    }
    assert.equal(visibleWhileStreaming(reply), answer);
  }
});

test('while streaming, a line that could still become a tag is held, and released once it cannot', () => {
  assert.equal(visibleWhileStreaming(ANSWER + '\n<'), ANSWER);
  assert.equal(visibleWhileStreaming(ANSWER + '\n<synop'), ANSWER);
  assert.equal(visibleWhileStreaming(ANSWER + '\n<synopsis title="Wheel'), ANSWER);
  assert.equal(visibleWhileStreaming(ANSWER + '\n<div'), ANSWER + '\n<div');
  assert.equal(visibleWhileStreaming('```\n<synop'), '```\n<synop', 'inside a fence nothing is held');
});

test('while streaming, a tag that turns out to be an example shows again once text follows its closing tag', () => {
  const example = 'An example:\n<synopsis title="Example">\nWhat changed.\n</synopsis>';
  assert.equal(visibleWhileStreaming(example), 'An example:');
  assert.equal(visibleWhileStreaming(example + '\nThe runtime strips it.'), example + '\nThe runtime strips it.');
});
