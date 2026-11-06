function failure(code, message, extra = {}) {
  return Object.assign(new Error(message), {code, ...extra});
}

export function validateBrowserEndpoint(value) {
  if (typeof value !== 'string' || !/^ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/devtools\/browser\/[a-z\d_-]+$/i.test(value)) {
    throw failure('CDP_ENDPOINT_INVALID', '只允许本机 Chrome 的 browser WebSocket 调试地址。');
  }
  let url;
  try { url = new URL(value); } catch {
    throw failure('CDP_ENDPOINT_INVALID', 'Chrome 调试地址格式无效。');
  }
  if (url.port === '0' || !/^\/devtools\/browser\/[A-Za-z\d_-]+$/.test(url.pathname)) {
    throw failure('CDP_ENDPOINT_INVALID', 'Chrome 调试端口或路径无效。');
  }
  return url.href;
}

function validTimeout(value) {
  if (!Number.isFinite(value) || value <= 0 || value > 2147483647) {
    throw failure('CDP_TIMEOUT_INVALID', '浏览器连接超时时间无效。');
  }
  return value;
}

// Chrome's approval mode completes the WebSocket handshake only after the user
// allows it. Keep one browser socket and multiplex flattened target sessions;
// /json/list and per-page sockets are not available in that mode.
export class BrowserSession {
  #WebSocket;
  #connection = null;
  #pending = new Map();
  #sessions = new Map();
  #attaching = new Map();
  #nextId = 0;

  constructor({WebSocketImpl = globalThis.WebSocket} = {}) {
    this.#WebSocket = WebSocketImpl;
  }

  get connected() {
    return Boolean(this.#connection?.opened && this.#connection.socket.readyState === 1);
  }

  connect(wsEndpoint, {timeoutMs = 60000} = {}) {
    let endpoint;
    try {
      endpoint = validateBrowserEndpoint(wsEndpoint);
      validTimeout(timeoutMs);
    } catch (error) { return Promise.reject(error); }
    if (this.#connection) {
      if (this.#connection.endpoint !== endpoint) {
        return Promise.reject(failure('CDP_ALREADY_CONNECTED', '请先断开当前浏览器连接。'));
      }
      return this.#connection.promise;
    }
    let socket;
    try { socket = new this.#WebSocket(endpoint); } catch {
      return Promise.reject(failure('CDP_CONNECTION_FAILED', '无法连接 Chrome 调试会话。'));
    }
    const connection = {socket, endpoint, opened: false};
    connection.promise = new Promise((resolve, reject) => {
      connection.resolve = resolve;
      connection.reject = reject;
    });
    this.#connection = connection;
    connection.timer = setTimeout(() => this.#terminate(connection,
      failure('CDP_CONNECT_TIMEOUT', '等待 Chrome 连接超时，请检查调试开关并在 Chrome 中允许连接。')), timeoutMs);
    socket.addEventListener('open', () => {
      if (this.#connection !== connection) return;
      clearTimeout(connection.timer);
      connection.opened = true;
      connection.resolve(this);
      connection.resolve = connection.reject = null;
    });
    socket.addEventListener('message', event => {
      if (this.#connection === connection) this.#receive(connection, event.data);
    });
    socket.addEventListener('close', () => this.#terminate(connection,
      failure('CDP_DISCONNECTED', 'Chrome 调试连接已断开。')));
    socket.addEventListener('error', () => this.#terminate(connection,
      failure('CDP_CONNECTION_FAILED', 'Chrome 调试连接失败，请确认已允许连接。')));
    return connection.promise;
  }

  call(method, params = {}, sessionId, timeoutMs = 15000) {
    if (!this.connected) return Promise.reject(failure('CDP_DISCONNECTED', '尚未连接 Chrome 调试会话。'));
    let message;
    const id = ++this.#nextId;
    try {
      validTimeout(timeoutMs);
      if (typeof method !== 'string' || !method) throw new Error();
      message = JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})});
    } catch (error) {
      return Promise.reject(error.code ? error : failure('CDP_MESSAGE_INVALID', '浏览器命令格式无效。'));
    }
    const connection = this.#connection;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(failure('CDP_COMMAND_TIMEOUT', '等待 Chrome 命令响应超时。'));
      }, timeoutMs);
      this.#pending.set(id, {resolve, reject, timer, sessionId});
      try { connection.socket.send(message); } catch {
        this.#terminate(connection, failure('CDP_CONNECTION_FAILED', 'Chrome 调试命令发送失败。'));
      }
    });
  }

  async pageCommand(targetId, method, params = {}) {
    if (typeof targetId !== 'string' || !targetId) {
      throw failure('CDP_TARGET_INVALID', '浏览器标签页标识无效。');
    }
    let sessionId = this.#sessions.get(targetId);
    if (!sessionId) {
      let attaching = this.#attaching.get(targetId);
      if (!attaching) {
        const connection = this.#connection;
        attaching = this.call('Target.attachToTarget', {targetId, flatten: true}).then(result => {
          if (this.#connection !== connection || !this.connected) {
            throw failure('CDP_DISCONNECTED', 'Chrome 调试连接已断开。');
          }
          if (typeof result.sessionId !== 'string' || !result.sessionId) {
            throw failure('CDP_RESPONSE_INVALID', 'Chrome 未返回标签页调试会话。');
          }
          this.#sessions.set(targetId, result.sessionId);
          return result.sessionId;
        }).finally(() => {
          if (this.#attaching.get(targetId) === attaching) this.#attaching.delete(targetId);
        });
        this.#attaching.set(targetId, attaching);
      }
      sessionId = await attaching;
    }
    return this.call(method, params, sessionId);
  }

  async targets() {
    const {targetInfos} = await this.call('Target.getTargets');
    if (!Array.isArray(targetInfos)) throw failure('CDP_RESPONSE_INVALID', 'Chrome 未返回标签页列表。');
    return targetInfos.map(info => ({...info, id: info.targetId}));
  }

  async createTarget(url) {
    const {targetId} = await this.call('Target.createTarget', {url});
    if (!targetId) throw failure('CDP_RESPONSE_INVALID', 'Chrome 未返回新标签页标识。');
    const {targetInfo} = await this.call('Target.getTargetInfo', {targetId});
    return {...targetInfo, targetId, id: targetId};
  }

  disconnect() {
    if (this.#connection) this.#terminate(this.#connection,
      failure('CDP_DISCONNECTED', 'Chrome 调试连接已断开。'));
  }

  #receive(connection, data) {
    let message;
    try {
      message = JSON.parse(data);
      if (!message || typeof message !== 'object') throw new Error();
    } catch {
      this.#terminate(connection, failure('CDP_RESPONSE_INVALID', 'Chrome 返回了无效的调试响应。'));
      return;
    }
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(failure('CDP_ERROR', message.error.message || 'Chrome 命令执行失败。', {cdpCode: message.error.code}));
      } else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method === 'Target.detachedFromTarget' || message.method === 'Target.targetDestroyed') {
      const {sessionId, targetId} = message.params ?? {};
      for (const [target, session] of this.#sessions) {
        if (session === sessionId || target === targetId) {
          this.#sessions.delete(target);
          for (const [id, pending] of this.#pending) {
            if (pending.sessionId !== session) continue;
            this.#pending.delete(id);
            clearTimeout(pending.timer);
            pending.reject(failure('CDP_SESSION_DETACHED', 'Chrome 标签页调试会话已结束。'));
          }
        }
      }
    }
  }

  #terminate(connection, error) {
    if (this.#connection !== connection) return;
    this.#connection = null;
    clearTimeout(connection.timer);
    connection.reject?.(error);
    connection.resolve = connection.reject = null;
    this.#sessions.clear();
    this.#attaching.clear();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    // Never send Browser.close: disconnecting must keep the user's browser open.
    if (connection.socket.readyState < 2) {
      try { connection.socket.close(); } catch { /* Already closing. */ }
    }
  }
}
