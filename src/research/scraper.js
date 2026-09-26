import dns from 'node:dns/promises';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/references');
const MAX_BYTES = 2_000_000;

// Bloquea destinos privados/locales (protección SSRF): las URLs vienen de buscadores y de OpenStreetMap.
export async function assertPublicUrl(url) {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`Protocolo no permitido: ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  for (const { address } of addrs) if (isPrivateIp(address)) throw new Error(`Destino no público bloqueado: ${host}`);
}

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

export class Scraper {
  constructor({ userAgent, timeoutMs = 15_000, respectRobots = true, fetch = globalThis.fetch, allowPrivate = false }) {
    this.ua = userAgent;
    this.timeoutMs = timeoutMs;
    this.respectRobots = respectRobots;
    this.fetch = fetch;
    this.allowPrivate = allowPrivate;
    this.robotsCache = new Map();
  }

  async get(url, { accept = 'text/html,application/xhtml+xml' } = {}) {
    if (url.startsWith('fixture://')) return readFixture(url);
    if (!this.allowPrivate) await assertPublicUrl(url);
    if (this.respectRobots && !(await this.#allowed(url))) throw new Error(`robots.txt no permite rastrear ${url}`);
    const res = await this.fetch(url, {
      headers: { 'user-agent': this.ua, accept, 'accept-language': 'es-ES,es;q=0.9,en;q=0.5' },
      redirect: 'follow',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_BYTES) throw new Error(`Respuesta demasiado grande (${len} bytes)`);
    const body = await res.text();
    return { url: res.url || url, status: res.status, body: body.slice(0, MAX_BYTES), contentType: res.headers.get('content-type') || '' };
  }

  async #allowed(url) {
    const u = new URL(url);
    const key = u.origin;
    if (!this.robotsCache.has(key)) {
      let rules = [];
      try {
        const res = await this.fetch(`${key}/robots.txt`, { headers: { 'user-agent': this.ua }, signal: AbortSignal.timeout(5000) });
        if (res.ok) rules = parseRobots(await res.text());
      } catch {}
      this.robotsCache.set(key, rules);
    }
    return isAllowed(this.robotsCache.get(key), u.pathname + u.search);
  }
}

// Parser mínimo de robots.txt: reglas del grupo "*" (Allow/Disallow, con prioridad por longitud).
export function parseRobots(txt) {
  const rules = [];
  let applies = false;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) applies = false;
      if (value === '*' || /openwebs/i.test(value)) applies = true;
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (applies && (key === 'allow' || key === 'disallow') && value) rules.push({ allow: key === 'allow', path: value });
  }
  return rules;
}

export function isAllowed(rules, pathname) {
  let best = null;
  for (const r of rules) {
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(pathname) && (!best || r.path.length > best.path.length)) best = r;
  }
  return !best || best.allow;
}

// Referencias sintéticas para modo demo/tests: plantillas con {{sector}}, {{city}}, {{name}}.
function readFixture(url) {
  const u = new URL(url);
  const file = path.join(FIXTURES, `${u.hostname}.html`);
  if (!fs.existsSync(file)) throw new Error(`Fixture inexistente: ${u.hostname}`);
  const vars = Object.fromEntries(u.searchParams);
  const body = fs.readFileSync(file, 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
  return { url, status: 200, body, contentType: 'text/html' };
}

export function listFixtureIds() {
  return fs.existsSync(FIXTURES) ? fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, '')).sort() : [];
}
