import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeFlockUrl, isForbiddenAddress } from './net.ts';

test('assertSafeFlockUrl accepts an API Gateway URL and strips nothing', () => {
  const u = assertSafeFlockUrl('https://abc123.execute-api.eu-central-1.amazonaws.com/prod');
  assert.equal(u.host, 'abc123.execute-api.eu-central-1.amazonaws.com');
  assert.equal(u.pathname, '/prod');
  assert.equal(assertSafeFlockUrl('https://flock.example.com:443/').port, '');
});

test('assertSafeFlockUrl rejects the usual suspects', () => {
  const bad = [
    'http://flock.example.com/prod',
    'https://127.0.0.1/prod',
    'https://[::1]/prod',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5/prod',
    'https://192.168.1.1/',
    'https://172.16.0.1/',
    'https://100.64.0.1/',
    'https://user:pw@flock.example.com/prod',
    'https://flock.example.com/prod#frag',
    'https://flock.example.com/prod?x=1',
    'https://flock.example.com:8443/prod',
    'https://localhost/prod',
    'https://flock.local/prod',
    'https://db.internal/',
    'not a url',
    'ftp://flock.example.com/',
  ];
  for (const b of bad) assert.throws(() => assertSafeFlockUrl(b), b);
});

test('isForbiddenAddress covers v4, v6 and mapped forms', () => {
  const forbidden = [
    '127.0.0.1', '10.1.2.3', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.127.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.1', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '2001:db8::1',
  ];
  for (const a of forbidden) assert.equal(isForbiddenAddress(a), true, a);
  const allowed = ['8.8.8.8', '52.1.2.3', '172.32.0.1', '172.15.0.1', '2600:1f18::1', '::ffff:8.8.8.8'];
  for (const a of allowed) assert.equal(isForbiddenAddress(a), false, a);
});
