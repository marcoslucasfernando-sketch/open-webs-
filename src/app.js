import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FileStore } from './lib/store.js';
import { JobRunner } from './lib/jobs.js';
import { newId, normalizeDomain, escapeHtml } from './lib/util.js';
import { SECTORS, resolveSector } from './lib/sectors.js';
import { createAI } from './ai/index.js';
import { McpOAuth } from './ai/mcp-oauth.js';
import { createSearch } from './research/search.js';
import { Scraper } from './research/scraper.js';
import { ResearchService } from './research/pipeline.js';
import { GeneratorService, normalizeSpec } from './generator/pipeline.js';
import { countPlaceholders } from './generator/render.js';
import { BrandCollector } from './media/brand.js';
import { createHosting } from './deploy/hosting.js';
import { createDns, domainAvailability } from './deploy/dns.js';
import { DeployService } from './deploy/pipeline.js';
import { PlacesService, enrichPlace } from './leads/places.js';
import { createMailer } from './leads/mailer.js';
import { OutreachService } from './leads/outreach.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
};

// Construye todos los servicios de la plataforma (inyectables para tests).
export function createServices(config, { fetch = globalThis.fetch, resolver } = {}) {
  const store = new FileStore(config.dataDir, { secretKey: config.secretKey });
  for (const c of ['leads', 'campaigns', 'suppression', 'jobs', 'assets']) fs.mkdirSync(path.join(config.dataDir, c), { recursive: true });
  const ai = createAI({ config, store, fetch });
  const figma = new McpOAuth('figma', { resourceUrl: config.mcp.servers.figma.url, redirectUri: `${config.publicUrl}/auth/figma/callback`, store, fetch });
  if (figma.connected() && config.mcp.servers.figma) {
    Object.assign(config.mcp.servers.figma, { enabled: true, token: () => figma.token() });
  }
  const scraper = new Scraper({ ...config.research, fetch });
  const research = new ResearchService({ config, store, ai, search: createSearch(config.research, { fetch }), scraper });
  const brand = new BrandCollector({ mcp: ai.mcp, scraper, fetch });
  const generator = new GeneratorService({ config, store, ai, research, brand });
  const hosting = createHosting(config, { fetch });
  const deployer = new DeployService({ config, store, hosting, dns: createDns(config, { hosting, fetch }), generator, fetch, resolver });
  const places = new PlacesService({ config, fetch });
  const mailer = createMailer(config.mail, { dataDir: config.dataDir, fetch });
  const outreach = new OutreachService({ config, store, ai, generator, hosting, mailer, mcp: ai.mcp });
  const jobs = new JobRunner({ store });
  return { config, store, ai, figma, scraper, research, generator, hosting, deployer, places, outreach, mailer, jobs };
}

export function createApp(services) {
  const { config, store, ai, figma, research, generator, deployer, places, outreach, jobs, scraper } = services;
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ method, re, keys, handler });
  };

  const getProject = (id) => {
    const p = store.get('projects', id);
    if (!p) throw httpError(404, 'Proyecto no encontrado');
    return p;
  };

  // ---------------- Estado ----------------
  route('GET', '/api/status', () => ({
    ai: { research: config.ai.research, generation: config.ai.generation, auth: config.ai.openai.auth, oauth: ai.oauth.status(), skillsMode: ai.skills.mode },
    skills: { total: ai.skills.skills.length, vendorMissing: ai.skills.vendorMissing || [] },
    mcp: Object.fromEntries(Object.entries(config.mcp.servers).map(([k, v]) => [k, { enabled: ai.mcp.has(k) }])),
    figma: { connected: figma.connected() },
    research: { searchProvider: config.research.searchProvider, minReferences: config.research.minReferences },
    deploy: { hosting: services.hosting.name, dns: config.deploy.dns },
    leads: { placesProvider: config.leads.placesProvider, region: config.leads.region, bbox: config.leads.bbox, tileUrl: config.leads.tileUrl, tileAttribution: config.leads.tileAttribution },
    mail: { provider: services.mailer.provider, dryRun: services.mailer.dryRun, dailyLimit: config.mail.dailyLimit },
  }));
  route('GET', '/api/skills', () => ai.skills.list());
  route('GET', '/api/mcp/status', () => ai.mcp.status());
  route('GET', '/api/sectors', () => ({
    catalog: SECTORS.map(({ id, label }) => ({ id, label })),
    researched: store.list('sectors').map((s) => ({ id: s.id, sector: s.sector, location: s.location, references: s.references.length, createdAt: s.createdAt })),
  }));
  route('GET', '/api/sectors/:id', ({ params }) => {
    const s = store.get('sectors', params.id);
    if (!s) throw httpError(404, 'Sector no investigado');
    return s;
  });
  route('POST', '/api/sectors/research', ({ body }) => {
    const job = jobs.start('research', { sector: body.sector }, (log) => research.research({ sector: body.sector, location: body.location, force: Boolean(body.force) }, log).then((r) => ({ sectorKey: r.id })));
    return { jobId: job.id };
  });
  route('GET', '/api/jobs/:id', ({ params }) => jobs.get(params.id) || Promise.reject(httpError(404, 'Trabajo no encontrado')));

  // ---------------- Proyectos (flujo principal) ----------------
  route('GET', '/api/projects', () =>
    store.list('projects').filter((p) => p.kind !== 'demo').map((p) => ({ id: p.id, name: p.input.name, sector: p.input.sector, status: p.status, createdAt: p.createdAt, deploy: p.deploy && { status: p.deploy.status, domain: p.deploy.domain, liveUrl: p.deploy.liveUrl } })),
  );
  route('POST', '/api/projects', ({ body }) => {
    const input = validateInput(body);
    const project = { id: newId('p'), kind: 'site', createdAt: new Date().toISOString(), status: 'generating', input };
    store.put('projects', project.id, project);
    const job = jobs.start('generate', { projectId: project.id }, async (log) => {
      try {
        const result = await generator.generate(project, log);
        store.put('projects', project.id, { ...store.get('projects', project.id), status: 'review', result });
        return { projectId: project.id, previewUrl: generator.previewUrl(project.id) };
      } catch (err) {
        store.put('projects', project.id, { ...store.get('projects', project.id), status: 'error', error: err.message });
        throw err;
      }
    });
    store.put('projects', project.id, { ...project, jobId: job.id });
    return { projectId: project.id, jobId: job.id };
  });
  route('GET', '/api/projects/:id', ({ params }) => {
    const p = getProject(params.id);
    return { ...p, previewUrl: generator.previewUrl(p.id), placeholders: p.result ? countPlaceholders(p.result.spec) : null };
  });
  route('GET', '/api/projects/:id/research', ({ params }) => {
    const p = getProject(params.id);
    const s = p.result && store.get('sectors', p.result.sectorKey);
    if (!s) throw httpError(404, 'Investigación no disponible');
    return { ...s, references: s.references.map(({ textSample, ...r }) => r) };
  });
  // Edición: textos (spec) y tokens de diseño; se vuelve a renderizar la vista previa.
  route('PUT', '/api/projects/:id/spec', ({ params, body }) => {
    const p = getProject(params.id);
    if (!p.result) throw httpError(409, 'El proyecto aún no se ha generado');
    if (body.spec) p.result.spec = { ...normalizeSpec(body.spec, p.input), media: p.result.spec.media };
    if (body.tokens) p.result.design.tokens = { ...p.result.design.tokens, ...pick(body.tokens, ['primary', 'accent', 'bg', 'surface', 'text', 'muted', 'headingFont', 'bodyFont', 'radius']) };
    if (body.heroVariant) p.result.design.heroVariant = String(body.heroVariant);
    p.result.editedAt = new Date().toISOString();
    p.status = 'review';
    store.put('projects', p.id, p);
    generator.renderPreview(p.id, p.result);
    return { ok: true, placeholders: countPlaceholders(p.result.spec) };
  });
  route('POST', '/api/projects/:id/approve', ({ params }) => {
    const p = getProject(params.id);
    if (!p.result) throw httpError(409, 'El proyecto aún no se ha generado');
    p.status = 'approved';
    p.approvedAt = new Date().toISOString();
    store.put('projects', p.id, p);
    return { ok: true, placeholders: countPlaceholders(p.result.spec) };
  });
  route('GET', '/api/domains/check', async ({ query }) => domainAvailability(normalizeDomain(query.domain)));
  route('POST', '/api/projects/:id/deploy', ({ params, body }) => {
    const p = getProject(params.id);
    if (p.status !== 'approved' && !['live', 'waiting_dns', 'verification_timeout', 'deploy_error'].includes(p.deploy?.status)) {
      throw httpError(409, 'Aprueba la web antes de publicarla');
    }
    const domain = normalizeDomain(body.domain);
    const job = jobs.start('deploy', { projectId: p.id, domain }, async (log) => {
      let state;
      try {
        state = await deployer.publish(store.get('projects', p.id), { domain, force: Boolean(body.force) }, log);
      } catch (err) {
        store.put('projects', p.id, { ...store.get('projects', p.id), deploy: { domain, status: 'deploy_error', error: err.message } });
        throw err;
      }
      const save = (s) => store.put('projects', p.id, { ...store.get('projects', p.id), status: s.status === 'live' || s.status === 'published' ? 'live' : 'deploying', deploy: s });
      save(state);
      if (state.status === 'waiting_dns') {
        log('Esperando a que el DNS apunte al hosting (se comprueba periódicamente)…');
        state = await deployer.waitUntilLive(state, log);
        save(state);
      }
      return state;
    });
    return { jobId: job.id };
  });
  route('POST', '/api/projects/:id/verify', ({ params }) => {
    const p = getProject(params.id);
    if (!p.deploy?.buildId) throw httpError(409, 'Nada que verificar');
    const job = jobs.start('verify', { projectId: p.id }, async (log) => {
      const state = await deployer.waitUntilLive({ ...p.deploy }, log, { timeoutMs: 60_000, intervalMs: 10_000 });
      store.put('projects', p.id, { ...store.get('projects', p.id), status: state.status === 'live' ? 'live' : p.status, deploy: state });
      return state;
    });
    return { jobId: job.id };
  });

  // ---------------- Prospección (mapa de Gran Canaria) ----------------
  route('GET', '/api/leads', () => outreach.listLeads());
  route('POST', '/api/leads/search', ({ body }) => {
    const job = jobs.start('leads-search', {}, async (log) => {
      log(`Buscando negocios en ${config.leads.region} (${config.leads.placesProvider})`);
      const found = await places.search({ sectorIds: body.sectorIds || [] });
      outreach.saveLeads(found);
      log(`${found.length} negocios encontrados`);
      return { count: found.length };
    });
    return { jobId: job.id };
  });
  route('POST', '/api/leads/enrich', ({ body }) => {
    const ids = (body.ids || []).slice(0, 200);
    const job = jobs.start('leads-enrich', {}, async (log) => {
      let n = 0;
      for (const id of ids) {
        const lead = store.get('leads', id);
        if (!lead) continue;
        const enriched = lead.source === 'demo' ? { ...lead, webStatus: lead.website ? 'mejorable' : 'sin-web', enrichedAt: new Date().toISOString() } : await enrichPlace(lead, { scraper });
        store.put('leads', id, { ...lead, ...enriched });
        log(`${lead.name}: ${enriched.webStatus}${enriched.email ? ` · ${enriched.email}` : ''}`);
        n++;
      }
      return { enriched: n };
    });
    return { jobId: job.id };
  });
  route('POST', '/api/leads/demos', ({ body }) => {
    const ids = (body.ids || []).slice(0, 50);
    const job = jobs.start('leads-demos', {}, async (log) => {
      const out = [];
      for (const id of ids) {
        const lead = store.get('leads', id);
        if (!lead) continue;
        try {
          const p = await outreach.createDemo(lead, log);
          out.push({ leadId: id, url: p.demo.url });
          log(`✓ Demo lista: ${lead.name} → ${p.demo.url}`);
        } catch (err) {
          log(`✗ ${lead.name}: ${err.message.slice(0, 160)}`);
        }
      }
      return { demos: out };
    });
    return { jobId: job.id };
  });
  route('GET', '/api/campaigns', () => store.list('campaigns').map(({ messages, ...c }) => ({ ...c, messages: messages.length, sent: messages.filter((m) => m.status === 'sent').length })));
  route('GET', '/api/campaigns/:id', ({ params }) => store.get('campaigns', params.id) || Promise.reject(httpError(404, 'Campaña no encontrada')));
  route('POST', '/api/campaigns', ({ body }) => {
    const job = jobs.start('campaign-draft', {}, (log) => outreach.createCampaign((body.leadIds || []).slice(0, 100), log).then((c) => ({ campaignId: c.id, messages: c.messages.length, skipped: c.skipped })));
    return { jobId: job.id };
  });
  route('POST', '/api/campaigns/:id/send', ({ params, body }) => {
    if (body.confirm !== true) throw httpError(400, 'Debes confirmar el envío (confirm: true)');
    const job = jobs.start('campaign-send', { campaignId: params.id }, (log) => outreach.sendCampaign(params.id, { confirm: true }, log).then((c) => ({ status: c.status, sent: c.messages.filter((m) => m.status === 'sent').length })));
    return { jobId: job.id };
  });

  // ---------------- OAuth ----------------
  route('GET', '/auth/llm/start', ({ res }) => redirect(res, ai.oauth.buildAuthorizeUrl().url));
  route('GET', '/auth/llm/callback', async ({ query, res }) => {
    if (query.error) return html(res, 400, page('Error de autorización', escapeHtml(query.error_description || query.error)));
    await ai.oauth.exchangeCode(query.code, query.state);
    return html(res, 200, page('Proveedor de IA conectado', 'GPT-6 Luna ya puede trabajar con tu cuenta. Puedes cerrar esta pestaña.'));
  });
  route('POST', '/api/auth/llm/disconnect', () => (ai.oauth.disconnect(), { ok: true }));
  route('GET', '/auth/figma/start', async ({ res }) => redirect(res, (await figma.getManager()).buildAuthorizeUrl().url));
  route('GET', '/auth/figma/callback', async ({ query, res }) => {
    if (query.error) return html(res, 400, page('Figma no conectado', escapeHtml(query.error_description || query.error)));
    await (await figma.getManager()).exchangeCode(query.code, query.state);
    Object.assign(config.mcp.servers.figma, { enabled: true, token: () => figma.token() });
    return html(res, 200, page('Figma conectado', 'El MCP oficial de Figma ya está disponible para GPT-6 Luna.'));
  });

  // ---------------- Baja de emails ----------------
  route('GET', '/unsubscribe', ({ query, res }) => html(res, 200, page('Darse de baja', `<form method="post"><input type="hidden" name="e" value="${escapeHtml(query.e || '')}"><input type="hidden" name="t" value="${escapeHtml(query.t || '')}"><p>¿Confirmas que no quieres recibir más mensajes en <b>${escapeHtml(query.e || '')}</b>?</p><button>Darme de baja</button></form>`)));
  route('POST', '/unsubscribe', ({ query, body, res }) => {
    outreach.unsubscribe(body.e || query.e, body.t || query.t);
    return html(res, 200, page('Baja confirmada', 'No volverás a recibir mensajes nuestros.'));
  });

  // ---------------- Servidor ----------------
  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      // Ficheros estáticos: panel, vistas previas, demos, sitios publicados y capturas de referencias.
      const staticMatch =
        (url.pathname.match(/^\/preview\/([\w-]+)(\/.*)?$/) && ['sites', 'preview']) ||
        (url.pathname.match(/^\/demo\/([\w-]+)(\/.*)?$/) && ['sites', 'demo']) ||
        (url.pathname.match(/^\/published\/([\w.-]+)(\/.*)?$/) && ['published', '']) ||
        (url.pathname.match(/^\/sector-assets\/([\w.-]+)(\/.*)?$/) && ['assets', '']);
      if (req.method === 'GET' && staticMatch) {
        const [, id, rest = '/'] = url.pathname.match(/^\/[\w-]+\/([\w.-]+)(\/.*)?$/);
        const [col, sub] = staticMatch;
        if (rest === '/' && !url.pathname.endsWith('/')) return redirect(res, `${url.pathname}/`);
        return serveFile(res, path.join(config.dataDir, col, id, sub), rest);
      }
      if (req.method === 'GET' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/auth/') && url.pathname !== '/unsubscribe') {
        return serveFile(res, PUBLIC_DIR, url.pathname);
      }
      if ((url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) && !authorized(req, url, config)) {
        return json(res, 401, { error: 'No autorizado: indica PANEL_TOKEN' });
      }
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) return json(res, 404, { error: 'No encontrado' });
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(url.pathname.match(r.re)[i + 1])]));
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      const out = await r.handler({ req, res, params, query: Object.fromEntries(url.searchParams), body });
      if (!res.headersSent && out !== undefined) json(res, 200, out);
    } catch (err) {
      if (!res.headersSent) json(res, err.status || 500, { error: err.message });
    }
  };
}

function authorized(req, url, config) {
  if (!config.panelToken) return true;
  const header = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.headers['x-panel-token'];
  const cookie = /(?:^|;\s*)panel_token=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  const given = header || cookie || url.searchParams.get('token') || '';
  const a = Buffer.from(String(given));
  const b = Buffer.from(config.panelToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validateInput(body) {
  const str = (v, n = 200) => (v === undefined || v === null ? '' : String(v).trim().slice(0, n));
  const input = {
    name: str(body.name, 120),
    sector: str(body.sector, 80),
    location: str(body.location, 120),
    description: str(body.description, 1200),
    phone: str(body.phone, 40),
    email: str(body.email, 120),
    address: str(body.address, 200),
    whatsapp: str(body.whatsapp, 40),
    website: str(body.website, 300),
    instagram: str(body.instagram, 120),
    facebook: str(body.facebook, 300),
  };
  if (!input.name || !input.sector) throw httpError(400, 'Nombre del negocio y sector son obligatorios');
  if (input.website && !/^https?:\/\//i.test(input.website)) input.website = `https://${input.website}`;
  input.sectorId = resolveSector(input.sector).id;
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== ''));
}

const pick = (obj, keys) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => keys.includes(k)));

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2_000_000) throw httpError(413, 'Cuerpo demasiado grande');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  if ((req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, 'JSON no válido');
  }
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

const page = (title, body) =>
  `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><body style="font-family:system-ui;max-width:560px;margin:10vh auto;padding:0 20px;line-height:1.6"><h1>${escapeHtml(title)}</h1><div>${body}</div></body></html>`;

function serveFile(res, root, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(root, `.${rel}`);
  if (!file.startsWith(path.resolve(root) + path.sep)) return json(res, 403, { error: 'Prohibido' });
  let target = file;
  if (!fs.existsSync(target) && fs.existsSync(`${file}.html`)) target = `${file}.html`;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    const notFound = path.join(root, '404.html');
    if (fs.existsSync(notFound)) {
      res.writeHead(404, { 'content-type': TYPES['.html'] });
      return res.end(fs.readFileSync(notFound));
    }
    return json(res, 404, { error: 'No encontrado' });
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
  fs.createReadStream(target).pipe(res);
}

export function startServer(services) {
  const server = http.createServer(createApp(services));
  return new Promise((resolve) => server.listen(services.config.port, () => resolve(server)));
}
