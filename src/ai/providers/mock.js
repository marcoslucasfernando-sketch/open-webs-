import { resolveSector } from '../../lib/sectors.js';
import { countBy } from '../../lib/util.js';

// Proveedor determinista sin red: permite ejecutar la plataforma completa (demo, tests, CI) sin credenciales.
// Produce resultados plausibles a partir de los datos de entrada; no sustituye la calidad de un LLM real.
export class MockProvider {
  constructor({ model = 'mock' } = {}) {
    this.name = 'mock';
    this.model = model;
  }

  async listModels() {
    return ['mock'];
  }

  async generateJSON({ task, input }) {
    const fn = handlers[task];
    if (!fn) throw new Error(`Mock: tarea no soportada "${task}"`);
    return structuredClone(fn(input));
  }
}

const handlers = {
  analyzeReference({ reference }) {
    const formality = reference.tone?.formality || 'neutral';
    const conv = reference.conversion || {};
    const strengths = [];
    const weaknesses = [];
    if (conv.forms) strengths.push('Formulario de contacto visible');
    else weaknesses.push('Sin formulario de contacto');
    if (conv.reviews) strengths.push('Muestra prueba social (reseñas/testimonios)');
    else weaknesses.push('No muestra prueba social');
    if (conv.phone || conv.whatsapp) strengths.push('Contacto directo por teléfono o WhatsApp');
    if (conv.booking) strengths.push('Reserva online');
    if ((reference.ctas || []).length === 0) weaknesses.push('CTAs poco claros');
    return {
      toneSummary: formality === 'tú' ? 'Cercano y directo, tutea al visitante' : formality === 'usted' ? 'Formal y profesional, trata de usted' : 'Neutro e informativo',
      formality,
      valueProposition: reference.description || reference.headings?.[0] || 'No explícita',
      targetAudience: 'Clientes locales que buscan el servicio en su zona',
      strengths,
      weaknesses,
      designMap: {
        palette: (reference.colors?.brand || []).slice(0, 3).map((c) => `${c.hex} (${c.family})`),
        typeScale: (reference.fonts || []).map((f) => f.name).join(' / ') || 'fuentes del sistema',
        spacing: reference.design?.sectionGaps?.length ? 'secciones con separación medida' : 'no medido',
        composition: (reference.sections || []).join(' → '),
        components: (reference.ctas || []).slice(0, 3).map((c) => `Botón "${c}"`),
        motion: reference.design?.transitions?.length ? 'transiciones presentes' : 'sin motion destacable',
      },
      tasteDna: [
        { trigger: 'Primer pantallazo', decision: reference.conversion?.phone ? 'Teléfono visible arriba' : 'CTA textual en el hero', reason: 'Reducir fricción al contacto', evidence: (reference.ctas || [])[0] || 'n/d', rejected: 'Formulario largo como único canal' },
      ],
    };
  },

  sectorMasterPrompt({ sector, location, stats, analyses }) {
    const profile = resolveSector(sector);
    const formality = countBy(analyses.map((a) => a.formality))[0]?.[0] || 'neutral';
    const sections = (stats.typicalOrder || []).filter((t) => t !== 'footer');
    return {
      sectorSummary: `Las webs de ${profile.label.toLowerCase()}${location ? ` en ${location}` : ''} priorizan mostrar rápidamente qué ofrecen, generar confianza y facilitar el contacto. El ${pct(stats.conversionPrevalence?.forms)} incluye formulario y el ${pct(stats.conversionPrevalence?.reviews)} muestra reseñas.`,
      targetAudience: ['Particulares de la zona que comparan opciones antes de decidir', 'Clientes que buscan desde el móvil y quieren contactar al momento'],
      valueProposition: `Un servicio de ${profile.label.toLowerCase()} cercano, fiable y fácil de contratar.`,
      tone: {
        description: formality === 'usted' ? 'Profesional y respetuoso' : 'Cercano, claro y profesional',
        formality,
        dos: ['Frases cortas y concretas', 'Beneficios antes que características', 'Mencionar la zona de servicio'],
        donts: ['Tecnicismos sin explicar', 'Promesas no verificables', 'Textos genéricos intercambiables'],
      },
      recommendedSections: (sections.length ? sections : ['hero', 'services', 'about', 'testimonials', 'faq', 'contact']).map((type) => ({ type, purpose: SECTION_PURPOSE[type] || 'Apoyar la conversión' })),
      ctaGuidelines: [profile.cta, 'Llamar ahora', 'Escríbenos por WhatsApp'],
      conversionElements: Object.entries(stats.conversionPrevalence || {}).filter(([, v]) => v >= 0.4).map(([k]) => k),
      designGuidelines: {
        colorFamilies: (stats.colorFamilies || []).slice(0, 3).map(([f]) => f),
        typographyStyle: stats.typographyStyle || profile.typography,
        imagery: 'Fotografía real del equipo, el local y el trabajo; evitar bancos de imágenes genéricos',
        layout: 'Hero con propuesta de valor y CTA visible sin hacer scroll; secciones cortas; contacto siempre accesible',
      },
      seoKeywords: [profile.label.toLowerCase(), location ? `${profile.label.toLowerCase()} ${location}` : null, ...profile.services.map(([t]) => t.toLowerCase())].filter(Boolean),
      bestPractices: [
        'CTA principal repetido en cabecera, hero y final de página',
        'Teléfono clicable y botón de WhatsApp en móvil',
        'Prueba social real (reseñas verificables) cerca de los CTAs',
        'Datos NAP (nombre, dirección, teléfono) consistentes para SEO local',
        'Tiempo de carga bajo: imágenes optimizadas y sin scripts innecesarios',
      ],
      designDna: [
        'Claridad sobre densidad: pocas secciones con un único mensaje cada una',
        'Contacto inmediato sobre formularios largos: teléfono/WhatsApp visibles',
      ],
    };
  },

  siteContent({ business, synthesis }) {
    const profile = resolveSector(business.sector);
    const loc = business.location ? ` en ${business.location}` : '';
    const name = business.name;
    const tu = (synthesis?.tone?.formality || 'tú') !== 'usted';
    const t = (a, b) => (tu ? a : b);
    const cta = synthesis?.ctaGuidelines?.[0] || profile.cta;
    const desc = business.description?.trim();
    const services = profile.services.map(([title, text]) => ({ title, text }));
    const keywords = [...new Set([...(synthesis?.seoKeywords || []), name.toLowerCase()])].slice(0, 10);
    const faq = [
      { q: t('¿Cómo puedo contactar con vosotros?', '¿Cómo puedo contactar con ustedes?'), a: `Puedes llamarnos, escribirnos por el formulario de contacto o visitarnos${loc}. Respondemos lo antes posible.` },
      { q: '¿Qué zona cubrís?', a: business.location ? `Trabajamos principalmente en ${business.location} y alrededores.` : '[[PENDIENTE: indica tu zona de servicio]]' },
      { q: '¿Cuál es el horario?', a: '[[PENDIENTE: horario de apertura]]' },
    ];
    const hero = {
      type: 'hero',
      heading: profile.promise || name,
      subheading: desc || `${t('Te ofrecemos', 'Le ofrecemos')} ${profile.services.slice(0, 2).map(([s]) => s.toLowerCase()).join(' y ')} con un trato cercano y profesional.`,
      cta: { label: cta, href: '/contacto/' },
    };
    const contactSection = { type: 'contact', heading: t('Hablemos', 'Contacte con nosotros'), body: `${t('Cuéntanos', 'Cuéntenos')} qué necesitas y te responderemos con una propuesta clara.`, cta: { label: 'Enviar mensaje', href: '#' } };
    return {
      business: { name, tagline: `${profile.label}${loc}`, description: desc || `${name} es un negocio de ${profile.label.toLowerCase()}${loc}.` },
      keywords,
      pages: [
        {
          slug: '', type: 'home', navLabel: 'Inicio',
          metaTitle: clip(`${name} | ${profile.label}${loc}`, 60),
          metaDescription: clip(`${name}: ${profile.services.slice(0, 3).map(([s]) => s.toLowerCase()).join(', ')}${loc}. ${cta} hoy mismo.`, 155),
          sections: [
            hero,
            { type: 'services', heading: t('Lo que hacemos por ti', 'Nuestros servicios'), items: services.slice(0, 4), cta: { label: 'Ver todos los servicios', href: '/servicios/' } },
            { type: 'features', heading: `Por qué elegir ${name}`, items: [
              { title: 'Trato cercano', text: 'Hablamos claro y sin letra pequeña.' },
              { title: 'Profesionales', text: '[[PENDIENTE: experiencia, titulación o certificaciones reales]]' },
              { title: business.location ? `En ${business.location}` : 'Cerca de ti', text: 'Conocemos la zona y a nuestros clientes.' },
            ] },
            { type: 'testimonials', heading: 'Opiniones de clientes', items: [{ title: '[[PENDIENTE: nombre del cliente]]', text: '[[PENDIENTE: pega aquí una reseña real de Google o de un cliente]]' }] },
            { type: 'faq', heading: 'Preguntas frecuentes', items: faq },
            { type: 'cta', heading: t('¿Empezamos?', '¿Le ayudamos?'), body: `${cta} en menos de un minuto.`, cta: { label: cta, href: '/contacto/' } },
          ],
        },
        {
          slug: 'servicios', type: 'services', navLabel: 'Servicios',
          metaTitle: clip(`Servicios de ${profile.label.toLowerCase()}${loc} | ${name}`, 60),
          metaDescription: clip(`Descubre los servicios de ${name}${loc}: ${profile.services.map(([s]) => s.toLowerCase()).join(', ')}.`, 155),
          sections: [
            { type: 'hero', heading: 'Servicios', subheading: `Todo lo que ${name} puede hacer por ${t('ti', 'usted')}.` },
            { type: 'services', heading: 'Qué ofrecemos', items: services },
            { type: 'process', heading: 'Cómo trabajamos', items: [
              { title: '1. Contacto', text: `${t('Nos cuentas', 'Nos cuenta')} qué necesitas.` },
              { title: '2. Propuesta', text: 'Te damos una solución y un presupuesto claros.' },
              { title: '3. Servicio', text: 'Lo hacemos con cuidado y te mantenemos informado.' },
            ] },
            { type: 'cta', heading: `¿Buscas ${profile.label.toLowerCase()}${loc}?`, body: 'Estamos a un mensaje de distancia.', cta: { label: cta, href: '/contacto/' } },
          ],
        },
        {
          slug: 'sobre-nosotros', type: 'about', navLabel: 'Sobre nosotros',
          metaTitle: clip(`Sobre ${name} | ${profile.label}${loc}`, 60),
          metaDescription: clip(`Conoce a ${name}, ${profile.label.toLowerCase()}${loc}: quiénes somos y cómo trabajamos.`, 155),
          sections: [
            { type: 'hero', heading: `Sobre ${name}`, subheading: 'Quiénes somos y qué nos mueve.' },
            { type: 'about', heading: 'Nuestra historia', body: desc ? `${desc}\n\n[[PENDIENTE: añade la historia del negocio, fundadores y año de apertura]]` : '[[PENDIENTE: cuenta la historia del negocio, fundadores y año de apertura]]' },
            { type: 'features', heading: 'Nuestros valores', items: [
              { title: 'Honestidad', text: 'Te decimos lo que necesitas, ni más ni menos.' },
              { title: 'Cuidado', text: 'Cada cliente recibe atención personal.' },
              { title: 'Compromiso local', text: business.location ? `Orgullosos de trabajar en ${business.location}.` : 'Orgullosos de nuestra comunidad.' },
            ] },
          ],
        },
        {
          slug: 'contacto', type: 'contact', navLabel: 'Contacto',
          metaTitle: clip(`Contacto | ${name}${loc}`, 60),
          metaDescription: clip(`Contacta con ${name}${loc}. ${cta} por teléfono, email o formulario.`, 155),
          sections: [contactSection, { type: 'map', heading: 'Dónde estamos', body: business.address || business.location || '[[PENDIENTE: dirección]]' }],
        },
      ],
    };
  },

  siteDesign({ business, baseTokens, masterPrompt }) {
    const variants = ['split', 'centered', 'editorial'];
    const h = [...String(business.name)].reduce((a, c) => a + c.charCodeAt(0), 0);
    return {
      tokens: baseTokens,
      heroVariant: variants[h % variants.length],
      css: '',
      rationale: [
        `Paleta derivada de la familia dominante del sector con tono propio (${baseTokens.primary}) y contraste AA`,
        `Pareja tipográfica ${baseTokens.headingFont} / ${baseTokens.bodyFont} acorde al estilo del sector sin repetir la de la competencia`,
        /tú/.test(String(masterPrompt)) ? 'Composición cercana: frases cortas y CTA visible sin scroll' : 'Composición sobria orientada a la confianza',
      ],
    };
  },

  designReview() {
    return { score: null, issues: [], fixesCss: '' };
  },

  figmaImport() {
    return { tokens: {}, notes: ['Mock: sin acceso a Figma'] };
  },

  selectImages({ business, candidates }) {
    const sorted = [...candidates].sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
    const landscape = sorted.find((c) => (c.width || 0) >= (c.height || 0) * 1.2) || sorted[0];
    const rest = sorted.filter((c) => c !== landscape);
    return {
      hero: landscape ? landscape.index : null,
      about: rest[0] ? rest[0].index : null,
      gallery: rest.slice(1, 7).map((c) => c.index),
      alts: Object.fromEntries(candidates.map((c) => [c.index, c.alt || `${business.name}: foto ${c.index + 1}`])),
      rejected: [],
    };
  },

  rewriteSection({ text }) {
    const parts = String(text).split(/(?<=[.!?])\s+/).filter(Boolean);
    return { text: parts.length > 1 ? [...parts.slice(1), parts[0]].join(' ') : text };
  },

  outreachEmail({ place, demoUrl, sender }) {
    const has = Boolean(place.website);
    return {
      subject: has ? `Una propuesta de nueva web para ${place.name}` : `Hemos preparado una web de muestra para ${place.name}`,
      body: [
        `Hola, equipo de ${place.name}:`,
        '',
        has
          ? `Soy ${sender.name}, de ${sender.company}. He visto vuestra web y he preparado, sin compromiso, una propuesta de rediseño pensada para ${place.sector ? place.sector.toLowerCase() : 'vuestro negocio'}${place.city ? ` en ${place.city}` : ''}.`
          : `Soy ${sender.name}, de ${sender.company}. No he encontrado una web de ${place.name}, así que he preparado una de muestra, sin compromiso, para que veáis cómo podría quedar.`,
        '',
        `Podéis verla aquí: ${demoUrl}`,
        '',
        'Si os gusta, la dejamos publicada con vuestro dominio y los textos revisados con vosotros. Si no os interesa, no volveré a escribiros.',
      ].join('\n'),
    };
  },
};

const SECTION_PURPOSE = {
  hero: 'Presentar la propuesta de valor y el CTA principal', services: 'Mostrar la oferta de forma escaneable',
  about: 'Generar confianza con la historia y el equipo', testimonials: 'Prueba social verificable',
  pricing: 'Resolver la duda del precio', faq: 'Resolver objeciones frecuentes', contact: 'Facilitar el contacto inmediato',
  gallery: 'Mostrar trabajos o instalaciones reales', team: 'Humanizar la marca', booking: 'Permitir reservar online',
  map: 'Ubicación y SEO local', cta: 'Cierre con llamada a la acción', features: 'Diferenciación frente a competidores',
  process: 'Explicar cómo se trabaja', blog: 'Contenido para SEO',
};

const pct = (v) => `${Math.round((v || 0) * 100)} %`;
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
