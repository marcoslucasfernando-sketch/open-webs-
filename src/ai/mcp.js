import { spawn } from 'node:child_process';
import { assertPublicUrl } from '../research/scraper.js';

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'open-webs', version: '0.1.0' };

// Cliente MCP mínimo (JSON-RPC 2.0) con transporte stdio (servidores locales vía npx) y Streamable HTTP (remotos).
export class McpClient {
  constructor(name, spec, { timeoutMs = 90_000, fetch = globalThis.fetch } = {}) {
    this.name = name;
    this.spec = spec;
    this.timeoutMs = timeoutMs;
    this.fetch = fetch;
    this.nextId = 1;
    this.pending = new Map();
    this.ready = null;
    this.serverInfo = null;
  }

  start() {
    this.ready ??= this.#init().catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  async #init() {
    if (this.spec.url) this.transport = 'http';
    else {
      this.transport = 'stdio';
      this.proc = spawn(this.spec.command, this.spec.args || [], {
        env: { ...process.env, ...(this.spec.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.stderr = '';
      this.proc.stderr.on('data', (d) => (this.stderr = (this.stderr + d).slice(-4000)));
      let buf = '';
      this.proc.stdout.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) this.#onMessage(line);
        }
      });
      this.proc.on('exit', (code) => {
        for (const { reject } of this.pending.values()) reject(new Error(`MCP ${this.name} terminó (código ${code}). ${this.stderr.slice(-500)}`));
        this.pending.clear();
        this.ready = null;
      });
    }
    const init = await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
    this.serverInfo = init.serverInfo;
    await this.notify('notifications/initialized');
    return init;
  }

  #onMessage(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`MCP ${this.name}: ${msg.error.message}`));
      else resolve(msg.result);
    }
  }

  async request(method, params) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    if (this.transport === 'http') return this.#httpSend(payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.name}: timeout en ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  async notify(method, params) {
    const payload = { jsonrpc: '2.0', method, ...(params ? { params } : {}) };
    if (this.transport === 'http') await this.#httpSend(payload, true);
    else this.proc.stdin.write(JSON.stringify(payload) + '\n');
  }

  async #httpSend(payload, isNotification = false) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
    };
    const token = typeof this.spec.token === 'function' ? await this.spec.token() : this.spec.token;
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await this.fetch(this.spec.url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(this.timeoutMs) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (res.status === 401) throw new Error(`MCP ${this.name}: no autorizado (401). Conecta la cuenta con OAuth.`);
    if (!res.ok && res.status !== 202) throw new Error(`MCP ${this.name}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    if (isNotification || res.status === 202) return null;
    const type = res.headers.get('content-type') || '';
    const text = await res.text();
    const messages = type.includes('text/event-stream')
      ? text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5).trim()))
      : [JSON.parse(text)];
    const msg = messages.find((m) => m.id === payload.id);
    if (!msg) throw new Error(`MCP ${this.name}: respuesta sin id ${payload.id}`);
    if (msg.error) throw new Error(`MCP ${this.name}: ${msg.error.message}`);
    return msg.result;
  }

  async listTools() {
    await this.start();
    const out = [];
    let cursor;
    do {
      const res = await this.request('tools/list', cursor ? { cursor } : {});
      out.push(...(res.tools || []));
      cursor = res.nextCursor;
    } while (cursor);
    return out;
  }

  async callTool(name, args = {}) {
    await this.start();
    return this.request('tools/call', { name, arguments: args });
  }

  close() {
    if (this.proc && !this.proc.killed) this.proc.kill();
    this.ready = null;
  }
}

// Gestor de servidores MCP configurados. Expone sus herramientas a GPT-6 Luna como funciones (function calling),
// filtradas por lista blanca y con validación de URLs (SSRF).
export class McpManager {
  constructor(servers = {}, { allowOrigins = [], fetch } = {}) {
    this.specs = servers;
    this.clients = new Map();
    this.allowOrigins = allowOrigins; // orígenes privados permitidos (p. ej. la vista previa de la plataforma)
    this.fetch = fetch;
  }

  has(name) {
    return Boolean(this.specs[name] && this.specs[name].enabled !== false);
  }

  client(name) {
    if (!this.has(name)) throw new Error(`Servidor MCP no configurado: ${name}`);
    if (!this.clients.has(name)) this.clients.set(name, new McpClient(name, this.specs[name], { fetch: this.fetch }));
    return this.clients.get(name);
  }

  async status() {
    const out = {};
    for (const name of Object.keys(this.specs)) {
      if (!this.has(name)) {
        out[name] = { enabled: false };
        continue;
      }
      try {
        const tools = await this.client(name).listTools();
        out[name] = { enabled: true, ok: true, server: this.client(name).serverInfo, tools: tools.map((t) => t.name) };
      } catch (err) {
        out[name] = { enabled: true, ok: false, error: err.message };
      }
    }
    return out;
  }

  // Definiciones OpenAI de las herramientas permitidas para una tarea: { server: [tool, ...] }.
  async functionDefs(allow) {
    const defs = [];
    for (const [server, names] of Object.entries(allow)) {
      if (!this.has(server)) continue;
      let tools;
      try {
        tools = await this.client(server).listTools();
      } catch {
        continue; // si un MCP no arranca, la tarea continúa sin sus herramientas
      }
      for (const t of tools) {
        if (names !== '*' && !names.includes(t.name)) continue;
        defs.push({
          type: 'function',
          function: {
            name: `${server}__${t.name}`.slice(0, 64),
            description: (t.description || '').slice(0, 1000),
            parameters: t.inputSchema || { type: 'object', properties: {} },
          },
        });
      }
    }
    return defs;
  }

  // Ejecuta una llamada de herramienta "server__tool". Devuelve { text, images: [dataUrl] }.
  async call(fnName, args) {
    const i = fnName.indexOf('__');
    const server = fnName.slice(0, i);
    const tool = fnName.slice(i + 2);
    await this.#checkUrls(args);
    const res = await this.client(server).callTool(tool, args);
    const texts = [];
    const images = [];
    for (const c of res.content || []) {
      if (c.type === 'text') texts.push(c.text);
      else if (c.type === 'image') images.push(`data:${c.mimeType};base64,${c.data}`);
      else if (c.type === 'resource' && c.resource?.text) texts.push(c.resource.text);
    }
    const text = texts.join('\n').slice(0, 30_000);
    return { text: res.isError ? `ERROR: ${text}` : text, images, raw: res };
  }

  async #checkUrls(args) {
    for (const value of Object.values(args || {})) {
      if (typeof value !== 'string' || !/^[a-z]+:\/\//i.test(value)) continue;
      const origin = new URL(value).origin;
      if (this.allowOrigins.includes(origin)) continue;
      await assertPublicUrl(value);
    }
  }

  closeAll() {
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
  }
}

// Configuración por defecto de los MCP oficiales, adaptada a servidor (headless, perfil aislado, Chromium local).
export function defaultMcpServers(env = process.env) {
  const chromium = env.CHROMIUM_PATH || (env.PLAYWRIGHT_BROWSERS_PATH ? `${env.PLAYWRIGHT_BROWSERS_PATH}/chromium` : '');
  const off = (v) => /^(0|false|no|off)$/i.test(v || '');
  const on = (v) => /^(1|true|yes|on)$/i.test(v || '');
  // Solo para entornos con proxy que inspecciona TLS (p. ej. sandboxes); en producción no se usan.
  const proxy = env.BROWSER_PROXY || '';
  const insecure = on(env.BROWSER_IGNORE_HTTPS_ERRORS);
  const outputDir = env.MCP_OUTPUT_DIR || `${env.DATA_DIR || 'data'}/mcp-output`;
  const servers = {
    playwright: {
      enabled: !off(env.MCP_PLAYWRIGHT),
      command: 'npx',
      args: [
        '-y', `@playwright/mcp@${env.PLAYWRIGHT_MCP_VERSION || '0.0.82'}`,
        '--headless', '--isolated', '--browser', 'chromium', '--no-sandbox', '--viewport-size', '1440x900',
        '--image-responses', 'allow', '--output-dir', outputDir,
        ...(chromium ? ['--executable-path', chromium] : []),
        ...(proxy ? ['--proxy-server', proxy, '--proxy-bypass', '127.0.0.1,localhost'] : []),
        ...(insecure ? ['--ignore-https-errors'] : []),
      ],
    },
    'chrome-devtools': {
      enabled: !off(env.MCP_CHROME_DEVTOOLS),
      command: 'npx',
      args: [
        '-y', `chrome-devtools-mcp@${env.CHROME_DEVTOOLS_MCP_VERSION || '1.10.1'}`,
        '--headless', '--isolated', '--usageStatistics=false', '--chromeArg=--no-sandbox',
        ...(chromium ? ['--executablePath', chromium] : []),
        ...(proxy ? [`--chromeArg=--proxy-server=${proxy}`, '--chromeArg=--proxy-bypass-list=127.0.0.1;localhost'] : []),
        ...(insecure ? ['--chromeArg=--ignore-certificate-errors'] : []),
      ],
      env: { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' },
    },
  };
  // Figma MCP remoto (oficial). Se activa cuando el operador conecta su cuenta en el panel (OAuth, ver mcp-oauth.js);
  // el servidor sustituye "token" por una función que devuelve el access token vigente.
  servers.figma = {
    enabled: !off(env.MCP_FIGMA) && Boolean(env.FIGMA_MCP_TOKEN),
    oauth: true,
    url: env.FIGMA_MCP_URL || 'https://mcp.figma.com/mcp',
    token: env.FIGMA_MCP_TOKEN || '',
  };
  return servers;
}
