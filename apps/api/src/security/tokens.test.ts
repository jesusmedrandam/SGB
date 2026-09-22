import assert from 'node:assert/strict';
import test from 'node:test';
import { hashToken, issueToken } from './tokens.js';

test('los tokens son aleatorios y solo se persiste su hash', () => {
  const first = issueToken('access');
  const second = issueToken('access');
  assert.match(first.value, /^sgb_at_/);
  assert.notEqual(first.value, second.value);
  assert.equal(first.hash, hashToken(first.value));
  assert.notEqual(first.hash, first.value);
});

test('cada propósito utiliza un prefijo distinto', () => {
  assert.match(issueToken('refresh').value, /^sgb_rt_/);
  assert.match(issueToken('verify').value, /^sgb_ev_/);
  assert.match(issueToken('reset').value, /^sgb_pr_/);
});
