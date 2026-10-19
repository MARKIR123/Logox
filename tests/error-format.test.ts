import test from 'node:test';
import assert from 'node:assert/strict';
import {formatNetworkError, formatDetailedError} from '../src/providers/error-format.js';

test('formatNetworkError unrolls ECONNREFUSED cause into structured diagnostic', () => {
  const cause = new Error('connect ECONNREFUSED 127.0.0.1:7897');
  Object.assign(cause, {code: 'ECONNREFUSED', address: '127.0.0.1', port: 7897, syscall: 'connect'});
  const error = new TypeError('fetch failed');
  (error as unknown as {cause: unknown}).cause = cause;

  const result = formatNetworkError(error, {
    url: 'https://auth.openai.com/api/accounts/oauth/token',
    method: 'POST',
    proxy: 'http://127.0.0.1:7897',
  });

  assert.ok(result.includes('Failed to fetch POST https://auth.openai.com/api/accounts/oauth/token'));
  assert.ok(result.includes('Connection refused by 127.0.0.1:7897 (ECONNREFUSED)'));
  assert.ok(result.includes('(via proxy http://127.0.0.1:7897)'));
});

test('formatNetworkError handles timeout and DNS lookup failures', () => {
  const timeoutErr = new Error('connect timeout');
  Object.assign(timeoutErr, {code: 'UND_ERR_CONNECT_TIMEOUT', address: '127.0.0.1', port: 7897});
  const topTimeout = new TypeError('fetch failed');
  (topTimeout as unknown as {cause: unknown}).cause = timeoutErr;

  const resTimeout = formatNetworkError(topTimeout, {url: 'https://api.openai.com'});
  assert.ok(resTimeout.includes('Connection timed out (UND_ERR_CONNECT_TIMEOUT)'));

  const dnsErr = new Error('getaddrinfo ENOTFOUND api.openai.com');
  Object.assign(dnsErr, {code: 'ENOTFOUND', hostname: 'api.openai.com'});
  const topDns = new TypeError('fetch failed');
  (topDns as unknown as {cause: unknown}).cause = dnsErr;

  const resDns = formatNetworkError(topDns, {url: 'https://api.openai.com'});
  assert.ok(resDns.includes('DNS domain resolution failed for api.openai.com (ENOTFOUND)'));
});

test('formatDetailedError formats standard and nested exceptions', () => {
  assert.equal(formatDetailedError('Direct string error'), 'Direct string error');
  assert.equal(formatDetailedError(new Error('Simple application failure')), 'Simple application failure');

  const cause = new Error('Proxy connection dropped');
  Object.assign(cause, {code: 'ECONNRESET'});
  const wrapped = new Error('OAuth flow aborted');
  (wrapped as unknown as {cause: unknown}).cause = cause;

  const formatted = formatDetailedError(wrapped);
  assert.ok(formatted.includes('OAuth flow aborted'));
  assert.ok(formatted.includes('Connection was abruptly closed or reset (ECONNRESET)'));
});
