import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import {readFileSync} from 'node:fs';
import {EMBLEM_PIXELS, emblemLines, splashLines, EMBLEM_WORDMARK, EMBLEM_TAGLINE} from '../src/tui/appearance/emblem.js';

const colors = {blue: 'blue', bone: 'bone', title: 'title', muted: 'muted'};
const text = (line: readonly {text: string}[]) => line.map(segment => segment.text).join('');

test('the emblem is 26 square pixels per side: 13 rows of 26 half-block cells', () => {
  assert.equal(EMBLEM_PIXELS.length, 26);
  assert.ok(EMBLEM_PIXELS.every(row => row.length === 26 && /^[.bw]+$/.test(row)));
  const lines = emblemLines(colors);
  assert.equal(lines.length, 13);
  assert.ok(lines.every(line => stringWidth(text(line)) === 26));
  assert.ok(lines.some(line => line.some(segment => segment.color === 'blue')) && lines.some(line => line.some(segment => segment.color === 'bone')));
});

test('wide terminals put the words beside the emblem; narrow ones stack; tiny ones fall back to plain text', () => {
  const info = ['anthropic/claude-opus-5-5 · Type /help for assistance'];
  const wide = splashLines({width: 100, height: 30, colors, title: 'Session abc', info})!;
  assert.equal(wide.length, 15);
  assert.ok(wide.some(line => text(line).includes(EMBLEM_WORDMARK) && /[█▀▄]/.test(text(line))), 'wordmark sits on an emblem row');
  assert.ok(wide.every(line => stringWidth(text(line)) <= 100));
  const narrow = splashLines({width: 52, height: 34, colors, title: 'Session abc', info})!;
  assert.ok(narrow.findIndex(line => text(line).includes(EMBLEM_WORDMARK)) > 13, 'words come below the emblem');
  assert.ok(narrow.every(line => stringWidth(text(line)) <= 52));
  assert.ok(narrow.some(line => text(line).trim() === EMBLEM_TAGLINE));
  assert.equal(splashLines({width: 20, height: 40, colors, info}), undefined);
  assert.equal(splashLines({width: 120, height: 10, colors, info}), undefined);
});

test('the splash emblem is the brand draft in assets/brand/draft-26.json', () => {
  const draft = JSON.parse(readFileSync(new URL('../../assets/brand/draft-26.json', import.meta.url), 'utf8')) as string[];
  assert.deepEqual([...EMBLEM_PIXELS], draft);
});
