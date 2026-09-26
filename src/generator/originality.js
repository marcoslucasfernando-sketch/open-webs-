import { normalizeText } from '../lib/util.js';

// Detección de copia textual: fragmentos de 6 palabras compartidos con cualquier referencia analizada.
const N = 6;

const clean = (t) => normalizeText(t).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

// Se eliminan los términos propios del encargo (nombre, sector, ubicación): coincidir en ellos no es copiar.
function shingles(text, ignore = []) {
  let t = ` ${clean(text)} `;
  for (const phrase of ignore) if (phrase) t = t.split(` ${phrase} `).join(' | ');
  const words = t.split(/\s+/).filter(Boolean);
  const out = new Set();
  for (let i = 0; i + N <= words.length; i++) {
    const w = words.slice(i, i + N);
    if (!w.includes('|')) out.add(w.join(' '));
  }
  return out;
}

export function ignoreTerms(business = {}, extra = []) {
  const terms = [business.name, business.sector, business.location, business.city, ...extra].filter(Boolean).map(clean);
  // También sus partes (p. ej. "las palmas de gran canaria" y "gran canaria"), de más larga a más corta.
  const parts = terms.flatMap((t) => [t, ...t.split(/\s*,\s*|\s+-\s+/)]);
  return [...new Set(parts)].filter((t) => t.length > 2).sort((a, b) => b.length - a.length);
}

export function buildReferenceIndex(references = [], ignore = []) {
  const index = new Map();
  for (const r of references) for (const s of shingles(`${r.textSample || ''} ${(r.headings || []).join('. ')}`, ignore)) index.set(s, r.url);
  return index;
}

// Devuelve los fragmentos copiados de un texto y de qué referencia provienen.
export function findCopied(text, index, ignore = []) {
  const hits = [];
  for (const s of shingles(text, ignore)) if (index.has(s)) hits.push({ fragment: s, source: index.get(s) });
  return hits;
}

// Recorre todos los textos de la especificación del sitio (con su ruta para poder reescribirlos).
export function* walkTexts(spec) {
  for (const [pi, page] of (spec.pages || []).entries()) {
    for (const key of ['metaTitle', 'metaDescription']) if (page[key]) yield { path: ['pages', pi, key], text: page[key] };
    for (const [si, sec] of (page.sections || []).entries()) {
      for (const key of ['heading', 'subheading', 'body']) if (sec[key]) yield { path: ['pages', pi, 'sections', si, key], text: sec[key] };
      for (const [ii, item] of (sec.items || []).entries()) {
        for (const key of ['title', 'text', 'q', 'a']) if (item[key]) yield { path: ['pages', pi, 'sections', si, 'items', ii, key], text: item[key] };
      }
    }
  }
}

export function setAt(obj, pathArr, value) {
  let o = obj;
  for (const k of pathArr.slice(0, -1)) o = o[k];
  o[pathArr.at(-1)] = value;
}

export function originalityReport(spec, references, ignore = ignoreTerms(spec.business)) {
  const index = buildReferenceIndex(references, ignore);
  const issues = [];
  let total = 0;
  for (const t of walkTexts(spec)) {
    total++;
    const hits = findCopied(t.text, index, ignore);
    if (hits.length) issues.push({ ...t, hits });
  }
  return { checkedTexts: total, issues, original: issues.length === 0 };
}
