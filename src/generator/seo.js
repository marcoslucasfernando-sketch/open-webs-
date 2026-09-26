import { escapeHtml } from '../lib/util.js';

export const pagePath = (slug) => (slug ? `/${slug}/` : '/');

export function headTags(page, spec, ctx) {
  const url = ctx.baseUrl ? `${ctx.baseUrl.replace(/\/$/, '')}${pagePath(page.slug)}` : '';
  const t = escapeHtml(page.metaTitle || spec.business.name);
  const d = escapeHtml(page.metaDescription || spec.business.description || '');
  return [
    `<title>${t}</title>`,
    `<meta name="description" content="${d}">`,
    url && `<link rel="canonical" href="${escapeHtml(url)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:locale" content="es_ES">`,
    `<meta property="og:site_name" content="${escapeHtml(spec.business.name)}">`,
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    url && `<meta property="og:url" content="${escapeHtml(url)}">`,
    `<meta name="twitter:card" content="summary">`,
    ctx.mode !== 'publish' && `<meta name="robots" content="noindex, nofollow">`,
    ctx.buildId && `<meta name="generator" content="open-webs ${escapeHtml(ctx.buildId)}">`,
  ]
    .filter(Boolean)
    .join('\n');
}

// Datos estructurados: tipo de negocio del sector (LocalBusiness y subtipos), FAQPage y migas de pan.
export function jsonLd(page, spec, ctx) {
  const b = spec.business;
  const base = ctx.baseUrl ? ctx.baseUrl.replace(/\/$/, '') : undefined;
  const graph = [];
  const business = {
    '@type': ctx.schemaType || 'LocalBusiness',
    '@id': base ? `${base}/#negocio` : undefined,
    name: b.name,
    description: b.description,
    url: base ? `${base}/` : undefined,
    telephone: b.phone || undefined,
    email: b.email || undefined,
    areaServed: b.location || undefined,
    address: b.address || b.location ? { '@type': 'PostalAddress', streetAddress: b.address || undefined, addressLocality: b.city || b.location || undefined, addressCountry: 'ES' } : undefined,
    geo: b.lat && b.lon ? { '@type': 'GeoCoordinates', latitude: b.lat, longitude: b.lon } : undefined,
    sameAs: b.sameAs?.length ? b.sameAs : undefined,
  };
  if (page.type === 'home') graph.push(business);
  else graph.push({ '@type': 'WebPage', name: page.metaTitle, about: base ? { '@id': `${base}/#negocio` } : b.name });

  const faqs = (page.sections || []).filter((s) => s.type === 'faq').flatMap((s) => s.items || []).filter((i) => i.q && i.a && !/\[\[/.test(i.q + i.a));
  if (faqs.length) {
    graph.push({ '@type': 'FAQPage', mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });
  }
  if (page.slug && base) {
    graph.push({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Inicio', item: `${base}/` },
        { '@type': 'ListItem', position: 2, name: page.navLabel, item: `${base}${pagePath(page.slug)}` },
      ],
    });
  }
  const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, (k, v) => (v === undefined ? undefined : v));
  return `<script type="application/ld+json">${json.replace(/</g, '\\u003c')}</script>`;
}

export function sitemap(spec, baseUrl) {
  const base = baseUrl.replace(/\/$/, '');
  const today = new Date().toISOString().slice(0, 10);
  const urls = spec.pages.map((p) => `  <url><loc>${escapeHtml(base + pagePath(p.slug))}</loc><lastmod>${today}</lastmod><priority>${p.slug ? '0.8' : '1.0'}</priority></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

export function robots(baseUrl, mode) {
  if (mode !== 'publish') return 'User-agent: *\nDisallow: /\n';
  return `User-agent: *\nAllow: /\n${baseUrl ? `Sitemap: ${baseUrl.replace(/\/$/, '')}/sitemap.xml\n` : ''}`;
}
