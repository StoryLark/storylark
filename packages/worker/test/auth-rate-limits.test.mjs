// Rate limiting across every unauthenticated auth endpoint (AB#7391).
//
// Before this, /register, /login, /password/forgot and /magic/request were
// throttled but /password/reset and /code/verify — the two endpoints that
// let a caller GUESS a credential (a 6-digit code, or the reset token) —
// were not. /password/forgot and /magic/request were also only throttled
// per IP, which an attacker rotating IPs defeats while still mail-bombing
// one address's inbox.
//
// These drive the REAL Hono app (packages/worker/src/index.ts) over real
// Requests, against a REAL sqlite database carrying the REAL shipped
// migrations — including 0005_rate_limits.sql, so `rate_limits` is the real
// table the fixed-window helper in lib/ratelimit.ts reads and writes.
//
//   node --import tsx/esm --test packages/worker/test/auth-rate-limits.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDeployment } from './sqlite-env.mjs';

const CSRF = { 'x-requested-with': 'storylark' };

/** A fresh, plausible-looking source IP per call, so tests that mean to
 * isolate the per-email bucket don't also trip the per-IP one. */
function ipHeader(n) {
  return { 'cf-connecting-ip': `203.0.113.${n}` };
}

test('POST /api/auth/password/reset: guessing the token/code is rate limited per IP', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  // Same IP throughout — this is the bucket under test. Password is valid
  // length so the request gets past that check and all the way to the
  // token/code lookup, which is where a guess is actually being spent.
  const attempt = () =>
    dep.call('POST', '/api/auth/password/reset', { token: 'not-a-real-token', password: 'correcthorse' }, { ...CSRF, ...ipHeader(1) });

  for (let i = 0; i < 10; i++) {
    const res = await attempt();
    assert.equal(res.status, 400, `attempt ${i + 1} should be a normal (under-limit) refusal, got ${res.status}`);
    assert.equal(res.json.error, 'invalid_or_expired');
  }

  const blocked = await attempt();
  assert.equal(blocked.status, 429);
  assert.deepEqual(blocked.json, { error: 'rate_limited' }, 'same 429 shape every other limited endpoint uses');

  // A different IP is a different bucket, and is still under its own limit.
  const otherIp = await dep.call(
    'POST',
    '/api/auth/password/reset',
    { token: 'not-a-real-token', password: 'correcthorse' },
    { ...CSRF, ...ipHeader(2) }
  );
  assert.equal(otherIp.status, 400, 'a different IP bucket must not be affected by the first one being exhausted');
});

test('POST /api/auth/code/verify: guessing the 6-digit sign-in code is rate limited per IP', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  const attempt = () =>
    dep.call('POST', '/api/auth/code/verify', { email: 'reader@example.test', code: '000000' }, { ...CSRF, ...ipHeader(10) });

  for (let i = 0; i < 10; i++) {
    const res = await attempt();
    assert.equal(res.status, 401, `attempt ${i + 1} should be a normal (under-limit) refusal, got ${res.status}`);
    assert.equal(res.json.error, 'invalid_code');
  }

  const blocked = await attempt();
  assert.equal(blocked.status, 429);
  assert.deepEqual(blocked.json, { error: 'rate_limited' });

  const otherIp = await dep.call(
    'POST',
    '/api/auth/code/verify',
    { email: 'reader@example.test', code: '000000' },
    { ...CSRF, ...ipHeader(11) }
  );
  assert.equal(otherIp.status, 401, 'a different IP bucket must not be affected by the first one being exhausted');
});

test('POST /api/auth/password/forgot: rate limited per email too, not just per IP', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  // A fresh IP on every call isolates the EMAIL bucket: if only the (already
  // existing) IP bucket were doing the limiting, this loop would never see a
  // 429, because no IP is ever reused. The account doesn't need to exist —
  // the email bucket is spent before the user lookup, exactly like the
  // "always answer ok:true" enumeration guard around it.
  const target = 'flood-me@example.test';
  for (let i = 0; i < 5; i++) {
    const res = await dep.call('POST', '/api/auth/password/forgot', { email: target }, { ...CSRF, ...ipHeader(20 + i) });
    assert.equal(res.status, 200, `attempt ${i + 1} should be the normal (under-limit) always-200 answer`);
    assert.deepEqual(res.json, { ok: true });
  }

  const blocked = await dep.call('POST', '/api/auth/password/forgot', { email: target }, { ...CSRF, ...ipHeader(99) });
  assert.equal(blocked.status, 429);
  assert.deepEqual(blocked.json, { error: 'rate_limited' });

  // A different email, from a fresh IP, is a different bucket entirely.
  const otherEmail = await dep.call(
    'POST',
    '/api/auth/password/forgot',
    { email: 'someone-else@example.test' },
    { ...CSRF, ...ipHeader(100) }
  );
  assert.equal(otherEmail.status, 200, 'a different email bucket must not be affected by the first one being exhausted');
});

test('POST /api/auth/magic/request: rate limited per email too, not just per IP', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  // magic/request carries no CSRF check (matches the existing route, which
  // sets no session on this call) — same as production traffic hitting it.
  const target = 'flood-me@example.test';
  for (let i = 0; i < 5; i++) {
    const res = await dep.call('POST', '/api/auth/magic/request', { email: target }, ipHeader(30 + i));
    assert.equal(res.status, 200, `attempt ${i + 1} should be the normal (under-limit) always-200 answer`);
    assert.deepEqual(res.json, { ok: true });
  }

  const blocked = await dep.call('POST', '/api/auth/magic/request', { email: target }, ipHeader(199));
  assert.equal(blocked.status, 429);
  assert.deepEqual(blocked.json, { error: 'rate_limited' });

  const otherEmail = await dep.call('POST', '/api/auth/magic/request', { email: 'someone-else@example.test' }, ipHeader(200));
  assert.equal(otherEmail.status, 200, 'a different email bucket must not be affected by the first one being exhausted');
});

test('every rate-limited auth endpoint answers the same 429 shape', async (t) => {
  const dep = await testDeployment();
  t.after(() => dep.close());

  // Drains one shared IP bucket per case, confirming the response body is
  // byte-for-byte identical across every endpoint this change touches, plus
  // the two that were already covered before AB#7391.
  const cases = [
    { path: '/api/auth/register', body: { email: 'a@example.test', username: 'newuser1', password: 'longenough' }, limit: 5 },
    { path: '/api/auth/login', body: { identifier: 'nobody@example.test', password: 'whatever' }, limit: 10 },
    { path: '/api/auth/password/reset', body: { token: 'x', password: 'longenough' }, limit: 10 },
    { path: '/api/auth/code/verify', body: { email: 'a@example.test', code: '111111' }, limit: 10 },
  ];

  for (const { path, body, limit } of cases) {
    let last;
    for (let i = 0; i < limit + 1; i++) {
      last = await dep.call('POST', path, body, { ...CSRF, ...ipHeader(1) });
    }
    assert.equal(last.status, 429, `${path} should be rate limited after ${limit} attempts`);
    assert.deepEqual(last.json, { error: 'rate_limited' }, `${path} must use the standard rate_limited shape`);
  }
});
