import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { browserLink, pipeFor, serveNativeBridge } from '../../browser-local/transport.mjs';
import { frame, readFrames } from '../../lcu/native_host.mjs';
import { temporary } from './fixtures.mjs';

test('the local browser pipe authenticates MCP clients and releases each connection separately', { timeout: 8000 }, async t => {
  const token = randomBytes(32).toString('hex');
  const address = process.platform === 'win32' ? pipeFor(token) : join(temporary(t), 'browser.sock');
  const input = new PassThrough();
  const output = new PassThrough();
  const running = serveNativeBridge(address, token, input, output);
  const inbox = readFrames(output)[Symbol.asyncIterator]();
  const next = async () => JSON.parse((await inbox.next()).value.toString('utf8'));
  const reply = (id, value) => input.write(frame(Buffer.from(JSON.stringify({ id, value }))));
  const wrong = browserLink(address, randomBytes(32).toString('hex'));
  const first = browserLink(address, token);
  const other = browserLink(address, token);
  try {
    assert.deepEqual(await next(), { ready: true });
    await assert.rejects(wrong.request({ action: 'list' }), /disconnected/);
    const firstCall = first.request({ action: 'list' });
    const request = await next();
    assert.deepEqual(request.request, { action: 'list' });
    reply(request.id, [7]);
    assert.deepEqual(await firstCall, [7]);
    const secondCall = other.request({ action: 'snapshot', id: 10 });
    const second = await next();
    assert.notEqual(second.client, request.client);
    assert.deepEqual(second.request, { action: 'snapshot', id: 10 });
    reply(second.id, { text: '한글' });
    assert.deepEqual(await secondCall, { text: '한글' });
    first.close();
    assert.deepEqual(await next(), { client: request.client });
    await assert.rejects(first.request({ action: 'list' }), /session closed/);
    other.close();
    assert.deepEqual(await next(), { client: second.client });
  } finally {
    wrong.close();
    first.close();
    other.close();
    input.end();
    await running;
    output.end();
  }
});
