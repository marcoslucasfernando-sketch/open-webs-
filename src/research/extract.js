import * as cheerio from 'cheerio';
import { parseColor, toHex, isNeutral, hueFamily } from '../lib/color.js';
import { countBy, normalizeText } from '../lib/util.js';

// Diccionario de tipos de sección canónicos (es/en) para clasificar encabezados, ids y clases.
const SECTION_PATTERNS = [
  ['services', /servicio|service|tratamiento|especialidad|que hacemos|what we do|carta|menu|productos|oferta/],
  ['about', /sobre nosotros|quienes somos|nosotros|about|historia|nuestra empresa|conocenos/],
  ['testimonials', /testimoni|opinion|resena|review|valoracion|clientes dicen|lo que dicen/],
  ['pricing', /precio|tarifa|pricing|planes|presupuesto|bono/],
  ['faq', /faq|preguntas|dudas frecuentes/],
  ['contact', /contact|escribenos|llamanos|donde estamos|ubicacion|como llegar/],
  ['gallery', /galeria|gallery|portfolio|proyectos|trabajos|instalaciones|fotos/],
  ['team', /equipo|team|profesionales|staff|doctores|abogados/],
  ['booking', /reserva|booking|cita online|pide cita|agenda/],
  ['blog', /blog|noticias|articulos|news/],
  ['features', /por que elegir|ventajas|why choose|beneficios|diferencia|garantia/],
  ['process', /como trabajamos|proceso|paso a paso|metodo|how it works/],
  ['map', /mapa|map|localizacion/],
];

const CTA_CLASS = /btn|button|boton|cta|call-to-action/i;
const CTA_TEXT = /reserv|cita|contact|llam|presupuesto|solicit|pide|compr|book|call|get|empez|descubr|ver m[aá]s|whatsapp|consult|inscr|prueba|valora/i;

export function extractFeatures(html, { url, css = '' } = {}) {
  const $ = cheerio.load(html);
  const inlineCss = $('style').map((_, el) => $(el).html()).get().join('\n');
  const styleAttrs = $('[style]').map((_, el) => $(el).attr('style')).get().join(';');
  const allCss = `${inlineCss}\n${styleAttrs}\n${css}`;

  $('script, noscript, svg, iframe').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();

  const headings = $('h1, h2, h3')
    .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
    .get()
    .filter((h) => h.length > 1 && h.length < 140);

  const nav = $('nav a, header a')
    .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
    .get()
    .filter((t) => t && t.length < 40);

  return {
    url,
    title: $('title').first().text().trim(),
    description: $('meta[name="description"]').attr('content')?.trim() || '',
    lang: $('html').attr('lang') || '',
    headings: headings.slice(0, 40),
    nav: [...new Set(nav)].slice(0, 20),
    sections: detectSections($, headings),
    colors: extractColors(allCss, $),
    fonts: extractFonts(allCss, $),
    ctas: extractCtas($),
    conversion: detectConversion($, text, html),
    tone: detectTone(text),
    schemaTypes: extractSchemaTypes($),
    emails: extractEmails($, html),
    phones: [...new Set($('a[href^="tel:"]').map((_, el) => $(el).attr('href').slice(4).replace(/\s/g, '')).get())].slice(0, 3),
    stylesheets: $('link[rel="stylesheet"]').map((_, el) => $(el).attr('href')).get().slice(0, 5),
    wordCount: text.split(' ').length,
    textSample: text.slice(0, 3000),
  };
}

function classify(label) {
  const t = normalizeText(label);
  for (const [type, re] of SECTION_PATTERNS) if (re.test(t)) return type;
  return null;
}

// Orden de secciones: hero (si hay h1 o bloque destacado al inicio) + secciones detectadas por landmarks y encabezados.
function detectSections($, headings) {
  const order = [];
  const push = (t) => t && !order.includes(t) && order.push(t);
  if ($('h1').length || $('[class*="hero"], [id*="hero"], [class*="banner"]').length) push('hero');
  $('section, [id], main > div, article').each((_, el) => {
    const node = $(el);
    const label = `${node.attr('id') || ''} ${node.attr('class') || ''} ${node.find('h2, h3').first().text()}`;
    push(classify(label));
  });
  for (const h of headings) push(classify(h));
  if ($('form').length) push('contact');
  if ($('footer').length) push('footer');
  return order;
}

function extractColors(css, $) {
  const found = [];
  const re = /#[0-9a-f]{3,8}\b|rgba?\([^)]+\)/gi;
  for (const m of css.matchAll(re)) {
    const rgb = parseColor(m[0]);
    if (rgb) found.push(toHex(rgb));
  }
  const theme = $('meta[name="theme-color"]').attr('content');
  if (theme && parseColor(theme)) found.push(toHex(parseColor(theme)), toHex(parseColor(theme)));
  const counted = countBy(found).map(([hex, count]) => ({ hex, count, family: hueFamily(hex) }));
  const brand = counted.filter((c) => !isNeutral(parseColor(c.hex)));
  return {
    all: counted.slice(0, 20),
    brand: brand.slice(0, 6),
    primary: brand[0]?.hex || null,
    families: countBy(brand.slice(0, 6), (c) => c.family).map(([f]) => f),
  };
}

const GENERIC_FONTS = new Set(['sans-serif', 'serif', 'monospace', 'cursive', 'system-ui', 'inherit', 'initial', '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'arial', 'helvetica', 'helvetica neue', 'roboto', 'ui-sans-serif', 'var']);

function extractFonts(css, $) {
  const fonts = [];
  for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    const first = m[1].split(',')[0].trim().replace(/^['"]|['"]$/g, '');
    if (first && !GENERIC_FONTS.has(first.toLowerCase()) && !first.startsWith('var(')) fonts.push(first);
  }
  $('link[href*="fonts.googleapis.com"]').each((_, el) => {
    const href = $(el).attr('href');
    for (const m of href.matchAll(/family=([^&:]+)/g)) fonts.push(decodeURIComponent(m[1]).replace(/\+/g, ' '));
  });
  return countBy(fonts).map(([name, count]) => ({ name, count, style: fontStyle(name) })).slice(0, 6);
}

const SERIF = /playfair|merriweather|lora|garamond|georgia|times|libre baskerville|cormorant|crimson|pt serif|noto serif|dm serif|fraunces|source serif/i;
const DISPLAY = /bebas|oswald|anton|abril|pacifico|lobster|righteous|archivo black|dancing|great vibes|satisfy|montserrat alternates|syne|unbounded/i;
export const fontStyle = (name) => (SERIF.test(name) ? 'serif' : DISPLAY.test(name) ? 'display' : 'sans');

function extractCtas($) {
  const ctas = [];
  $('a, button, input[type="submit"]').each((_, el) => {
    const node = $(el);
    const label = (node.text() || node.attr('value') || '').replace(/\s+/g, ' ').trim();
    if (!label || label.length > 40) return;
    const cls = `${node.attr('class') || ''} ${node.attr('role') || ''}`;
    if (CTA_CLASS.test(cls) || node.is('button, input') || CTA_TEXT.test(label)) {
      if (CTA_TEXT.test(label) || CTA_CLASS.test(cls)) ctas.push(label);
    }
  });
  return countBy(ctas, (c) => c.charAt(0).toUpperCase() + c.slice(1).toLowerCase()).map(([t]) => t).slice(0, 10);
}

function detectConversion($, text, html) {
  const t = normalizeText(text);
  const forms = $('form').length;
  const formFields = [...new Set($('form input, form textarea, form select').map((_, el) => $(el).attr('name') || $(el).attr('type')).get().filter(Boolean))].slice(0, 10);
  return {
    forms,
    formFields,
    reviews: /resena|opinion|testimoni|valoraci|estrellas|review|★/.test(t) || /AggregateRating|"Review"/.test(html),
    pricing: /(\d+[.,]?\d*)\s?(€|eur)|€\s?\d+|precio|tarifa/.test(t),
    phone: $('a[href^="tel:"]').length > 0,
    whatsapp: /wa\.me|api\.whatsapp\.com|whatsapp/i.test(html),
    booking: /reserva online|reservar|booking|pide cita|cita online|calendly|doctoralia|thefork|opentable/i.test(html),
    map: /google\.com\/maps|maps\.google|openstreetmap|leaflet/i.test(html),
    newsletter: /newsletter|suscr[ií]bete/i.test(t),
    chat: /tawk|crisp|intercom|livechat|zendesk|hubspot-messages/i.test(html),
    socialLinks: $('a[href*="instagram.com"], a[href*="facebook.com"], a[href*="tiktok.com"], a[href*="linkedin.com"]').length > 0,
  };
}

function detectTone(text) {
  const t = normalizeText(text);
  const words = t.split(' ').length || 1;
  const tu = (t.match(/\b(tu|tus|te|contigo|puedes|quieres|necesitas|llamanos|escribenos|descubre|reserva)\b/g) || []).length;
  const usted = (t.match(/\b(usted|ustedes|su empresa|le ofrecemos|le atenderemos|contacte|solicite|puede usted)\b/g) || []).length;
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().split(' ').length > 2);
  const avgSentenceLength = sentences.length ? Math.round(sentences.reduce((a, s) => a + s.trim().split(/\s+/).length, 0) / sentences.length) : 0;
  return {
    formality: tu > usted * 1.5 ? 'tú' : usted > tu ? 'usted' : 'neutral',
    avgSentenceLength,
    exclamationsPer1000: Math.round(((text.match(/!/g) || []).length / words) * 1000),
    firstPersonPlural: (t.match(/\b(nosotros|nuestro|nuestra|nuestros|ofrecemos|somos)\b/g) || []).length > 3,
  };
}

function extractSchemaTypes($) {
  const types = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const walk = (n) => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (n && typeof n === 'object') {
          if (n['@type']) types.push(...[].concat(n['@type']));
          if (n['@graph']) walk(n['@graph']);
        }
      };
      walk(JSON.parse($(el).html()));
    } catch {}
  });
  return [...new Set(types)];
}

export function extractEmails($, html) {
  const set = new Set();
  $('a[href^="mailto:"]').each((_, el) => set.add($(el).attr('href').slice(7).split('?')[0].trim().toLowerCase()));
  for (const m of html.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) set.add(m[0].toLowerCase());
  return [...set].filter((e) => !/\.(png|jpe?g|gif|webp|svg)$/.test(e) && !/example\.|sentry|wixpress|@2x/.test(e)).slice(0, 5);
}

// CSS externos enlazados (para colores y fuentes): devuelve URLs absolutas.
export function stylesheetUrls(features, base) {
  return (features.stylesheets || [])
    .map((href) => {
      try {
        return new URL(href, base).toString();
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .slice(0, 3);
}
