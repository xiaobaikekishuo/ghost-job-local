import {test} from 'node:test';
import assert from 'node:assert/strict';
import {configureNetwork, parseWindowsProxy} from '../lib/network.mjs';

test('Windows plain proxy covers both destination protocols', () => {
  assert.deepEqual(parseWindowsProxy('127.0.0.1:3067'), {
    httpProxy: 'http://127.0.0.1:3067', httpsProxy: 'http://127.0.0.1:3067',
  });
});

test('Windows per-protocol values preserve the proxy transport', () => {
  assert.deepEqual(parseWindowsProxy('http=proxy.test:8080; https=https://secure.test:8443'), {
    httpProxy: 'http://proxy.test:8080', httpsProxy: 'https://secure.test:8443',
  });
  assert.deepEqual(parseWindowsProxy('https=proxy.test:8080'), {httpsProxy: 'http://proxy.test:8080'});
  assert.deepEqual(parseWindowsProxy('http=[::1]:8080;socks=localhost:1080'), {httpProxy: 'http://[::1]:8080'});
});

test('unsupported SOCKS and malformed addresses are rejected', () => {
  for (const value of ['socks5://localhost:1080', 'socks=localhost:1080', 'http=socks5://localhost:1080', 'http://proxy.test/path', 'http=']) {
    assert.throws(() => parseWindowsProxy(value));
  }
});

test('system proxy is applied with a merged loopback bypass and no environment mutation', () => {
  const env = {NO_PROXY: 'example.test,127.0.0.1', no_proxy: 'internal.test'};
  const original = {...env};
  let applied;
  assert.deepEqual(configureNetwork({env, platform: 'win32',
    readWindowsProxy: () => ({enabled: true, server: '127.0.0.1:3067'}),
    applyProxy: value => {applied = value;},
  }), {configured: true, source: 'windows'});
  assert.equal(applied.HTTP_PROXY, 'http://127.0.0.1:3067');
  assert.equal(applied.HTTPS_PROXY, 'http://127.0.0.1:3067');
  assert.deepEqual(new Set(applied.no_proxy.split(',')), new Set(['example.test', 'internal.test', 'localhost', '127.0.0.1', '::1']));
  assert.equal(applied.NO_PROXY, applied.no_proxy);
  assert.deepEqual(env, original);
});

test('existing environment proxies win and lower-case values take priority', () => {
  const env = {http_proxy: 'http://preferred.test:80', HTTP_PROXY: 'http://unused.test:80', HTTPS_PROXY: 'https://secure.test:443'};
  let read = false;
  let applied;
  assert.deepEqual(configureNetwork({env, platform: 'win32',
    readWindowsProxy: () => {read = true; throw new Error('must not read');},
    applyProxy: value => {applied = value;},
  }), {configured: true, source: 'environment'});
  assert.equal(read, false);
  assert.equal(applied.http_proxy, env.http_proxy);
  assert.equal(applied.https_proxy, env.HTTPS_PROXY);
});

test('disabled, absent, and non-Windows proxies leave the runtime untouched', () => {
  for (const settings of [{enabled: false, server: 'proxy.test:8080'}, {enabled: true, server: ''}, null]) {
    let applied = false;
    assert.deepEqual(configureNetwork({env: {}, platform: 'win32', readWindowsProxy: () => settings,
      applyProxy: () => {applied = true;},
    }), {configured: false, source: 'none'});
    assert.equal(applied, false);
  }
  assert.deepEqual(configureNetwork({env: {}, platform: 'linux',
    readWindowsProxy: () => {throw new Error('must not read');},
    applyProxy: () => {throw new Error('must not apply');},
  }), {configured: false, source: 'none'});
});

test('unsupported environment proxy and adapter failures report no sensitive URL', () => {
  let applied = false;
  const unsupported = configureNetwork({env: {HTTPS_PROXY: 'socks5://user:secret@proxy.test:1080'},
    applyProxy: () => {applied = true;},
  });
  assert.equal(unsupported.configured, false);
  assert.equal(applied, false);
  const failed = configureNetwork({env: {HTTPS_PROXY: 'http://user:secret@proxy.test:8080'},
    applyProxy: () => {throw new Error('secret@proxy.test');},
  });
  assert.equal(failed.configured, false);
  assert.doesNotMatch(JSON.stringify([unsupported, failed]), /secret|proxy\.test/);
  assert.equal(typeof failed.warning, 'string');
});
