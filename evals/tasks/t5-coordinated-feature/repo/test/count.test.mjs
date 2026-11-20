import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {countWords} from '../src/count.mjs';

describe('countWords', () => {
  it('counts case-insensitive words into a Map', () => {
    const result = countWords('Hello world, hello! Node 22.');
    assert.equal(result instanceof Map, true);
    assert.equal(result.get('hello'), 2);
    assert.equal(result.get('world'), 1);
    assert.equal(result.get('node'), 1);
    assert.equal(result.get('22'), 1);
  });

  it('returns an empty Map for blank input', () => {
    const result = countWords('   \n\t  ');
    assert.equal(result.size, 0);
  });
});
