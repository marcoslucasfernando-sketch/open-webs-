import * as cheerio from 'cheerio';
import { assertPublicUrl } from '../research/scraper.js';
import { parseEvaluateResult } from '../research/browser.js';

// Recogida de fotos y logo del propio negocio navegando su web pública, su Instagram y su Facebook con el
// navegador real (Playwright MCP), sin APIs. Si una página exige iniciar sesión se registra y se continúa con
// las demás fuentes (no se intenta saltar el bloqueo). Cada imagen guarda su URL de origen.

const MAX_BYTES = 8_000_000;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/gif': 'gif' };
export const extFor = (ct) => EXT[ct] || 'jpg';

// Script que se ejecuta dentro de la página: candidatos a logo, imágenes grandes, iconos y enlaces sociales.
const PAGE_SCRIPT = `async () => {
  window.scrollTo(0, document.body.scrollHeight);
  await new Promise((r) => setTimeout(r, 1200));
  window.scrollTo(0, 0);
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return null; } };
  const meta = (p) => document.querySelector('meta[property="' + p + '"],meta[name="' + p + '"]')?.content || null;
  const imgs = [...document.images].map((i) => {
    const ctx = i.closest('header,nav,[class*=logo],[id*=logo],[class*=brand]');
    return { src: abs(i.currentSrc || i.src), w: i.naturalWidth, h: i.naturalHeight, alt: i.alt || '',
             hint: [i.className, i.id, i.getAttribute('src'), ctx ? 'header' : ''].join(' ') };
  }).filter((x) => x.src && !x.src.startsWith('data:'));
  const bgs = [...document.querySelectorAll('section,div,header,figure')].slice(0, 1500).map((el) => {
    const m = getComputedStyle(el).backgroundImage.match(/url\\(["']?([^"')]+)["']?\\)/);
    const r = el.getBoundingClientRect();
    return m && r.width >= 600 && r.height >= 300 ? { src: abs(m[1]), w: Math.round(r.width), h: Math.round(r.height), alt: '', hint: 'background' } : null;
  }).filter(Boolean);
  const links = [...document.querySelectorAll('a[href]')].map((a) => a.href);
  const find = (re) => links.find((h) => re.test(h)) || null;
  return {
    url: location.href,
    title: document.title,
    ogImage: abs(meta('og:image')),
    logos: imgs.filter((i) => /logo|brand/i.test(i.hint + ' ' + i.alt) || (i.hint.includes('header') && i.w > 0 && i.w <= 700)).slice(0, 6),
    images: [...imgs, ...bgs].filter((i) => i.w >= 400 && i.h >= 280 && !/logo|icon|sprite|avatar/i.test(i.hint + ' ' + i.alt)).sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 24),
    icons: [...document.querySelectorAll('link[rel*=icon]')].map((l) => ({ href: abs(l.href), sizes: l.getAttribute('sizes') || '' })),
    social: { instagram: find(/instagram\\.com\\/(?!p\\/|reel\\/|explore\\/)[A-Za-z0-9_.]+/i), facebook: find(/facebook\\.com\\/(?!sharer|share)[^?#]+/i) },
    loginWall: /\\/accounts\\/login|\\/login/.test(location.pathname) || !!document.querySelector('input[name="username"], input[name="email"][type="text"]'),
  };
}`;

export function instagramUrl(value) {
  if (!value) return null;
  const v = String(value).trim();
  const m = v.match(/instagram\.com\/([A-Za-z0-9_.]+)/i);
  const user = m ? m[1] : v.replace(/^@/, '');
  return /^[A-Za-z0-9_.]{1,30}$/.test(user) ? `https://www.instagram.com/${user}/` : null;
}

export class BrandCollector {
  constructor({ mcp, scraper, fetch = globalThis.fetch, allowPrivate = false }) {
    this.allowPrivate = allowPrivate;
    this.mcp = mcp;
    this.scraper = scraper;
    this.fetch = fetch;
  }

  get browserAvailable() {
    return Boolean(this.mcp?.has('playwright'));
  }

  async #inspect(url) {
    if (this.browserAvailable) {
      const nav = await this.mcp.call('playwright__browser_navigate', { url });
      if (nav.text.startsWith('ERROR')) {
        const code = nav.text.match(/HTTP ERROR (\d{3})|ERR_[A-Z_]+/)?.[0] || 'error de navegación';
        const err = new Error(/429/.test(nav.text) ? 'HTTP 429: la plataforma limita el acceso desde esta IP' : code);
        err.blocked = true;
        throw err;
      }
      await this.mcp.call('playwright__browser_wait_for', { time: 2 }).catch(() => {});
      const res = await this.mcp.call('playwright__browser_evaluate', { function: PAGE_SCRIPT });
      const data = parseEvaluateResult(res.text);
      if (String(data.url).startsWith('chrome-error:')) throw Object.assign(new Error('la página no cargó'), { blocked: true });
      return data;
    }
    // Sin navegador: HTML estático (solo sirve para la web propia del negocio).
    const page = await this.scraper.get(url);
    const $ = cheerio.load(page.body);
    const abs = (u) => {
      try {
        return new URL(u, page.url).href;
      } catch {
        return null;
      }
    };
    const imgs = $('img').map((_, el) => ({ src: abs($(el).attr('src')), w: Number($(el).attr('width')) || 0, h: Number($(el).attr('height')) || 0, alt: $(el).attr('alt') || '', hint: `${$(el).attr('class') || ''} ${$(el).attr('id') || ''} ${$(el).attr('src') || ''} ${$(el).closest('header,nav').length ? 'header' : ''}` })).get().filter((i) => i.src);
    const links = $('a[href]').map((_, el) => abs($(el).attr('href'))).get().filter(Boolean);
    return {
      url: page.url,
      ogImage: abs($('meta[property="og:image"]').attr('content') || ''),
      logos: imgs.filter((i) => /logo|brand/i.test(i.hint + i.alt)),
      images: imgs.filter((i) => !/logo|icon/i.test(i.hint + i.alt) && (i.w === 0 || i.w >= 400)),
      icons: $('link[rel*="icon"]').map((_, el) => ({ href: abs($(el).attr('href')), sizes: $(el).attr('sizes') || '' })).get(),
      social: { instagram: links.find((h) => /instagram\.com\/[A-Za-z0-9_.]+/i.test(h)) || null, facebook: links.find((h) => /facebook\.com\//i.test(h)) || null },
      loginWall: false,
    };
  }

  // Recorre las fuentes y devuelve candidatos descargados: { logo, photos[], sources[] }.
  async collect({ website, instagram, facebook, maxPhotos = 10 }, log = () => {}) {
    const sources = [];
    const logoCands = [];
    const photoCands = [];
    let ig = instagramUrl(instagram);
    let fb = facebook || null;
    const visited = new Set();
    // Orden: web propia (de ahí se descubren Instagram/Facebook si no se conocen) → Instagram → Facebook.
    const next = () =>
      (website && !visited.has('web') && { kind: 'web', url: website }) ||
      (ig && !visited.has('instagram') && { kind: 'instagram', url: ig }) ||
      (fb && !visited.has('facebook') && { kind: 'facebook', url: fb }) ||
      null;

    for (let item = next(); item; item = next()) {
      visited.add(item.kind);
      try {
        if (!this.browserAvailable && item.kind !== 'web') {
          sources.push({ ...item, status: 'omitido: requiere navegador (Playwright MCP)' });
          continue;
        }
        const data = await this.#inspect(item.url);
        if (data.loginWall) {
          sources.push({ ...item, status: 'bloqueado: la página pide iniciar sesión' });
          log(`${item.kind}: la página pide iniciar sesión; se continúa con otras fuentes`);
        } else {
          sources.push({ ...item, status: 'ok', found: { logos: data.logos.length, images: data.images.length } });
          log(`${item.kind}: ${data.images.length} imágenes y ${data.logos.length} posibles logos`);
        }
        // En Instagram/Facebook la og:image suele ser la foto de perfil (normalmente el logo del negocio).
        if (item.kind === 'web') {
          logoCands.push(...data.logos.map((l) => ({ ...l, from: item.kind, page: data.url })));
          const icon = [...(data.icons || [])].sort((a, b) => parseInt(b.sizes) - parseInt(a.sizes) || 0)[0];
          if (icon?.href) logoCands.push({ src: icon.href, w: parseInt(icon.sizes) || 0, alt: 'icono', from: 'web-icon', page: data.url });
          if (data.ogImage) photoCands.push({ src: data.ogImage, w: 1200, h: 630, alt: '', from: 'web-og', page: data.url });
        } else if (data.ogImage) {
          logoCands.push({ src: data.ogImage, w: 320, alt: 'perfil', from: `${item.kind}-profile`, page: data.url });
        }
        if (!data.loginWall) photoCands.push(...data.images.map((im) => ({ ...im, from: item.kind, page: data.url })));
        ig ||= instagramUrl(data.social?.instagram);
        fb ||= data.social?.facebook || null;
      } catch (err) {
        sources.push({ ...item, status: `${err.blocked ? 'bloqueado' : 'error'}: ${err.message.slice(0, 120)}` });
        log(`${item.kind}: no se pudo abrir (${err.message.slice(0, 80)})`);
      }
    }

    const seen = new Set();
    const uniq = (arr) => arr.filter((c) => c.src && !seen.has(c.src.split('?')[0]) && seen.add(c.src.split('?')[0]));
    const logo = await this.#firstDownload(uniq(logoCands), log);
    const photos = [];
    for (const c of uniq(photoCands)) {
      if (photos.length >= maxPhotos) break;
      try {
        const dl = await this.download(c.src, c.page);
        photos.push({ ...dl, alt: c.alt, width: c.w, height: c.h, source: c.from, sourceUrl: c.src, page: c.page });
      } catch {}
    }
    log(`Recogidas ${photos.length} fotos${logo ? ' y el logo' : ''} del negocio`);
    return { logo, photos, sources, instagram: ig, facebook: fb };
  }

  async #firstDownload(cands, log) {
    for (const c of cands) {
      try {
        const dl = await this.download(c.src, c.page);
        return { ...dl, alt: c.alt, source: c.from, sourceUrl: c.src, page: c.page };
      } catch (err) {
        log(`logo descartado (${err.message.slice(0, 60)})`);
      }
    }
    return null;
  }

  async download(url, referer) {
    if (!this.allowPrivate) await assertPublicUrl(url);
    const res = await this.fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36', accept: 'image/avif,image/webp,image/*,*/*;q=0.8', ...(referer ? { referer } : {}) },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`descarga ${res.status}`);
    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!EXT[contentType]) throw new Error(`tipo no admitido ${contentType}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_BYTES || buffer.length < 1500) throw new Error('tamaño no válido');
    return { buffer, contentType };
  }
}
