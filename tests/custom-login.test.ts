import {test} from 'node:test';
import assert from 'node:assert/strict';
import {expandPortOrUrl} from '../src/providers/login.js';

test('expandPortOrUrl expands numeric ports to localhost endpoints and validates URLs', () => {
  assert.equal(expandPortOrUrl('8045'), 'http://127.0.0.1:8045/v1');
  assert.equal(expandPortOrUrl(' 8000 '), 'http://127.0.0.1:8000/v1');
  assert.equal(expandPortOrUrl('http://192.168.1.100:8000/v1'), 'http://192.168.1.100:8000/v1');
  assert.equal(expandPortOrUrl('https://api.my-domain.com/v1'), 'https://api.my-domain.com/v1');
  assert.throws(() => expandPortOrUrl('not-a-valid-url'), /Invalid/);
});
