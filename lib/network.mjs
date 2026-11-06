import http from 'node:http';
import {execFileSync} from 'node:child_process';

const loopback = ['localhost', '127.0.0.1', '::1'];
const invalidProxy = '代理配置无效或使用了不支持的协议；仅支持 HTTP/HTTPS 代理。';

function proxyAddress(value) {
  const address = String(value).trim();
  const normalized = /^[a-z][a-z\d+.-]*:\/\//i.test(address) ? address : `http://${address}`;
  let url;
  try { url = new URL(normalized); } catch { throw new Error(invalidProxy); }
  if (!address || !['http:', 'https:'].includes(url.protocol) || !url.hostname ||
      url.pathname !== '/' || url.search || url.hash) throw new Error(invalidProxy);
  return normalized;
}

// In Windows' per-protocol form, "https=" describes the destination protocol,
// not TLS to the proxy: a bare proxy address still uses HTTP CONNECT.
export function parseWindowsProxy(value) {
  const input = String(value ?? '').trim();
  if (!input) return {};
  if (!/^[a-z][a-z\d+.-]*\s*=/i.test(input)) {
    const address = proxyAddress(input);
    return {httpProxy: address, httpsProxy: address};
  }
  const result = {};
  for (const entry of input.split(';')) {
    if (!entry.trim()) continue;
    const match = entry.trim().match(/^([a-z][a-z\d+.-]*)\s*=\s*(.+)$/i);
    if (!match) throw new Error(invalidProxy);
    const protocol = match[1].toLowerCase();
    if (protocol === 'http' || protocol === 'https') {
      result[`${protocol}Proxy`] = proxyAddress(match[2]);
    }
  }
  if (!result.httpProxy && !result.httpsProxy) throw new Error(invalidProxy);
  return result;
}

function readSystemProxy() {
  const output = execFileSync('reg.exe', [
    'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
  ], {encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe']});
  return {
    enabled: /^\s*ProxyEnable\s+REG_DWORD\s+(?:0x0*1|1)\s*$/im.test(output),
    server: output.match(/^\s*ProxyServer\s+REG_SZ\s+(.+)$/im)?.[1]?.trim() ?? '',
  };
}

// Only the current process' HTTP/fetch agents are configured. The registry and
// caller's environment are never modified. Dependencies are injectable offline.
export function configureNetwork({
  env = process.env,
  platform = process.platform,
  readWindowsProxy = readSystemProxy,
  applyProxy = http.setGlobalProxyFromEnv,
} = {}) {
  let source = 'none';
  try {
    const proxyEnv = {...env};
    const httpProxy = env.http_proxy || env.HTTP_PROXY;
    const httpsProxy = env.https_proxy || env.HTTPS_PROXY;
    if (httpProxy || httpsProxy) {
      source = 'environment';
      if (httpProxy) proxyEnv.http_proxy = proxyAddress(httpProxy);
      if (httpsProxy) proxyEnv.https_proxy = proxyAddress(httpsProxy);
    } else {
      if (platform !== 'win32') return {configured: false, source};
      const settings = readWindowsProxy();
      if (!settings?.enabled || !String(settings.server ?? '').trim()) {
        return {configured: false, source};
      }
      source = 'windows';
      const parsed = parseWindowsProxy(settings.server);
      if (parsed.httpProxy) proxyEnv.HTTP_PROXY = parsed.httpProxy;
      if (parsed.httpsProxy) proxyEnv.HTTPS_PROXY = parsed.httpsProxy;
    }
    const bypass = [...new Set([
      ...String(env.NO_PROXY ?? '').split(','),
      ...String(env.no_proxy ?? '').split(','),
      ...loopback,
    ].map(value => value.trim()).filter(Boolean))].join(',');
    proxyEnv.NO_PROXY = bypass;
    proxyEnv.no_proxy = bypass;
    if (typeof applyProxy !== 'function') {
      return {configured: false, source, warning: '当前 Node.js 不支持代理配置，请使用随附的运行时。'};
    }
    applyProxy(proxyEnv);
    return {configured: true, source};
  } catch {
    // Never expose a proxy URL or an exception that may contain credentials.
    return {configured: false, source, warning: '未能启用代理，请检查系统或环境变量中的 HTTP/HTTPS 代理配置。'};
  }
}
