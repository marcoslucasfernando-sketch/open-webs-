import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractFeatures } from '../src/research/extract.js';
import { parseRobots, isAllowed, isPrivateIp } from '../src/research/scraper.js';
import { isBusinessSite } from '../src/research/search.js';
import { baseTokens, mergeTokens, sanitizeCss, MIN_DISTANCE_TO_REFERENCES } from '../src/generator/design.js';
import { contrastRatio, colorDistance } from '../src/lib/color.js';
import { originalityReport, ignoreTerms } from '../src/generator/originality.js';
import { renderSite, stripPlaceholders, countPlaceholders } from '../src/generator/render.js';
import { normalizeSpec } from '../src/generator/pipeline.js';
import { resolveSector } from '../src/lib/sectors.js';
import { OAuthTokenManager } from '../src/ai/auth/oauth.js';
import { SkillRegistry, parseFrontmatter } from '../src/ai/skills.js';
import { parseModelSpec } from '../src/ai/index.js';
import { FileStore } from '../src/lib/store.js';
import { placeFromOsm, overpassQuery } from '../src/leads/places.js';
import { instagramUrl } from '../src/media/brand.js';
import { NetlifyHosting } from '../src/deploy/hosting.js';
import { normalizeDomain } from '../src/lib/util.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ow-'));

test('extractor: secciones, CTAs, conversión, tono y colores', () => {
  const html = `<html lang="es"><head><title>T</title><style>.btn{background:#1f6feb}h1{font-family:'Playfair Display',serif}</style></head><body>
  <header><nav><a href="/">Inicio</a><a class="btn" href="tel:+34928000000">Llámanos</a></nav></header>
  <section class="hero"><h1>Tu clínica</h1><a class="btn" href="#c">Pide tu cita</a></section>
  <section id="servicios"><h2>Nuestros servicios</h2></section><section><h2>Opiniones de clientes</h2><p>★★★★★</p></section>
  <form><input name="email"><textarea name="mensaje"></textarea></form><a href="https://wa.me/34600">WhatsApp</a>
  <p>Descubre cómo te ayudamos. Reserva tu cita y te atendemos con calma.</p></body></html>`;
  const f = extractFeatures(html, { url: 'https://x.es' });
  assert.deepEqual(f.sections.slice(0, 3), ['hero', 'services', 'testimonials']);
  assert.ok(f.ctas.some((c) => /pide tu cita/i.test(c)));
  assert.equal(f.conversion.forms, 1);
  assert.ok(f.conversion.whatsapp && f.conversion.phone && f.conversion.reviews);
  assert.equal(f.tone.formality, 'tú');
  assert.equal(f.colors.primary, '#1f6feb');
  assert.equal(f.fonts[0].style, 'serif');
});

test('robots.txt y protección SSRF', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /privado\nAllow: /privado/publico\n');
  assert.equal(isAllowed(rules, '/privado/x'), false);
  assert.equal(isAllowed(rules, '/privado/publico/y'), true);
  assert.equal(isAllowed(rules, '/'), true);
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '169.254.169.254', '::1', '172.20.0.1']) assert.ok(isPrivateIp(ip), ip);
  assert.ok(!isPrivateIp('8.8.8.8'));
  assert.ok(!isBusinessSite('https://www.tripadvisor.es/x') && !isBusinessSite('https://instagram.com/x') && isBusinessSite('https://clinicadental.es'));
});

test('tokens de diseño: contraste AA y distancia a colores de la competencia', () => {
  const refColors = ['#2b6ec0', '#1f6feb', '#0f766e'];
  const t = baseTokens({ business: { name: 'Demo', sector: 'Clínica dental' }, sectorRecord: { stats: { brandColors: refColors, colorFamilies: [['azul', 5]], fonts: [['Manrope', 3]] } }, profile: resolveSector('dental') });
  assert.ok(contrastRatio(t.primary, '#ffffff') >= 4.5);
  assert.ok(contrastRatio(t.text, t.bg) >= 7);
  for (const c of refColors) assert.ok(colorDistance(t.primary, c) >= MIN_DISTANCE_TO_REFERENCES);
  assert.notEqual(t.headingFont, 'Manrope');
  const { tokens, rejected } = mergeTokens(t, { primary: '#1f6feb', text: '#eeeeee', headingFont: 'Fraunces' }, refColors);
  assert.ok(rejected.includes('primary') && rejected.includes('text'));
  assert.equal(tokens.headingFont, 'Fraunces');
});

test('saneado del CSS generado por IA', () => {
  const css = sanitizeCss(`@import url(https://evil.com/x.css); @import url("https://fonts.googleapis.com/css2?family=Inter"); .a{background:url(https://evil.com/p.png)} .b{width:expression(alert(1))} </style><script>`);
  assert.ok(!css.includes('evil.com') && !/expression\(/.test(css) && !css.includes('<script') && css.includes('fonts.googleapis.com'));
});

test('originalidad: detecta copia pero no penaliza sector/ubicación', () => {
  const refs = [{ url: 'https://ref', textSample: 'Somos el equipo con más experiencia de toda la isla en implantes' }];
  const spec = { business: { name: 'X', sector: 'Clínica dental', location: 'Telde' }, pages: [{ metaTitle: 'Clínica dental en Telde', sections: [{ heading: 'Somos el equipo con más experiencia de toda la isla', body: 'Otra cosa' }] }] };
  const rep = originalityReport(spec, refs, ignoreTerms(spec.business));
  assert.equal(rep.issues.length, 1);
  assert.deepEqual(rep.issues[0].path, ['pages', 0, 'sections', 0, 'heading']);
});

test('render: modos preview/demo/publish, marcadores y SEO', () => {
  const spec = normalizeSpec(
    {
      business: { tagline: 't' },
      pages: [
        { slug: '', type: 'home', navLabel: 'Inicio', metaTitle: 'Inicio', metaDescription: 'd', sections: [{ type: 'hero', heading: 'Hola', subheading: 'Sub. [[PENDIENTE: dato]]', cta: { label: 'Cita', href: '/contacto/' } }, { type: 'testimonials', heading: 'Opiniones', items: [{ title: '[[PENDIENTE: nombre]]', text: '[[PENDIENTE: reseña]]' }] }, { type: 'faq', heading: 'FAQ', items: [{ q: '¿Horario?', a: 'Mañanas' }] }] },
        { slug: 'contacto', type: 'contact', navLabel: 'Contacto', sections: [{ type: 'contact', heading: 'Hablemos' }] },
      ],
    },
    { name: 'Negocio <Test>', sector: 'Clínica dental' },
  );
  assert.equal(countPlaceholders(spec), 3);
  const design = { tokens: { primary: '#224488', primaryInk: '#fff', accent: '#ff8800', bg: '#fff', surface: '#f5f5f5', text: '#111', muted: '#555', headingFont: 'Fraunces', bodyFont: 'Inter', radius: '12px', space: '8px', maxWidth: '1100px' }, heroVariant: 'split' };
  const preview = renderSite(spec, design, { mode: 'preview' });
  assert.match(preview['index.html'], /<mark class="todo"/);
  assert.match(preview['index.html'], /Negocio &lt;Test&gt;/);
  const demo = renderSite(spec, design, { mode: 'demo', baseUrl: 'https://demo.x' });
  assert.doesNotMatch(demo['index.html'], /PENDIENTE|Opiniones/);
  assert.match(demo['index.html'], /noindex/);
  assert.match(demo['index.html'], /No es la web oficial/);
  const pub = renderSite(stripPlaceholders(spec), design, { mode: 'publish', baseUrl: 'https://negocio.es', buildId: 'build_1', schemaType: 'Dentist' });
  assert.doesNotMatch(pub['index.html'], /noindex/);
  assert.match(pub['index.html'], /"@type":"Dentist"/);
  assert.match(pub['index.html'], /"@type":"FAQPage"/);
  assert.match(pub['contacto/index.html'], /href="\.\.\/styles\.css"/);
  assert.match(pub['sitemap.xml'], /https:\/\/negocio\.es\/contacto\//);
  assert.match(pub['index.html'], /build_1/);
});

test('OAuth client_credentials: obtiene, cachea y refresca el token', async () => {
  let calls = 0;
  const fetch = async (url, opts) => {
    calls++;
    assert.match(opts.body, /grant_type=client_credentials/);
    assert.match(opts.body, /client_id=cid/);
    return new Response(JSON.stringify({ access_token: `t${calls}`, expires_in: 3600 }), { status: 200 });
  };
  const m = new OAuthTokenManager({ grant: 'client_credentials', tokenUrl: 'https://auth/token', clientId: 'cid', clientSecret: 's', scope: 'api' }, { store: new FileStore(tmp()), fetch });
  assert.equal(await m.getAccessToken(), 't1');
  assert.equal(await m.getAccessToken(), 't1');
  m.invalidate();
  assert.equal(await m.getAccessToken(), 't2');
});

test('OAuth authorization_code + PKCE y tokens cifrados', async () => {
  const dir = tmp();
  const store = new FileStore(dir, { secretKey: 'clave' });
  const fetch = async (url, opts) => {
    const body = new URLSearchParams(opts.body);
    if (body.get('grant_type') === 'authorization_code') {
      assert.ok(body.get('code_verifier'));
      return new Response(JSON.stringify({ access_token: 'a1', refresh_token: 'r1', expires_in: 1 }));
    }
    assert.equal(body.get('refresh_token'), 'r1');
    return new Response(JSON.stringify({ access_token: 'a2', expires_in: 3600 }));
  };
  const m = new OAuthTokenManager({ grant: 'authorization_code', authorizeUrl: 'https://auth/authorize', tokenUrl: 'https://auth/token', clientId: 'cid', redirectUri: 'http://x/cb', scope: 'openid' }, { store, fetch });
  const { url, state } = m.buildAuthorizeUrl();
  assert.match(url, /code_challenge_method=S256/);
  await m.exchangeCode('code', state);
  assert.equal(await m.getAccessToken(), 'a2', 'refresca al estar caducado');
  const raw = fs.readFileSync(path.join(dir, 'secrets', 'llm-oauth.json'), 'utf8');
  assert.ok(!raw.includes('r1') && JSON.parse(raw).enc, 'tokens cifrados en disco');
  await assert.rejects(() => m.exchangeCode('x', 'estado-falso'));
});

test('skills: frontmatter, selección por tarea/sector/integración y modo tools', () => {
  assert.deepEqual(parseFrontmatter('---\nname: a\ntasks: [x, y]\npriority: 5\n---\ncuerpo').meta, { name: 'a', tasks: ['x', 'y'], priority: 5 });
  const r = new SkillRegistry(path.resolve('skills'));
  assert.ok(r.skills.length >= 20);
  const dental = r.select('siteContent', 'clinica-dental').map((s) => s.name);
  assert.ok(dental.includes('health-advertising-rules') && !dental.includes('legal-services-advertising'));
  assert.ok(!r.select('figmaImport', null, []).some((s) => s.name.startsWith('figma')));
  const b = r.build('designReview', null, ['playwright']);
  assert.ok(b.index.length > 0 && b.used.includes('visual-qa-checklist'));
  assert.deepEqual(parseModelSpec('openai:gpt-6-luna'), { provider: 'openai', model: 'gpt-6-luna' });
});

test('OpenStreetMap → lead y consulta Overpass', () => {
  const p = placeFromOsm({ type: 'node', id: 1, lat: 28.1, lon: -15.4, tags: { name: 'Dental Sol', amenity: 'dentist', website: 'dentalsol.es', 'contact:email': 'hola@dentalsol.es', 'addr:city': 'Telde' } });
  assert.equal(p.sectorId, 'clinica-dental');
  assert.equal(p.website, 'https://dentalsol.es');
  assert.equal(p.email, 'hola@dentalsol.es');
  assert.match(overpassQuery([27.7, -15.8, 28.2, -15.3], ['clinica-dental']), /"amenity"="dentist"/);
  assert.equal(instagramUrl('@bar.lolita'), 'https://www.instagram.com/bar.lolita/');
  assert.equal(instagramUrl('https://www.instagram.com/bar_lolita/?hl=es'), 'https://www.instagram.com/bar_lolita/');
  assert.equal(normalizeDomain('https://www.MiNegocio.es/'), 'minegocio.es');
  assert.throws(() => normalizeDomain('no es dominio'));
});

test('Netlify: despliegue por digest sube solo los ficheros requeridos', async () => {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push(`${opts.method} ${url.replace('https://api.netlify.com/api/v1', '')}`);
    if (url.endsWith('/deploys') && opts.method === 'POST') {
      const files = JSON.parse(opts.body).files;
      return new Response(JSON.stringify({ id: 'd1', required: [files['/index.html']] }));
    }
    if (url.endsWith('/deploys/d1')) return new Response(JSON.stringify({ id: 'd1', state: 'ready', ssl_url: 'https://s.netlify.app' }));
    return new Response('{}');
  };
  const h = new NetlifyHosting({ token: 't', fetch });
  const r = await h.deploy('site1', { 'index.html': '<h1>x</h1>', 'styles.css': 'a{}' });
  assert.equal(r.url, 'https://s.netlify.app');
  assert.deepEqual(calls, ['POST /sites/site1/deploys', 'PUT /deploys/d1/files/index.html', 'GET /deploys/d1']);
});
