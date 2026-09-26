#!/usr/bin/env node
// Diagnóstico del entorno: IA (GPT-6 Luna por OAuth), skills, MCP (Playwright, Chrome DevTools, Figma),
// búsqueda, hosting/DNS, email y datos del mapa. Imprime HERRAMIENTA | ESTADO | VERSIÓN | FUENTE | PROBLEMAS.
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { loadDotEnv, buildConfig } from '../src/config.js';
import { FileStore } from '../src/lib/store.js';
import { createAI } from '../src/ai/index.js';
import { McpOAuth } from '../src/ai/mcp-oauth.js';

loadDotEnv();
const config = buildConfig();
const require = createRequire(import.meta.url);
const store = new FileStore(config.dataDir, { secretKey: config.secretKey });
const ai = createAI({ config, store });
const rows = [];
const add = (tool, ok, version, source, problems = '') => rows.push({ HERRAMIENTA: tool, ESTADO: ok === null ? '— omitido' : ok ? '✓ OK' : '✗ FALLA', VERSIÓN: version || '—', FUENTE: source, PROBLEMAS: problems || '' });
const pkgVersion = (name) => {
  try {
    return require(`${name}/package.json`).version;
  } catch {
    return null;
  }
};

// Node y dependencias
add('Node.js', Number(process.versions.node.split('.')[0]) >= 20, process.versions.node, 'nodejs.org', Number(process.versions.node.split('.')[0]) >= 20 ? '' : 'Se requiere Node 20+');
for (const dep of ['cheerio', 'nodemailer']) add(dep, Boolean(pkgVersion(dep)), pkgVersion(dep), 'npm', pkgVersion(dep) ? '' : 'Ejecuta npm install');

// GPT-6 Luna
for (const role of ['research', 'generation']) {
  const r = ai[role];
  if (r.provider === 'mock') {
    add(`IA (${role})`, true, r.model, 'mock', 'Modo demo: configura AI_* = openai:gpt-6-luna para producción');
    continue;
  }
  try {
    const models = await r.client.listModels();
    const found = models.includes(r.model);
    add(`IA (${role}) ${r.model}`, found, r.model, `${config.ai.openai.baseUrl} · auth ${config.ai.openai.auth}`, found ? '' : `El proveedor no lista "${r.model}". Modelos: ${models.slice(0, 8).join(', ')}`);
  } catch (err) {
    add(`IA (${role}) ${r.model}`, false, r.model, `${config.ai.openai.baseUrl} · auth ${config.ai.openai.auth}`, err.message.slice(0, 160));
  }
}

// Skills
const lock = JSON.parse(fs.readFileSync('skills/vendor.lock.json', 'utf8'));
const local = ai.skills.skills.filter((s) => s.origin === 'local').length;
add('Skills propias (plataforma)', local >= 20, `${local} skills`, 'skills/*/SKILL.md');
for (const [id, src] of Object.entries(lock.sources)) {
  const names = lock.skills.filter((s) => s.source === id).map((s) => s.name);
  const missing = names.filter((n) => (ai.skills.vendorMissing || []).includes(n));
  add(`Skills ${id}`, missing.length === 0, `${src.commit.slice(0, 7)} (${names.length})`, `github.com/${src.repo}`, missing.length ? `Faltan ${missing.length}: npm run skills:sync` : src.license.startsWith('Sin') || !src.licenseFile ? `Licencia: ${src.license}` : '');
}

// MCP: arranque, herramientas y prueba funcional con una página local
const page = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><title>doctor</title><h1 style="color:rgb(10, 20, 30)">ok</h1>');
});
await new Promise((r) => page.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${page.address().port}/`;
ai.mcp.allowOrigins.push(new URL(url).origin);
const status = await ai.mcp.status();
for (const [name, st] of Object.entries(status)) {
  const src = { playwright: 'npm @playwright/mcp (Microsoft)', 'chrome-devtools': 'npm chrome-devtools-mcp (Google)', figma: 'mcp.figma.com (Figma)' }[name] || name;
  if (!st.enabled) {
    const hint = name === 'figma' ? 'Requiere iniciar sesión: arranca el servidor y abre /auth/figma/start' : 'Desactivado por configuración';
    add(`MCP ${name}`, name === 'figma' ? false : null, '—', src, hint);
    continue;
  }
  if (!st.ok) {
    add(`MCP ${name}`, false, '—', src, st.error.slice(0, 160));
    continue;
  }
  let test = '';
  try {
    if (name === 'playwright') {
      await ai.mcp.call('playwright__browser_navigate', { url });
      const ev = await ai.mcp.call('playwright__browser_evaluate', { function: "() => getComputedStyle(document.querySelector('h1')).color" });
      const shot = await ai.mcp.call('playwright__browser_take_screenshot', { type: 'png' });
      test = ev.text.includes('rgb(10, 20, 30)') && shot.images.length ? 'prueba: navegar + estilos + captura ✓' : 'prueba fallida';
    } else if (name === 'chrome-devtools') {
      await ai.mcp.call('chrome-devtools__navigate_page', { pageId: 1, type: 'url', url });
      const c = await ai.mcp.call('chrome-devtools__list_console_messages', { pageId: 1 });
      test = c.text.startsWith('ERROR') ? `prueba fallida: ${c.text.slice(0, 80)}` : 'prueba: navegar + consola ✓';
    }
  } catch (err) {
    test = `prueba fallida: ${err.message.slice(0, 100)}`;
  }
  add(`MCP ${name}`, !/fallida/.test(test), `${st.server?.version || '?'} · ${st.tools.length} herramientas`, src, test);
}
const figma = new McpOAuth('figma', { resourceUrl: config.mcp.servers.figma.url, redirectUri: `${config.publicUrl}/auth/figma/callback`, store });
if (figma.connected()) rows.find((r) => r.HERRAMIENTA === 'MCP figma').PROBLEMAS = 'Cuenta conectada (se activa al arrancar el servidor)';
page.close();

// Búsqueda, hosting, DNS, email, mapa
const key = { brave: config.research.braveApiKey, serpapi: config.research.serpapiKey, tavily: config.research.tavilyApiKey, fixture: 'demo' }[config.research.searchProvider];
add(`Búsqueda (${config.research.searchProvider})`, Boolean(key), '—', config.research.searchProvider, key ? (config.research.searchProvider === 'fixture' ? 'Modo demo: referencias sintéticas' : '') : 'Falta la clave de API');
if (config.deploy.hosting === 'netlify') {
  try {
    const res = await fetch('https://api.netlify.com/api/v1/user', { headers: { authorization: `Bearer ${config.deploy.netlifyToken}` } });
    add('Hosting Netlify', res.ok, '—', 'api.netlify.com', res.ok ? '' : `HTTP ${res.status}`);
  } catch (err) {
    add('Hosting Netlify', false, '—', 'api.netlify.com', err.message);
  }
} else add('Hosting', true, 'local', 'data/published', 'Modo desarrollo: HOSTING_PROVIDER=netlify para producción');
if (config.deploy.dns === 'cloudflare') {
  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers: { authorization: `Bearer ${config.deploy.cloudflareToken}` } });
    add('DNS Cloudflare', res.ok, '—', 'api.cloudflare.com', res.ok ? '' : `HTTP ${res.status}`);
  } catch (err) {
    add('DNS Cloudflare', false, '—', 'api.cloudflare.com', err.message);
  }
} else add(`DNS (${config.deploy.dns})`, true, '—', config.deploy.dns, config.deploy.dns === 'manual' ? 'Se darán instrucciones DNS al usuario' : '');
const mailOk = config.mail.dryRun || (config.mail.provider === 'smtp' ? Boolean(config.mail.smtpUrl) : config.mail.provider === 'resend' ? Boolean(config.mail.resendApiKey) : true);
add(`Email (${config.mail.dryRun ? 'simulación' : config.mail.provider})`, mailOk, '—', config.mail.provider, config.mail.dryRun ? 'MAIL_DRY_RUN=true: no se envía nada' : mailOk ? '' : 'Faltan credenciales');
add(`Mapa (${config.leads.placesProvider})`, true, '—', config.leads.placesProvider === 'overpass' ? 'OpenStreetMap / Overpass' : 'datos de demo', config.leads.placesProvider === 'fixture' ? 'Modo demo: negocios ficticios' : '');

ai.mcp.closeAll();
console.table(rows);
const failing = rows.filter((r) => r.ESTADO.includes('FALLA'));
console.log(failing.length ? `\nFALTA ESTO:\n${failing.map((r) => `  • ${r.HERRAMIENTA}: ${r.PROBLEMAS}`).join('\n')}` : '\nTODO LISTO');
process.exit(0);
