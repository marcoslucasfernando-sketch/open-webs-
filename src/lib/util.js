import crypto from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function slugify(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'sitio';
}

export const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
export const newId = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;

// PRNG determinista a partir de una semilla de texto (para decisiones de diseño reproducibles).
export function seededRandom(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function countBy(items, key = (x) => x) {
  const out = new Map();
  for (const item of items) {
    const k = key(item);
    if (k === undefined || k === null || k === '') continue;
    out.set(k, (out.get(k) || 0) + 1);
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]);
}

export function normalizeText(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function normalizeDomain(input) {
  const d = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
  if (!/^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) {
    throw new Error(`Dominio no válido: "${input}"`);
  }
  return d;
}
