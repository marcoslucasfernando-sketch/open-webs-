import fs from 'node:fs';
import path from 'node:path';
import { resolveSector } from '../lib/sectors.js';
import { seededRandom, slugify } from '../lib/util.js';
import { baseTokens, mergeTokens } from './design.js';
import { renderSite, countPlaceholders } from './render.js';
import { originalityReport, ignoreTerms, setAt } from './originality.js';
import { extFor } from '../media/brand.js';

const SECTION_TYPES = new Set(['hero', 'services', 'features', 'process', 'about', 'testimonials', 'faq', 'cta', 'contact', 'map', 'gallery']);
const HERO_VARIANTS = ['split', 'centered', 'editorial', 'fullbleed'];

export function writeFiles(dir, files) {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
}

// Normaliza la especificación devuelta por la IA a un formato seguro y completo.
export function normalizeSpec(raw, business) {
  const clip = (s, n) => {
    s = String(s || '').trim();
    return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
  };
  const pages = (Array.isArray(raw?.pages) ? raw.pages : []).map((p, i) => ({
    slug: i === 0 && !p.slug ? '' : slugify(p.slug || p.navLabel || `pagina-${i}`).replace(/^sitio$/, ''),
    type: ['home', 'services', 'about', 'contact'].includes(p.type) ? p.type : i === 0 ? 'home' : 'about',
    navLabel: clip(p.navLabel || p.title || `Página ${i + 1}`, 24),
    metaTitle: clip(p.metaTitle || `${business.name}`, 60),
    metaDescription: clip(p.metaDescription || '', 158),
    sections: (Array.isArray(p.sections) ? p.sections : [])
      .filter((s) => SECTION_TYPES.has(s?.type))
      .map((s) => ({
        type: s.type,
        heading: s.heading ? String(s.heading) : '',
        subheading: s.subheading ? String(s.subheading) : '',
        body: s.body ? String(s.body) : '',
        items: Array.isArray(s.items) ? s.items.slice(0, 12).map((it) => Object.fromEntries(Object.entries(it || {}).filter(([k, v]) => ['title', 'text', 'q', 'a'].includes(k) && typeof v === 'string'))) : undefined,
        cta: s.cta?.label ? { label: clip(s.cta.label, 40), href: String(s.cta.href || '/contacto/') } : undefined,
      })),
  }));
  if (!pages.some((p) => p.type === 'home')) throw new Error('La especificación generada no incluye página de inicio');
  const seen = new Set();
  const unique = pages.filter((p) => (seen.has(p.slug) ? false : seen.add(p.slug)));
  return {
    business: {
      ...business,
      name: business.name,
      tagline: clip(raw?.business?.tagline || business.sector, 90),
      description: clip(raw?.business?.description || business.description || '', 400),
    },
    keywords: (raw?.keywords || []).slice(0, 15).map(String),
    pages: unique,
  };
}

export class GeneratorService {
  constructor({ config, store, ai, research, brand }) {
    this.brand = brand;
    this.config = config;
    this.store = store;
    this.ai = ai;
    this.research = research;
  }

  previewUrl(projectId) {
    return `${this.config.publicUrl.replace(/\/$/, '')}/preview/${projectId}/`;
  }

  async generate(project, log = () => {}) {
    const business = project.input;
    const profile = resolveSector(business.sector);
    const sectorRecord = await this.research.research({ sector: business.sector, location: business.location }, log);

    log('Redactando contenidos con IA (master prompt del sector + datos del negocio)');
    const { data: rawSpec, meta: contentMeta } = await this.ai.generation.run(
      'siteContent',
      { business, masterPrompt: sectorRecord.masterPrompt, synthesis: sectorRecord.synthesis },
      { sectorId: profile.id },
    );
    const spec = normalizeSpec(rawSpec, business);

    log('Comprobando originalidad frente a las referencias');
    const ignore = ignoreTerms(business, [profile.label]);
    let originality = originalityReport(spec, sectorRecord.references, ignore);
    for (const issue of originality.issues.slice(0, 12)) {
      const { data } = await this.ai.generation.run('rewriteSection', { text: issue.text, avoid: issue.hits.map((h) => h.fragment) }, { sectorId: profile.id });
      if (data?.text) setAt(spec, issue.path, String(data.text));
    }
    if (originality.issues.length) originality = { ...originalityReport(spec, sectorRecord.references, ignore), rewritten: originality.issues.length };

    const media = await this.collectMedia(project.id, spec, business, profile, log);
    const design = await this.design(spec, business, sectorRecord, profile, log, media);
    const result = {
      spec,
      design,
      sectorKey: sectorRecord.id,
      originality,
      placeholders: countPlaceholders(spec),
      decisions: buildDecisions(sectorRecord, design, spec),
      mediaSources: media.sources,
      ai: { content: contentMeta, design: design.aiMeta },
      generatedAt: new Date().toISOString(),
    };
    this.renderPreview(project.id, result, profile);
    if (this.config.generation?.qa !== false) await this.qa(project.id, result, profile, log);
    return result;
  }

  // Fotos y logo del propio negocio (web, Instagram, Facebook) → selección con IA → spec.media.
  async collectMedia(projectId, spec, business, profile, log) {
    const empty = { sources: [], logoImage: null };
    if (!this.brand || !(business.website || business.instagram || business.facebook)) return empty;
    log('Recogiendo fotos y logo del negocio (web, Instagram, Facebook)');
    let found;
    try {
      found = await this.brand.collect({ website: business.website, instagram: business.instagram, facebook: business.facebook }, log);
    } catch (err) {
      log(`No se pudieron recoger imágenes: ${err.message.slice(0, 120)}`);
      return empty;
    }
    const dir = path.join(this.store.siteDir(projectId), 'media');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const save = (name, img) => {
      const file = `${name}.${extFor(img.contentType)}`;
      fs.writeFileSync(path.join(dir, file), img.buffer);
      return `img/${file}`;
    };
    const dataUrl = (img) => (img.buffer.length <= 1_500_000 ? `data:${img.contentType};base64,${img.buffer.toString('base64')}` : null);
    const media = { gallery: [] };
    if (found.logo) media.logo = { file: save('logo', found.logo), alt: business.name, source: found.logo.source, sourceUrl: found.logo.sourceUrl };

    if (found.photos.length) {
      const candidates = found.photos.map((p, index) => ({ index, source: p.source, width: p.width, height: p.height, alt: p.alt }));
      let pick;
      try {
        ({ data: pick } = await this.ai.generation.run('selectImages', { business, candidates }, { sectorId: profile.id, images: found.photos.slice(0, 8).map(dataUrl).filter(Boolean), useTools: false }));
      } catch (err) {
        log(`Selección de fotos con IA no disponible: ${err.message.slice(0, 80)}`);
        pick = { hero: 0, about: 1, gallery: [2, 3, 4, 5] };
      }
      const valid = (i) => Number.isInteger(i) && i >= 0 && i < found.photos.length;
      const entry = (i, name) => ({ file: save(name, found.photos[i]), alt: String(pick.alts?.[i] || found.photos[i].alt || `${business.name}`), source: found.photos[i].source, sourceUrl: found.photos[i].sourceUrl });
      if (valid(pick.hero)) media.hero = entry(pick.hero, 'hero');
      if (valid(pick.about) && pick.about !== pick.hero) media.about = entry(pick.about, 'about');
      media.gallery = [...new Set((pick.gallery || []).filter((i) => valid(i) && i !== pick.hero && i !== pick.about))].slice(0, 6).map((i, n) => entry(i, `galeria-${n + 1}`));
    }
    spec.media = media;
    const home = spec.pages.find((p) => p.type === 'home');
    if (media.gallery.length >= 3 && !home.sections.some((s) => s.type === 'gallery')) {
      const at = home.sections.findIndex((s) => ['faq', 'cta'].includes(s.type));
      home.sections.splice(at < 0 ? home.sections.length : at, 0, { type: 'gallery', heading: 'Galería' });
    }
    return { sources: found.sources, logoImage: found.logo && dataUrl(found.logo) };
  }

  mediaFiles(projectId) {
    const dir = path.join(this.store.siteDir(projectId), 'media');
    if (!fs.existsSync(dir)) return {};
    return Object.fromEntries(fs.readdirSync(dir).map((f) => [`img/${f}`, fs.readFileSync(path.join(dir, f))]));
  }

  async design(spec, business, sectorRecord, profile, log, media = {}) {
    log('Diseñando el sistema visual con IA (Frontend Design + Impeccable + Emil Kowalski)');
    const base = baseTokens({ business, sectorRecord, profile });
    const sections = [...new Set(spec.pages.flatMap((p) => p.sections.map((s) => s.type)))];
    const { data, meta } = await this.ai.generation.run(
      'siteDesign',
      { business, masterPrompt: sectorRecord.masterPrompt, baseTokens: base, sections, hasLogo: Boolean(media.logoImage) },
      { sectorId: profile.id, images: media.logoImage ? [media.logoImage] : [] },
    );
    const { tokens, rejected } = mergeTokens(base, data?.tokens, sectorRecord.stats?.brandColors || []);
    const rand = seededRandom(`hero|${business.name}`);
    let heroVariant = HERO_VARIANTS.includes(data?.heroVariant) ? data.heroVariant : HERO_VARIANTS[Math.floor(rand() * 3)];
    // Con foto real del negocio el hero debe mostrarla (la variante centrada no tiene columna de imagen).
    if (spec.media?.hero && heroVariant === 'centered') heroVariant = 'split';
    return {
      tokens,
      heroVariant,
      css: typeof data?.css === 'string' ? data.css : '',
      rationale: Array.isArray(data?.rationale) ? data.rationale.map(String) : [],
      rejectedTokens: rejected,
      baseTokens: base,
      aiMeta: meta,
    };
  }

  renderPreview(projectId, result, profile = resolveSector(result.spec.business.sector)) {
    const files = renderSite(result.spec, result.design, { mode: 'preview', schemaType: profile.schema, baseUrl: this.previewUrl(projectId).replace(/\/$/, ''), assets: this.mediaFiles(projectId) });
    writeFiles(path.join(this.store.siteDir(projectId), 'preview'), files);
    return files;
  }

  // Revisión visual: GPT-6 Luna abre la vista previa con Playwright/Chrome DevTools, puntúa y propone CSS correctivo.
  async qa(projectId, result, profile, log) {
    const gen = this.ai.generation;
    if (gen.provider === 'mock' || !this.ai.mcp.has('playwright')) {
      result.qa = { skipped: 'Revisión visual no disponible (IA mock o Playwright MCP desactivado)' };
      return;
    }
    try {
      log('Revisión visual con navegador real (capturas escritorio/móvil, consola y Lighthouse)');
      const { data, meta } = await gen.run('designReview', { business: result.spec.business, previewUrl: this.previewUrl(projectId), spec: { tokens: result.design.tokens, heroVariant: result.design.heroVariant } }, { sectorId: profile.id });
      result.qa = { score: data?.score ?? null, issues: data?.issues || [], ai: meta };
      if (data?.fixesCss) {
        result.design.fixesCss = String(data.fixesCss);
        this.renderPreview(projectId, result, profile);
        log(`Aplicadas correcciones de la revisión (${(data.issues || []).length} incidencias)`);
      }
    } catch (err) {
      result.qa = { error: err.message };
      log(`Revisión visual omitida: ${err.message.slice(0, 120)}`);
    }
  }
}

// Trazabilidad: cada decisión de estructura, copy y diseño enlazada a la evidencia de las referencias.
function buildDecisions(sector, design, spec) {
  const st = sector.stats;
  const refs = sector.references.map((r) => r.url);
  const pct = (v) => `${Math.round((v || 0) * 100)} %`;
  const withSection = (t) => sector.references.filter((r) => r.sections.includes(t)).map((r) => r.url);
  const home = spec.pages.find((p) => p.type === 'home');
  return [
    {
      area: 'Estructura',
      decision: `Inicio con secciones: ${home.sections.map((s) => s.type).join(' → ')}`,
      justification: `Orden típico en las referencias: ${st.typicalOrder.join(' → ')}`,
      references: refs,
    },
    ...home.sections
      .filter((s) => st.sectionFrequency[s.type] !== undefined)
      .map((s) => ({ area: 'Sección', decision: s.type, justification: `Presente en el ${pct(st.sectionFrequency[s.type])} de las referencias`, references: withSection(s.type) })),
    {
      area: 'Tono',
      decision: `Tratamiento de ${sector.synthesis?.tone?.formality || st.formality[0]?.[0] || 'tú'}`,
      justification: `Distribución en referencias: ${st.formality.map(([f, n]) => `${f} ${n}`).join(', ')}`,
      references: refs,
    },
    {
      area: 'Color',
      decision: `Primario ${design.tokens.primary}, acento ${design.tokens.accent}`,
      justification: `Familias dominantes del sector: ${st.colorFamilies.slice(0, 3).map(([f, n]) => `${f} (${n})`).join(', ') || 'n/d'}. Color original: distancia mínima garantizada a los ${st.brandColors.length} colores de marca de las referencias y contraste AA.`,
      references: refs,
    },
    {
      area: 'Tipografía',
      decision: `${design.tokens.headingFont} / ${design.tokens.bodyFont}`,
      justification: `Estilo predominante en el sector: ${st.typographyStyle}; se evitan las fuentes de titulares más usadas por la competencia (${st.fonts.slice(0, 3).map(([f]) => f).join(', ') || 'n/d'}).`,
      references: refs,
    },
    {
      area: 'Conversión',
      decision: 'Formulario de contacto, teléfono clicable y CTA repetido',
      justification: `Prevalencia: formularios ${pct(st.conversionPrevalence.forms)}, teléfono ${pct(st.conversionPrevalence.phone)}, WhatsApp ${pct(st.conversionPrevalence.whatsapp)}, reseñas ${pct(st.conversionPrevalence.reviews)}`,
      references: refs,
    },
    ...design.rationale.map((r) => ({ area: 'Diseño (IA)', decision: r, justification: 'Razonamiento de GPT-6 Luna con las skills de diseño', references: [] })),
  ];
}
