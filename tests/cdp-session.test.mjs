import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {BrowserSession, validateBrowserEndpoint} from '../lib/cdp-session.mjs';

const endpoint = 'ws://127.0.0.1:9222/devtools/browser/test-browser';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const sockets = [];
  class MockSocket extends EventTarget {
    readyState = 0;
    sent = [];
    closeCount = 0;
    constructor(url) { super(); this.url = url; sockets.push(this); }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
    send(data) { this.sent.push(JSON.parse(data)); }
    receive(message) { this.dispatchEvent(new MessageEvent('message', {data: JSON.stringify(message)})); }
    reply(command, result = {}) { this.receive({id: command.id, result}); }
    close() { this.closeCount++; this.readyState = 3; this.dispatchEvent(new Event('close')); }
    fail() { this.dispatchEvent(new Event('error')); }
  }
  return {session: new BrowserSession({WebSocketImpl: MockSocket}), sockets};
}
async function opened(t) {
  const f = fixture();
  const connecting = f.session.connect(endpoint);
  f.sockets[0].open();
  await connecting;
  t.after(() => f.session.disconnect());
  return {...f, socket: f.sockets[0]};
}

test('endpoint validation accepts only local browser WebSocket endpoints', async () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    assert.ok(validateBrowserEndpoint(`ws://${host}:9222/devtools/browser/test-id`));
  }
  const {session, sockets} = fixture();
  for (const value of ['https://127.0.0.1:9222/devtools/browser/id', 'ws://remote.test:9222/devtools/browser/id',
    'ws://localhost:9222/devtools/page/id', 'ws://user:pass@localhost:9222/devtools/browser/id',
    'ws://localhost:9222/devtools/browser/id?x=1', 'ws://localhost:9222/devtools/browser/id#fragment',
    'ws://localhost:9222/Devtools/browser/id',
    'ws://127.1:9222/devtools/browser/id', 'ws://localhost:0/devtools/browser/id',
    'ws://localhost:65536/devtools/browser/id']) {
    await assert.rejects(session.connect(value), {code: 'CDP_ENDPOINT_INVALID'});
  }
  assert.equal(sockets.length, 0);
});

test('concurrent connects share one handshake and later calls reuse that socket', async t => {
  const {session, sockets} = fixture();
  t.after(() => session.disconnect());
  const first = session.connect(endpoint);
  assert.equal(first, session.connect(endpoint));
  assert.equal(session.connected, false);
  assert.equal(sockets.length, 1);
  sockets[0].open();
  assert.equal(await first, session);
  assert.equal(session.connected, true);
  await session.connect(endpoint);
  assert.equal(sockets.length, 1);
  await assert.rejects(session.connect(endpoint.replace('9222', '9223')), {code: 'CDP_ALREADY_CONNECTED'});
});

test('CDP responses are correlated out of order and protocol errors keep their code', async t => {
  const {session, socket} = await opened(t);
  const first = session.call('Browser.getVersion');
  const second = session.call('Target.getTargets');
  const failed = session.call('Unknown.method');
  const rejected = assert.rejects(failed, {code: 'CDP_ERROR', cdpCode: -32601, message: 'Unknown method'});
  socket.reply(socket.sent[1], {targetInfos: []});
  socket.receive({id: socket.sent[2].id, error: {code: -32601, message: 'Unknown method'}});
  socket.reply(socket.sent[0], {product: 'Chrome/mock'});
  assert.deepEqual(await first, {product: 'Chrome/mock'});
  assert.deepEqual(await second, {targetInfos: []});
  await rejected;
});

test('concurrent page commands share a flattened target session and reuse its cache', async t => {
  const {session, socket, sockets} = await opened(t);
  const first = session.pageCommand('page-1', 'Runtime.evaluate', {expression: '1'});
  const second = session.pageCommand('page-1', 'Page.getFrameTree');
  assert.deepEqual(socket.sent.map(item => item.method), ['Target.attachToTarget']);
  assert.deepEqual(socket.sent[0].params, {targetId: 'page-1', flatten: true});
  socket.reply(socket.sent[0], {sessionId: 'session-1'});
  await tick();
  assert.equal(socket.sent[1].sessionId, 'session-1');
  assert.equal(socket.sent[2].sessionId, 'session-1');
  socket.reply(socket.sent[1], {value: 1});
  socket.reply(socket.sent[2], {frameTree: {}});
  await Promise.all([first, second]);
  const third = session.pageCommand('page-1', 'Page.enable');
  socket.reply(socket.sent[3]);
  await third;
  assert.equal(socket.sent.filter(item => item.method === 'Target.attachToTarget').length, 1);
  assert.equal(sockets.length, 1);
});

test('detached sessions reject their pending commands and are reattached on next use', async t => {
  const {session, socket} = await opened(t);
  const pending = session.pageCommand('page-1', 'Page.enable');
  socket.reply(socket.sent[0], {sessionId: 'old-session'});
  await tick();
  const rejected = assert.rejects(pending, {code: 'CDP_SESSION_DETACHED'});
  socket.receive({method: 'Target.detachedFromTarget', params: {sessionId: 'old-session'}});
  await rejected;
  const next = session.pageCommand('page-1', 'Page.enable');
  assert.equal(socket.sent[2].method, 'Target.attachToTarget');
  socket.reply(socket.sent[2], {sessionId: 'new-session'});
  await tick();
  assert.equal(socket.sent[3].sessionId, 'new-session');
  socket.reply(socket.sent[3]);
  await next;
});

test('socket close or error rejects all pending calls, and late old events do not affect reconnects', async t => {
  for (const event of ['close', 'fail']) {
    const {session, socket, sockets} = await opened(t);
    const promises = [session.call('One'), session.call('Two')];
    const checked = promises.map(promise => assert.rejects(promise, {code: event === 'close' ? 'CDP_DISCONNECTED' : 'CDP_CONNECTION_FAILED'}));
    socket[event]();
    await Promise.all(checked);
    assert.equal(session.connected, false);
    const reconnected = session.connect(endpoint);
    sockets[1].open();
    await reconnected;
    socket.fail();
    assert.equal(session.connected, true);
  }
});

test('handshake timeout and explicit disconnect reject connecting promises and close only the socket', async () => {
  const {session, sockets} = fixture();
  await assert.rejects(session.connect(endpoint, {timeoutMs: 10}), {code: 'CDP_CONNECT_TIMEOUT'});
  assert.equal(sockets[0].closeCount, 1);
  const connecting = session.connect(endpoint);
  const rejected = assert.rejects(connecting, {code: 'CDP_DISCONNECTED'});
  session.disconnect();
  await rejected;
  assert.equal(sockets[1].closeCount, 1);
  assert.deepEqual(sockets.flatMap(socket => socket.sent), []);
});

test('command timeout ignores late replies while later commands still succeed', async t => {
  const {session, socket} = await opened(t);
  await assert.rejects(session.call('Slow', {}, undefined, 10), {code: 'CDP_COMMAND_TIMEOUT'});
  socket.reply(socket.sent[0], {late: true});
  const next = session.call('Next');
  socket.reply(socket.sent[1], {ok: true});
  assert.deepEqual(await next, {ok: true});
});

test('target discovery and creation normalize targetId as id without HTTP discovery', async t => {
  const {session, socket} = await opened(t);
  const targets = session.targets();
  socket.reply(socket.sent[0], {targetInfos: [{targetId: 'existing', type: 'page', url: 'about:blank'}]});
  assert.deepEqual(await targets, [{targetId: 'existing', id: 'existing', type: 'page', url: 'about:blank'}]);
  const created = session.createTarget('about:blank');
  assert.deepEqual(socket.sent[1].params, {url: 'about:blank'});
  socket.reply(socket.sent[1], {targetId: 'created'});
  await tick();
  assert.deepEqual(socket.sent[2].params, {targetId: 'created'});
  socket.reply(socket.sent[2], {targetInfo: {targetId: 'created', type: 'page', url: 'about:blank'}});
  assert.deepEqual(await created, {targetId: 'created', id: 'created', type: 'page', url: 'about:blank'});
});

test('disconnect rejects in-flight commands without closing browser targets', async t => {
  const {session, socket} = await opened(t);
  const pending = session.call('Browser.getVersion');
  const rejected = assert.rejects(pending, {code: 'CDP_DISCONNECTED'});
  session.disconnect();
  await rejected;
  assert.deepEqual(socket.sent.map(item => item.method), ['Browser.getVersion']);
  assert.equal(socket.closeCount, 1);
});

test('native Node WebSocket waits for upgrade approval and needs no Origin or auth headers', async t => {
  const server = http.createServer();
  const session = new BrowserSession();
  let peer;
  t.after(async () => {
    session.disconnect();
    peer?.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  const upgrade = new Promise(resolve => server.once('upgrade', (request, socket) => {
    peer = socket;
    resolve({request, socket});
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const connecting = session.connect(`ws://127.0.0.1:${server.address().port}/devtools/browser/mock`, {timeoutMs: 1000});
  const {request, socket} = await Promise.race([upgrade, connecting]);
  assert.equal(session.connected, false);
  assert.equal(request.headers.origin, undefined);
  assert.equal(request.headers.authorization, undefined);
  assert.equal(request.headers.cookie, undefined);
  const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  await connecting;
  let buffer = Buffer.alloc(0);
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length < 6 || (buffer[0] & 15) !== 1) return;
    const size = buffer[1] & 127;
    if (size >= 126 || buffer.length < 6 + size) return;
    const mask = buffer.subarray(2, 6);
    const data = Buffer.from(buffer.subarray(6, 6 + size));
    for (let index = 0; index < data.length; index++) data[index] ^= mask[index % 4];
    const command = JSON.parse(data.toString());
    const response = Buffer.from(JSON.stringify({id: command.id, result: {product: 'Chrome/mock'}}));
    buffer = buffer.subarray(6 + size);
    socket.write(Buffer.concat([Buffer.from([0x81, response.length]), response]));
  });
  assert.deepEqual(await session.call('Browser.getVersion'), {product: 'Chrome/mock'});
});
