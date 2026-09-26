import fs from 'node:fs';
import path from 'node:path';
import { extractFeatures, stylesheetUrls } from './extract.js';
import { BrowserCapture, summarizeMeasurements } from './browser.js';
import { fontStyle } from './extract.js';
import { resolveSector } from '../lib/sectors.js';
import { countBy, slugify, hostnameOf } from '../lib/util.js';
import { parseColor, toHex, isNeutral, hueFamily } from '../lib/color.js';

const SECTION_ORDER_MIN_FREQ = 0.3;

// Investigación de un sector: ≥10 referencias analizadas → master prompt reutilizable (con caché por sector+zona).
export class ResearchService {
  constructor({ config, store, ai, search, scraper, log = () => {} }) {
    this.cfg = config.research;
    this.store = store;
    this.ai = ai;
    this.search = search;
    this.scraper = scraper;
    this.log = log;
    this.browser = new BrowserCapture({ mcp: ai.mcp, extractScript: ai.skills.asset('taste-extract-js') });
  }

  sectorKey(sector, location) {
    const profile = resolveSector(sector);
    return location ? `${profile.id}--${slugify(location)}` : profile.id;
  }

  getSector(sector, location) {
    return this.store.get('sectors', this.sectorKey(sector, location));
  }

  async research({ sector, location, force = false }, log = this.log) {
    const key = this.sectorKey(sector, location);
    const cached = this.store.get('sectors', key);
    const maxAge = this.cfg.sectorCacheDays * 86_400_000;
    if (!force && cached && Date.now() - Date.parse(cached.createdAt) < maxAge) {
      log(`Master prompt del sector en caché (${cached.references.length} referencias, ${cached.createdAt.slice(0, 10)})`);
      return cached;
    }
    const profile = resolveSector(sector);
    const min = this.cfg.minReferences;
    log(`Buscando webs de referencia de "${sector}"${location ? ` en ${location}` : ''} (mínimo ${min})`);

    const references = [];
    const skipped = [];
    const tried = new Set();
    const assetsDir = path.join(this.store.dir, 'assets', key);
    fs.mkdirSync(assetsDir, { recursive: true });

    // Primero con la zona; si no hay suficientes, se amplía a nivel nacional.
    for (const loc of location ? [location, null] : [null]) {
      if (references.length >= min) break;
      const candidates = await this.search.candidates({ sector, location: loc, exclude: [...tried] });
      log(`${candidates.length} candidatos (${loc ? `zona: ${loc}` : 'ámbito nacional'})`);
      for (const c of candidates) {
        if (references.length >= min) break;
        if (tried.has(c.url)) continue;
        tried.add(c.url);
        try {
          const ref = await this.#analyzeCandidate(c, { sector, profile, index: references.length + 1, assetsDir, log });
          references.push(ref);
          log(`✓ Referencia ${references.length}/${min}: ${ref.host}`);
        } catch (err) {
          skipped.push({ url: c.url, reason: err.message.slice(0, 200) });
          log(`✗ Descartada ${hostnameOf(c.url) || c.url}: ${err.message.slice(0, 120)}`);
        }
      }
    }
    if (references.length < min) {
      throw new Error(`Solo se pudieron analizar ${references.length} referencias de ${min} requeridas. Revisa el proveedor de búsqueda o amplía el sector.`);
    }

    const stats = aggregate(references);
    log('Sintetizando el master prompt del sector con IA');
    const { data: synthesis, meta } = await this.ai.research.run(
      'sectorMasterPrompt',
      { sector, location, stats, analyses: references.map((r) => ({ host: r.host, ...r.analysis })) },
      { sectorId: profile.id },
    );
    const record = {
      id: key,
      sector,
      sectorId: profile.id,
      location: location || null,
      createdAt: new Date().toISOString(),
      searchProvider: this.search.name,
      references,
      skipped,
      stats,
      synthesis,
      masterPrompt: renderMasterPrompt({ sector, location, profile, stats, synthesis, references, synthetic: this.search.name === 'fixture' }),
      ai: { ...meta, analyses: references.map((r) => r.aiMeta) },
    };
    this.store.put('sectors', key, record);
    log(`Master prompt guardado (${record.masterPrompt.length} caracteres)`);
    return record;
  }

  async #analyzeCandidate(candidate, { sector, profile, index, assetsDir, log }) {
    const page = await this.scraper.get(candidate.url);
    if (!/html/i.test(page.contentType) && !page.body.includes('<html')) throw new Error('No es HTML');
    let css = '';
    const pre = extractFeatures(page.body, { url: page.url });
    if (!page.url.startsWith('fixture://')) {
      for (const href of stylesheetUrls(pre, page.url)) {
        try {
          css += (await this.scraper.get(href, { accept: 'text/css' })).body.slice(0, 400_000) + '\n';
        } catch {}
      }
    }
    const features = extractFeatures(page.body, { url: page.url, css });
    if (features.wordCount < 80) throw new Error('Contenido insuficiente');

    // Medición con navegador real (Taste + Playwright MCP) cuando está disponible.
    let design = null;
    let screenshotFile = null;
    const images = [];
    if (this.browser.available && /^https?:/.test(page.url)) {
      try {
        const cap = await this.browser.capture(page.url);
        design = summarizeMeasurements(cap.measurements);
        if (cap.screenshot) {
          images.push(cap.screenshot);
          screenshotFile = `ref-${index}.jpg`;
          fs.writeFileSync(path.join(assetsDir, screenshotFile), Buffer.from(cap.screenshot.split(',')[1], 'base64'));
        }
        mergeMeasuredDesign(features, design);
      } catch (err) {
        log(`  (sin captura de navegador para ${hostnameOf(page.url)}: ${err.message.slice(0, 80)})`);
      }
    }

    const reference = { ...features, host: page.url.startsWith('fixture://') ? `demo-${index}` : hostnameOf(page.url), design, screenshot: screenshotFile, query: candidate.query };
    const { data: analysis, meta } = await this.ai.research.run('analyzeReference', { sector, reference }, { sectorId: profile.id, images });
    return { ...reference, analysis, aiMeta: meta, analyzedAt: new Date().toISOString() };
  }
}

// Sustituye colores/fuentes estimados por CSS con los medidos en el navegador (más fiables).
function mergeMeasuredDesign(features, design) {
  if (!design) return;
  const brand = (design.accentColors || [])
    .map((c) => parseColor(c))
    .filter((rgb) => rgb && !isNeutral(rgb))
    .map((rgb) => ({ hex: toHex(rgb), count: 1, family: hueFamily(toHex(rgb)) }));
  if (brand.length) {
    features.colors.brand = brand;
    features.colors.primary = brand[0].hex;
    features.colors.families = countBy(brand, (c) => c.family).map(([f]) => f);
  }
  const fams = (design.fontFamilies || []).map((f) => String(f).split(',')[0].replace(/["']/g, '').trim()).filter(Boolean);
  if (fams.length) features.fonts = fams.map((name, i) => ({ name, count: fams.length - i, style: fontStyle(name) }));
}

export function aggregate(refs) {
  const n = refs.length;
  const freq = (pred) => Math.round((refs.filter(pred).length / n) * 100) / 100;
  const sectionTypes = [...new Set(refs.flatMap((r) => r.sections))];
  const sectionFrequency = Object.fromEntries(sectionTypes.map((t) => [t, freq((r) => r.sections.includes(t))]));
  const avgPos = (t) => {
    const pos = refs.filter((r) => r.sections.includes(t)).map((r) => r.sections.indexOf(t) / Math.max(1, r.sections.length - 1));
    return pos.reduce((a, b) => a + b, 0) / pos.length;
  };
  const typicalOrder = sectionTypes.filter((t) => sectionFrequency[t] >= SECTION_ORDER_MIN_FREQ).sort((a, b) => avgPos(a) - avgPos(b));
  const conversionKeys = ['forms', 'reviews', 'pricing', 'phone', 'whatsapp', 'booking', 'map', 'newsletter', 'chat', 'socialLinks'];
  const topFontStyles = refs.map((r) => r.fonts?.[0]?.style).filter(Boolean);
  return {
    referenceCount: n,
    sectionFrequency,
    typicalOrder,
    colorFamilies: countBy(refs.flatMap((r) => r.colors?.families?.slice(0, 2) || [])),
    brandColors: [...new Set(refs.flatMap((r) => (r.colors?.brand || []).slice(0, 3).map((c) => c.hex)))],
    fonts: countBy(refs.flatMap((r) => (r.fonts || []).slice(0, 2).map((f) => f.name))).slice(0, 10),
    typographyStyle: countBy(topFontStyles)[0]?.[0] || 'sans',
    ctas: countBy(refs.flatMap((r) => r.ctas || [])).slice(0, 12),
    conversionPrevalence: Object.fromEntries(conversionKeys.map((k) => [k, freq((r) => Boolean(r.conversion?.[k]))])),
    formality: countBy(refs.map((r) => r.analysis?.formality || r.tone?.formality)),
    avgWordCount: Math.round(refs.reduce((a, r) => a + (r.wordCount || 0), 0) / n),
    schemaTypes: countBy(refs.flatMap((r) => r.schemaTypes || [])).slice(0, 8),
    measured: refs.filter((r) => r.design).length,
  };
}

export function renderMasterPrompt({ sector, location, profile, stats, synthesis: s, references, synthetic = false }) {
  const list = (arr) => (arr || []).map((x) => `- ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('\n');
  const pct = (v) => `${Math.round(v * 100)} %`;
  return `# MASTER PROMPT — ${profile.label}${location ? ` · ${location}` : ''}
Basado en el análisis de ${references.length} webs ${synthetic ? 'SINTÉTICAS (modo demo)' : 'reales'} del sector (${stats.measured} medidas con navegador).
Úsalo como guía para generar webs ORIGINALES: extrae patrones, nunca copies textos, logos, fotos ni diseños concretos.

## Sector
${s.sectorSummary || ''}

## Público objetivo
${list(s.targetAudience)}

## Propuesta de valor esperada
${s.valueProposition || ''}

## Tono de comunicación
${s.tone?.description || ''} · Tratamiento: ${s.tone?.formality || stats.formality[0]?.[0] || 'tú'}
Hacer:
${list(s.tone?.dos)}
Evitar:
${list(s.tone?.donts)}

## Estructura recomendada (orden)
${(s.recommendedSections || []).map((x, i) => `${i + 1}. ${x.type} — ${x.purpose}`).join('\n')}
Frecuencia en referencias: ${Object.entries(stats.sectionFrequency).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v)}`).join(', ')}

## CTAs
${list(s.ctaGuidelines)}
CTAs más usados por la competencia (no copiar literalmente): ${stats.ctas.slice(0, 8).map(([t]) => t).join(' · ')}

## Elementos de conversión
${list(s.conversionElements)}
Prevalencia: ${Object.entries(stats.conversionPrevalence).map(([k, v]) => `${k} ${pct(v)}`).join(', ')}

## Diseño visual
Familias de color dominantes: ${stats.colorFamilies.slice(0, 4).map(([f, c]) => `${f} (${c})`).join(', ') || 'n/d'}
Estilo tipográfico predominante: ${stats.typographyStyle}; fuentes frecuentes: ${stats.fonts.slice(0, 6).map(([f]) => f).join(', ') || 'n/d'}
${s.designGuidelines ? `Colores: ${(s.designGuidelines.colorFamilies || []).join(', ')}\nTipografía: ${s.designGuidelines.typographyStyle}\nImágenes: ${s.designGuidelines.imagery}\nComposición: ${s.designGuidelines.layout}` : ''}
${s.designDna?.length ? `\nADN de diseño del sector (trade-offs, método Taste):\n${list(s.designDna)}` : ''}

## SEO
Palabras clave: ${(s.seoKeywords || []).join(', ')}
Tipo Schema.org: ${profile.schema}

## Mejores prácticas
${list(s.bestPractices)}

## Referencias analizadas (trazabilidad)
${references.map((r, i) => `${i + 1}. ${r.url} — ${r.analysis?.valueProposition || r.title}`).join('\n')}
`;
}
