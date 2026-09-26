import { escapeHtml, seededRandom } from '../lib/util.js';
import { googleFontsHref, sanitizeCss } from './design.js';
import { headTags, jsonLd, sitemap, robots, pagePath } from './seo.js';

const PLACEHOLDER = /\[\[PENDIENTE:[^\]]*\]\]/g;
const HAS_PLACEHOLDER = /\[\[PENDIENTE/;

// Renderiza la especificación del sitio a ficheros estáticos { ruta: contenido }.
// mode: preview (marcadores visibles) | demo (sin marcadores, noindex, banner de demo) | publish (indexable).
export function renderSite(spec, design, ctx = {}) {
  const mode = ctx.mode || 'preview';
  const files = {};
  const s = mode === 'preview' ? spec : stripPlaceholders(spec);
  for (const page of s.pages) {
    const file = page.slug ? `${page.slug}/index.html` : 'index.html';
    files[file] = renderPage(page, s, design, { ...ctx, mode });
  }
  files['styles.css'] = stylesheet(design);
  files['site.js'] = SITE_JS;
  files['404.html'] = renderPage({ slug: '404', type: 'notfound', navLabel: '404', metaTitle: `Página no encontrada · ${s.business.name}`, metaDescription: '', sections: [{ type: 'hero', heading: 'No encontramos esta página', subheading: 'Puede que el enlace haya cambiado.', cta: { label: 'Volver al inicio', href: '/' } }] }, s, design, { ...ctx, mode, depth: 0 });
  files['robots.txt'] = robots(ctx.baseUrl, mode);
  if (ctx.baseUrl) files['sitemap.xml'] = sitemap(s, ctx.baseUrl);
  files['favicon.svg'] = favicon(s.business.name, design.tokens);
  Object.assign(files, ctx.assets || {});
  return files;
}

export function countPlaceholders(spec) {
  return (JSON.stringify(spec).match(PLACEHOLDER) || []).length;
}

// Quita frases con marcadores pendientes; elimina ítems/secciones que queden vacíos (p. ej. testimonios sin reseñas reales).
export function stripPlaceholders(spec) {
  const clean = (t) =>
    String(t || '')
      .split(/\n+/)
      .map((para) => para.split(/(?<=[.!?])\s+/).filter((x) => !HAS_PLACEHOLDER.test(x)).join(' '))
      .filter(Boolean)
      .join('\n\n')
      .replace(PLACEHOLDER, '')
      .trim();
  const out = structuredClone(spec);
  for (const page of out.pages) {
    page.sections = (page.sections || [])
      .map((sec) => {
        for (const k of ['heading', 'subheading', 'body']) if (sec[k]) sec[k] = clean(sec[k]);
        if (sec.items) sec.items = sec.items.filter((it) => !Object.values(it).some((v) => typeof v === 'string' && HAS_PLACEHOLDER.test(v)));
        return sec;
      })
      .filter((sec) => !(sec.type === 'testimonials' && !(sec.items || []).length))
      .filter((sec) => sec.heading || sec.body || (sec.items || []).length || ['contact', 'map'].includes(sec.type));
  }
  return out;
}

function rel(fromSlug, href) {
  if (!href || /^(https?:|mailto:|tel:|#)/.test(href)) return href || '#';
  const depth = fromSlug ? fromSlug.split('/').length : 0;
  const target = href.replace(/^\//, '');
  return `${'../'.repeat(depth)}${target}` || './';
}

function text(t, mode) {
  const html = escapeHtml(t).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');
  return mode === 'preview' ? html.replace(/\[\[PENDIENTE:([^\]]*)\]\]/g, '<mark class="todo" title="Completa este dato">$1</mark>') : html;
}

function renderPage(page, spec, design, ctx) {
  const { mode } = ctx;
  const root = rel(page.slug === '404' ? '' : page.slug, '/');
  const nav = spec.pages
    .map((p) => `<a href="${rel(page.slug === '404' ? '' : page.slug, pagePath(p.slug))}"${p.slug === page.slug ? ' aria-current="page"' : ''}>${escapeHtml(p.navLabel)}</a>`)
    .join('');
  const primaryCta = spec.pages.find((p) => p.type === 'home')?.sections?.find((s) => s.type === 'hero')?.cta;
  const body = (page.sections || []).map((sec, i) => renderSection(sec, i, page, spec, design, ctx)).join('\n');
  const b = spec.business;
  const banner =
    mode === 'demo'
      ? `<div class="demo-banner" role="note">Demo de propuesta creada para ${escapeHtml(b.name)} · No es la web oficial del negocio</div>`
      : '';
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${headTags(page, spec, ctx)}
<meta name="theme-color" content="${design.tokens.primary}">
<link rel="icon" href="${root}favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${googleFontsHref(design.tokens)}">
<link rel="stylesheet" href="${root}styles.css">
${page.type === 'notfound' ? '' : jsonLd(page, spec, ctx)}
</head>
<body class="hero-${escapeHtml(design.heroVariant || 'split')}">
${banner}
<a class="skip" href="#contenido">Saltar al contenido</a>
<header class="site-header">
  <div class="container site-header__inner">
    <a class="brand${spec.media?.logo ? ' brand--logo' : ''}" href="${root}">${spec.media?.logo ? `<img src="${root}${spec.media.logo.file}" alt="${escapeHtml(b.name)}" height="44">` : escapeHtml(b.name)}</a>
    <button class="nav-toggle" aria-expanded="false" aria-controls="nav">Menú</button>
    <nav class="nav" id="nav" aria-label="Principal">${nav}${primaryCta ? `<a class="btn btn--primary btn--sm" href="${rel(page.slug === '404' ? '' : page.slug, primaryCta.href)}">${escapeHtml(primaryCta.label)}</a>` : ''}</nav>
  </div>
</header>
<main id="contenido">
${body}
</main>
<footer class="site-footer">
  <div class="container site-footer__inner">
    <div><p class="brand">${escapeHtml(b.name)}</p><p>${text(b.tagline || '', mode)}</p></div>
    <div>${b.address || b.location ? `<p>${escapeHtml(b.address || b.location)}</p>` : ''}${b.phone ? `<p><a href="tel:${escapeHtml(b.phone.replace(/\s/g, ''))}">${escapeHtml(b.phone)}</a></p>` : ''}${b.email ? `<p><a href="mailto:${escapeHtml(b.email)}">${escapeHtml(b.email)}</a></p>` : ''}</div>
    <nav aria-label="Pie">${nav}</nav>
  </div>
  <p class="container legal">© ${new Date().getFullYear()} ${escapeHtml(b.name)}</p>
</footer>
${b.whatsapp ? `<a class="wa-float" href="https://wa.me/${escapeHtml(String(b.whatsapp).replace(/\D/g, ''))}" aria-label="Escribir por WhatsApp">WhatsApp</a>` : ''}
<script src="${root}site.js" defer></script>
</body>
</html>
`;
}

function cta(c, page, cls = 'btn btn--primary') {
  return c?.label ? `<a class="${cls}" href="${rel(page.slug === '404' ? '' : page.slug, c.href)}">${escapeHtml(c.label)}</a>` : '';
}

function renderSection(sec, i, page, spec, design, ctx) {
  const { mode } = ctx;
  const h = (tag, t, cls = '') => (t ? `<${tag}${cls ? ` class="${cls}"` : ''}>${text(t, mode)}</${tag}>` : '');
  const alt = i % 2 === 1 ? ' section--alt' : '';
  const items = sec.items || [];
  switch (sec.type) {
    case 'hero': {
      const isHome = page.type === 'home';
      return `<section class="hero${isHome ? ' hero--home' : ' hero--page'}">
  <div class="container hero__inner">
    <div class="hero__copy reveal">
      ${isHome ? `<p class="eyebrow">${escapeHtml(spec.business.tagline || '')}</p>` : ''}
      ${h(isHome || page.type === 'notfound' ? 'h1' : 'h1', sec.heading)}
      ${h('p', sec.subheading, 'lead')}
      <div class="hero__actions">${cta(sec.cta, page)}${isHome && spec.business.phone ? `<a class="btn btn--ghost" href="tel:${escapeHtml(spec.business.phone.replace(/\s/g, ''))}">Llamar</a>` : ''}</div>
    </div>
    ${isHome ? (spec.media?.hero ? `<div class="hero__art hero__media reveal"><img src="${rel(page.slug, '/' + spec.media.hero.file)}" alt="${escapeHtml(spec.media.hero.alt)}" fetchpriority="high"></div>` : `<div class="hero__art reveal" aria-hidden="true">${heroArt(spec.business.name, design.tokens)}</div>`) : ''}
  </div>
</section>`;
    }
    case 'services':
    case 'features':
    case 'process':
      return `<section class="section${alt} section--${sec.type}">
  <div class="container">
    <div class="section__head reveal">${h('h2', sec.heading)}${h('p', sec.body || sec.subheading, 'lead')}</div>
    <div class="grid grid--${Math.min(items.length, 4) || 1}">
      ${items.map((it, n) => `<article class="card reveal" style="--i:${n}">${sec.type === 'process' ? '' : `<span class="card__index">${String(n + 1).padStart(2, '0')}</span>`}${h('h3', it.title)}${h('p', it.text)}</article>`).join('\n      ')}
    </div>
    ${sec.cta ? `<div class="section__foot reveal">${cta(sec.cta, page, 'btn btn--ghost')}</div>` : ''}
  </div>
</section>`;
    case 'about': {
      const img = spec.media?.about;
      return `<section class="section${alt} section--about"><div class="container${img ? ' about--media' : ''}"><div class="prose reveal">${h('h2', sec.heading)}<p>${text(sec.body, mode)}</p></div>${img ? `<figure class="about__img reveal"><img src="${rel(page.slug, '/' + img.file)}" alt="${escapeHtml(img.alt)}" loading="lazy"></figure>` : ''}</div></section>`;
    }
    case 'gallery': {
      const imgs = spec.media?.gallery || [];
      if (!imgs.length) return '';
      return `<section class="section${alt} section--gallery"><div class="container">
  <div class="section__head reveal">${h('h2', sec.heading || 'Galería')}</div>
  <div class="gallery gallery--n${imgs.length}">${imgs.map((im, n) => `<figure class="gallery__item reveal" style="--i:${n}"><img src="${rel(page.slug, '/' + im.file)}" alt="${escapeHtml(im.alt)}" loading="lazy"></figure>`).join('')}</div>
</div></section>`;
    }
    case 'testimonials':
      return `<section class="section${alt} section--testimonials"><div class="container">
  <div class="section__head reveal">${h('h2', sec.heading)}</div>
  <div class="grid grid--${Math.min(items.length, 3) || 1}">${items.map((it) => `<figure class="card quote reveal"><blockquote>${text(it.text, mode)}</blockquote><figcaption>${text(it.title, mode)}</figcaption></figure>`).join('')}</div>
</div></section>`;
    case 'faq':
      return `<section class="section${alt} section--faq"><div class="container narrow">
  <div class="section__head reveal">${h('h2', sec.heading)}</div>
  <div class="faq">${items.map((it) => `<details class="reveal"><summary>${text(it.q, mode)}</summary><p>${text(it.a, mode)}</p></details>`).join('')}</div>
</div></section>`;
    case 'cta':
      return `<section class="cta-band"><div class="container cta-band__inner reveal">${h('h2', sec.heading)}${h('p', sec.body)}${cta(sec.cta, page, 'btn btn--light')}</div></section>`;
    case 'contact': {
      const b = spec.business;
      const netlify = ctx.forms === 'netlify' ? ' data-netlify="true" netlify-honeypot="empresa"' : '';
      return `<section class="section section--contact"><div class="container contact">
  <div class="contact__info reveal">${h('h2', sec.heading)}${h('p', sec.body, 'lead')}
    <ul class="contact__list">${b.phone ? `<li><a href="tel:${escapeHtml(b.phone.replace(/\s/g, ''))}">${escapeHtml(b.phone)}</a></li>` : ''}${b.email ? `<li><a href="mailto:${escapeHtml(b.email)}">${escapeHtml(b.email)}</a></li>` : ''}${b.address || b.location ? `<li>${escapeHtml(b.address || b.location)}</li>` : ''}</ul>
  </div>
  <form class="form card reveal" name="contacto" method="POST" action="${ctx.formAction || '#'}"${netlify}>
    <input type="hidden" name="form-name" value="contacto"><p class="hp"><label>Empresa <input name="empresa" tabindex="-1" autocomplete="off"></label></p>
    <label>Nombre<input name="nombre" autocomplete="name" required></label>
    <label>Email<input name="email" type="email" autocomplete="email" required></label>
    <label>Teléfono<input name="telefono" type="tel" autocomplete="tel"></label>
    <label>Mensaje<textarea name="mensaje" rows="4" required></textarea></label>
    <label class="check"><input type="checkbox" name="privacidad" required> Acepto que usen mis datos para responder a mi consulta.</label>
    <button class="btn btn--primary" type="submit">${escapeHtml(sec.cta?.label || 'Enviar')}</button>
  </form>
</div></section>`;
    }
    case 'map': {
      const b = spec.business;
      const embed =
        b.lat && b.lon
          ? `<iframe class="map" title="Mapa" loading="lazy" src="https://www.openstreetmap.org/export/embed.html?bbox=${b.lon - 0.01}%2C${b.lat - 0.006}%2C${b.lon + 0.01}%2C${b.lat + 0.006}&amp;layer=mapnik&amp;marker=${b.lat}%2C${b.lon}"></iframe>`
          : '';
      return `<section class="section section--alt section--map"><div class="container reveal">${h('h2', sec.heading)}${h('p', sec.body, 'lead')}${embed}</div></section>`;
    }
    default:
      return `<section class="section${alt}"><div class="container prose reveal">${h('h2', sec.heading)}${h('p', sec.body)}</div></section>`;
  }
}

// Ilustración abstracta original (SVG) derivada del nombre del negocio y la paleta.
function heroArt(seed, t) {
  const r = seededRandom(`art|${seed}`);
  const shapes = [];
  for (let i = 0; i < 5; i++) {
    const cx = 60 + r() * 280, cy = 60 + r() * 280, rad = 40 + r() * 110;
    shapes.push(`<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${rad.toFixed(0)}" fill="${i % 2 ? t.accent : t.primary}" opacity="${(0.1 + r() * 0.22).toFixed(2)}"/>`);
  }
  const arcs = Array.from({ length: 4 }, (_, i) => `<path d="M ${40 + i * 18} 360 A ${160 - i * 22} ${160 - i * 22} 0 0 1 ${360 - i * 18} 360" fill="none" stroke="${t.primary}" stroke-width="1.5" opacity="${0.5 - i * 0.1}"/>`);
  return `<svg viewBox="0 0 400 400" role="img"><rect width="400" height="400" rx="28" fill="${t.surface}"/>${shapes.join('')}${arcs.join('')}</svg>`;
}

function favicon(name, t) {
  const letter = escapeHtml((name || '?').trim().charAt(0).toUpperCase());
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${t.primary}"/><text x="32" y="43" font-family="sans-serif" font-size="34" font-weight="700" text-anchor="middle" fill="${t.primaryInk}">${letter}</text></svg>`;
}

const SITE_JS = `(() => {
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.getElementById('nav');
  toggle?.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!open));
    nav.classList.toggle('is-open', !open);
  });
  const els = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    els.forEach((el) => el.classList.add('is-in'));
    return;
  }
  const io = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
  }), { rootMargin: '0px 0px -8% 0px' });
  els.forEach((el) => io.observe(el));
})();
`;

const SERIF_FONTS = /fraunces|serif|playfair|garamond|newsreader|lora|merriweather|cormorant|crimson|georgia/i;
const fallback = (font) => (SERIF_FONTS.test(font) ? 'ui-serif, Georgia, serif' : 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif');

export function stylesheet(design) {
  const t = design.tokens;
  return `:root{
  --c-primary:${t.primary};--c-primary-ink:${t.primaryInk};--c-accent:${t.accent};
  --c-bg:${t.bg};--c-surface:${t.surface};--c-text:${t.text};--c-muted:${t.muted};
  --c-line:color-mix(in srgb, var(--c-text) 12%, transparent);
  --font-heading:'${t.headingFont}', ${fallback(t.headingFont)};--font-body:'${t.bodyFont}', ${fallback(t.bodyFont)};
  --radius:${t.radius};--space:${t.space};--maxw:${t.maxWidth};
  --ease-out:cubic-bezier(.22,1,.36,1);--dur:220ms;
  --step-0:clamp(1rem,.96rem + .2vw,1.125rem);--step-1:clamp(1.2rem,1.1rem + .5vw,1.45rem);
  --step-2:clamp(1.5rem,1.3rem + 1vw,2.1rem);--step-3:clamp(2rem,1.6rem + 2vw,3.2rem);--step-4:clamp(2.25rem,1.6rem + 3.4vw,4.6rem);
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:var(--c-bg);color:var(--c-text);font:400 var(--step-0)/1.65 var(--font-body);text-rendering:optimizeLegibility;-webkit-font-smoothing:antialiased}
h1,h2,h3{font-family:var(--font-heading);line-height:1.08;letter-spacing:-.02em;margin:0 0 .5em;text-wrap:balance}
h1{font-size:var(--step-4);font-weight:650}h2{font-size:var(--step-3);font-weight:600}h3{font-size:var(--step-1);font-weight:600;letter-spacing:-.01em}
p{margin:0 0 1em;text-wrap:pretty}a{color:inherit}
img,svg{max-width:100%;display:block}
.container{width:min(100% - 2.5rem,var(--maxw));margin-inline:auto}.narrow{max-width:760px}
.skip{position:absolute;left:-999px;top:0;background:var(--c-text);color:var(--c-bg);padding:.6rem 1rem;z-index:100}.skip:focus{left:1rem}
:focus-visible{outline:2px solid var(--c-primary);outline-offset:3px;border-radius:4px}
.eyebrow{font-size:.8rem;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--c-primary);margin-bottom:1.1rem}
.lead{font-size:var(--step-1);line-height:1.5;color:var(--c-muted);max-width:60ch}
.site-header{position:sticky;top:0;z-index:50;background:color-mix(in srgb,var(--c-bg) 82%,transparent);backdrop-filter:saturate(1.4) blur(12px);border-bottom:1px solid var(--c-line)}
.site-header__inner{display:flex;align-items:center;justify-content:space-between;gap:1rem;min-height:72px}
.brand{font-family:var(--font-heading);font-weight:700;font-size:1.2rem;text-decoration:none;letter-spacing:-.01em}
.nav{display:flex;align-items:center;gap:1.6rem}
.nav a:not(.btn){text-decoration:none;font-size:.95rem;color:var(--c-muted);transition:color var(--dur) var(--ease-out)}
.nav a:not(.btn):hover,.nav a[aria-current=page]{color:var(--c-text)}
.nav-toggle{display:none;font:inherit;background:none;border:1px solid var(--c-line);border-radius:999px;padding:.45rem .95rem;color:var(--c-text)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;min-height:48px;padding:.8rem 1.4rem;border-radius:999px;font-weight:600;font-size:.98rem;text-decoration:none;border:1px solid transparent;cursor:pointer;transition:transform var(--dur) var(--ease-out),background-color var(--dur) var(--ease-out),box-shadow var(--dur) var(--ease-out)}
.btn:active{transform:scale(.97)}
.btn--primary{background:var(--c-primary);color:var(--c-primary-ink);box-shadow:0 1px 0 color-mix(in srgb,#fff 25%,transparent) inset,0 6px 20px -8px color-mix(in srgb,var(--c-primary) 70%,transparent)}
.btn--primary:hover{background:color-mix(in srgb,var(--c-primary) 88%,#000)}
.btn--ghost{border-color:var(--c-line);color:var(--c-text);background:transparent}.btn--ghost:hover{background:var(--c-surface)}
.btn--light{background:var(--c-bg);color:var(--c-text)}.btn--sm{min-height:40px;padding:.5rem 1.05rem;font-size:.9rem}
.hero{padding:clamp(3.5rem,8vw,7.5rem) 0 clamp(3rem,6vw,6rem)}
.hero__inner{display:grid;grid-template-columns:1.15fr .85fr;gap:clamp(2rem,5vw,5rem);align-items:center}
.hero--page .hero__inner{grid-template-columns:1fr}.hero--page{padding-bottom:1rem}
.hero__actions{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1.75rem}
.hero__art svg{width:100%;height:auto;border-radius:28px;box-shadow:0 30px 60px -30px color-mix(in srgb,var(--c-text) 35%,transparent)}
.hero-centered .hero__inner{grid-template-columns:1fr;text-align:center;justify-items:center}.hero-centered .hero__art{display:none}.hero-centered .lead{margin-inline:auto}.hero-centered .hero__actions{justify-content:center}
.hero-editorial .hero--home h1{font-size:clamp(2.6rem,1.6rem + 4.2vw,5.4rem);letter-spacing:-.035em}.hero-editorial .hero--home{border-bottom:1px solid var(--c-line)}
.hero-fullbleed .hero--home{background:var(--c-primary);color:var(--c-primary-ink)}.hero-fullbleed .hero--home .lead,.hero-fullbleed .hero--home .eyebrow{color:inherit;opacity:.88}.hero-fullbleed .hero--home .btn--primary{background:var(--c-bg);color:var(--c-text)}.hero-fullbleed .hero--home .btn--ghost{color:inherit;border-color:color-mix(in srgb,currentColor 40%,transparent)}
.section{padding:clamp(3.5rem,7vw,6.5rem) 0}.section--alt{background:var(--c-surface)}
.section__head{max-width:720px;margin-bottom:clamp(2rem,4vw,3rem)}.section__foot{margin-top:2.5rem}
.grid{display:grid;gap:clamp(1rem,2vw,1.5rem)}
.grid--2{grid-template-columns:repeat(2,1fr)}.grid--3{grid-template-columns:repeat(3,1fr)}.grid--4{grid-template-columns:repeat(4,1fr)}
.card{background:var(--c-bg);border:1px solid var(--c-line);border-radius:var(--radius);padding:clamp(1.4rem,2.4vw,2rem);transition:transform var(--dur) var(--ease-out),box-shadow var(--dur) var(--ease-out),border-color var(--dur) var(--ease-out)}
.section--alt .card{background:color-mix(in srgb,var(--c-bg) 70%,var(--c-surface))}
.card:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--c-primary) 35%,var(--c-line));box-shadow:0 18px 40px -24px color-mix(in srgb,var(--c-text) 40%,transparent)}
.card p{color:var(--c-muted);margin:0}.card__index{display:block;font-family:var(--font-heading);font-size:.85rem;color:var(--c-primary);margin-bottom:1.4rem;letter-spacing:.06em}
.section--process .grid{counter-reset:step}.section--process .card h3::before{counter-increment:step;content:counter(step, decimal-leading-zero);display:block;font-size:.85rem;color:var(--c-primary);margin-bottom:.8rem}
.prose{max-width:720px}.prose p{font-size:var(--step-1);line-height:1.6;color:var(--c-muted)}
.quote blockquote{margin:0 0 1rem;font-family:var(--font-heading);font-size:var(--step-1);line-height:1.45}.quote figcaption{color:var(--c-muted);font-size:.92rem}
.faq details{border-bottom:1px solid var(--c-line);padding:1.1rem 0}.faq summary{cursor:pointer;font-weight:600;font-size:var(--step-1);list-style:none;display:flex;justify-content:space-between;gap:1rem}
.faq summary::-webkit-details-marker{display:none}.faq summary::after{content:'+';color:var(--c-primary);transition:transform var(--dur) var(--ease-out)}.faq details[open] summary::after{transform:rotate(45deg)}
.faq details p{color:var(--c-muted);margin:.8rem 0 0}
.cta-band{background:var(--c-primary);color:var(--c-primary-ink);padding:clamp(3rem,6vw,5rem) 0}.cta-band__inner{display:grid;gap:.4rem;justify-items:start}.cta-band h2{margin:0}.cta-band p{opacity:.9;font-size:var(--step-1)}
.contact{display:grid;grid-template-columns:1fr 1fr;gap:clamp(2rem,5vw,4rem);align-items:start}
.contact__list{list-style:none;padding:0;margin:1.5rem 0 0;display:grid;gap:.6rem}.contact__list a{text-decoration:none;font-weight:600}
.form{display:grid;gap:1rem}.form label{display:grid;gap:.35rem;font-size:.9rem;font-weight:600}
.form input,.form textarea{font:inherit;padding:.8rem .95rem;border:1px solid var(--c-line);border-radius:calc(var(--radius) - 4px);background:var(--c-bg);color:var(--c-text);transition:border-color var(--dur) var(--ease-out)}
.form input:focus,.form textarea:focus{border-color:var(--c-primary);outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--c-primary) 20%,transparent)}
.form .check{display:flex;gap:.6rem;align-items:flex-start;font-weight:400;color:var(--c-muted)}.hp{position:absolute;left:-9999px}
.map{width:100%;height:360px;border:0;border-radius:var(--radius);margin-top:1rem}
.site-footer{border-top:1px solid var(--c-line);padding:3.5rem 0 1.5rem;color:var(--c-muted);font-size:.95rem}
.site-footer__inner{display:grid;grid-template-columns:2fr 1.5fr 1fr;gap:2rem}.site-footer nav{display:grid;gap:.4rem}.site-footer a{text-decoration:none}.site-footer .brand{color:var(--c-text)}
.legal{margin-top:2.5rem;font-size:.85rem}
.brand--logo img{height:44px;width:auto;max-width:180px;object-fit:contain}
.hero__media img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:28px;box-shadow:0 30px 60px -30px color-mix(in srgb,var(--c-text) 35%,transparent)}
.about--media{display:grid;grid-template-columns:1.1fr .9fr;gap:clamp(2rem,5vw,4rem);align-items:center}.about__img{margin:0}.about__img img{width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:var(--radius)}
.gallery{display:grid;grid-template-columns:repeat(3,1fr);gap:clamp(.6rem,1.5vw,1rem)}.gallery__item{margin:0;overflow:hidden;border-radius:var(--radius)}
.gallery__item img{width:100%;aspect-ratio:1;object-fit:cover;transition:transform 400ms var(--ease-out)}.gallery__item:hover img{transform:scale(1.03)}
.gallery--n3 .gallery__item:first-child,.gallery--n6 .gallery__item:first-child{grid-column:span 2;grid-row:span 2}
.gallery--n4{grid-template-columns:repeat(2,1fr)}.gallery--n4 .gallery__item img{aspect-ratio:4/3}
.gallery--n5 .gallery__item:first-child{grid-column:span 2}.gallery--n5 .gallery__item:first-child img{aspect-ratio:auto;height:100%}
.wa-float{position:fixed;right:1.25rem;bottom:1.25rem;background:#1f8f4e;color:#fff;border-radius:999px;padding:.8rem 1.1rem;font-weight:600;text-decoration:none;box-shadow:0 10px 30px -10px rgba(0,0,0,.4);z-index:60}
.demo-banner{background:var(--c-text);color:var(--c-bg);text-align:center;font-size:.85rem;padding:.55rem 1rem}
mark.todo{background:#fff3bf;color:#5c3c00;padding:0 .25em;border-radius:4px;outline:1px dashed #d4a017}
.reveal{opacity:0;transform:translateY(14px);transition:opacity 480ms var(--ease-out),transform 480ms var(--ease-out);transition-delay:calc(var(--i,0) * 60ms)}
.reveal.is-in{opacity:1;transform:none}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}.reveal{opacity:1;transform:none;transition:none}.btn,.card{transition:none}}
@media (max-width:900px){.hero__inner,.contact,.site-footer__inner,.about--media{grid-template-columns:1fr}.gallery{grid-template-columns:repeat(2,1fr)!important}.gallery .gallery__item:first-child{grid-row:auto!important}.grid--3,.grid--4{grid-template-columns:repeat(2,1fr)}.hero__art{max-width:420px}}
@media (max-width:720px){.nav-toggle{display:inline-flex}.nav{display:none;position:absolute;inset:72px 0 auto 0;flex-direction:column;align-items:stretch;gap:0;padding:.5rem 1.25rem 1.25rem;background:var(--c-bg);border-bottom:1px solid var(--c-line)}.nav.is-open{display:flex}.nav a:not(.btn){padding:.85rem 0;border-bottom:1px solid var(--c-line)}.nav .btn{margin-top:1rem}.grid--2,.grid--3,.grid--4{grid-template-columns:1fr}}
${design.css ? `\n/* --- Diseño a medida (GPT-6 Luna) --- */\n${sanitizeCss(design.css)}` : ''}
${design.fixesCss ? `\n/* --- Correcciones de la revisión visual --- */\n${sanitizeCss(design.fixesCss, 6000)}` : ''}
`;
}
