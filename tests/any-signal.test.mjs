import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { anySignal } from '../dist/auth.js';

const native = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
before(() => Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined }));
after(() => Object.defineProperty(AbortSignal, 'any', native));

test('already aborted inputs preserve order and exact reason', () => {
  const first = new AbortController(), second = new AbortController();
  first.abort(new Error('first')); second.abort(new Error('second'));
  const signal = anySignal([first.signal, second.signal]);
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason, first.signal.reason);
});

test('first abort wins and releases every source listener', () => {
  const first = new AbortController(), second = new AbortController();
  const listeners = new Map();
  for (const source of [first.signal, second.signal]) {
    const add = source.addEventListener.bind(source), remove = source.removeEventListener.bind(source);
    source.addEventListener = (type, fn, options) => { if (type === 'abort') listeners.set(fn, source); add(type, fn, options); };
    source.removeEventListener = (type, fn, options) => { if (type === 'abort') listeners.delete(fn); remove(type, fn, options); };
  }
  const signal = anySignal([first.signal, first.signal, second.signal]);
  assert.equal(listeners.size, 2);
  const reason = new Error('cancelled');
  second.abort(reason); first.abort(new Error('late'));
  assert.equal(signal.reason, reason);
  assert.equal(listeners.size, 0);
});

test('timeout cancels a pending wait with the timeout reason', async () => {
  const lifetime = new AbortController();
  const timeout = AbortSignal.timeout(10);
  const signal = anySignal([lifetime.signal, timeout]);
  const alive = setTimeout(() => {}, 1000);
  try {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    assert.equal(signal.reason.name, 'TimeoutError');
    assert.equal(signal.reason, timeout.reason);
    assert.equal(lifetime.signal.aborted, false);
  } finally { clearTimeout(alive); }
});

test('native fetch body remains cancellable after response headers', async () => {
  const server = createServer((_req, res) => { res.writeHead(200); res.write('first'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const caller = new AbortController(), lifetime = new AbortController();
    const response = await fetch(`http://127.0.0.1:${server.address().port}`, { signal: anySignal([caller.signal, lifetime.signal]) });
    const reader = response.body.getReader();
    await reader.read();
    const pending = reader.read();
    lifetime.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    reader.releaseLock();
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
