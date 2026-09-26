import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { SECTORS, sectorFromOsmTags } from '../lib/sectors.js';
import { extractEmails } from '../research/extract.js';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/places-gran-canaria.json');

// Negocios de una zona (por defecto Gran Canaria) desde OpenStreetMap (Overpass), datos abiertos ODbL.
export function overpassQuery(bbox, sectorIds = []) {
  const [s, w, n, e] = bbox;
  const sectors = sectorIds.length ? SECTORS.filter((x) => sectorIds.includes(x.id)) : SECTORS;
  const filters = sectors.flatMap((x) => x.osm).map(([k, v]) => `nwr["${k}"="${v}"]["name"](${s},${w},${n},${e});`);
  return `[out:json][timeout:90];(${filters.join('')});out center tags 2000;`;
}

export function placeFromOsm(el) {
  const t = el.tags || {};
  const sector = sectorFromOsmTags(t);
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  const website = t.website || t['contact:website'] || t.url || null;
  return {
    id: `osm-${el.type}-${el.id}`,
    name: t.name,
    sector: sector?.label || t.amenity || t.shop || t.office || t.craft || 'Negocio',
    sectorId: sector?.id || null,
    lat,
    lon,
    website: website && !/^https?:\/\//i.test(website) ? `https://${website}` : website,
    email: (t.email || t['contact:email'] || '').split(/[;,\s]+/)[0] || null,
    phone: t.phone || t['contact:phone'] || null,
    instagram: t['contact:instagram'] || null,
    facebook: t['contact:facebook'] || null,
    address: [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ') || null,
    city: t['addr:city'] || null,
    source: 'OpenStreetMap',
    osmUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
  };
}

export class PlacesService {
  constructor({ config, fetch = globalThis.fetch }) {
    this.cfg = config.leads;
    this.fetch = fetch;
  }

  async search({ sectorIds = [], bbox = this.cfg.bbox } = {}) {
    let places;
    if (this.cfg.placesProvider === 'fixture') {
      places = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).map((p) => ({ ...p, source: 'demo' }));
      if (sectorIds.length) places = places.filter((p) => sectorIds.includes(p.sectorId));
    } else {
      const res = await this.fetch(this.cfg.overpassUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'open-webs/0.1' },
        body: `data=${encodeURIComponent(overpassQuery(bbox, sectorIds))}`,
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = await res.json();
      places = (json.elements || []).map(placeFromOsm).filter((p) => p.name && p.lat && p.lon);
    }
    return places;
  }
}

// Visita la web del negocio: si responde, calidad básica, emails y redes sociales visibles.
export async function enrichPlace(place, { scraper }) {
  const out = { ...place, enrichedAt: new Date().toISOString() };
  if (!place.website) return { ...out, webStatus: 'sin-web' };
  try {
    const page = await scraper.get(place.website);
    const $ = cheerio.load(page.body);
    const emails = extractEmails($, page.body);
    const links = $('a[href]').map((_, el) => $(el).attr('href')).get();
    let contactEmails = [];
    const contactHref = links.find((h) => /contact|contacto/i.test(h || ''));
    if (!emails.length && contactHref) {
      try {
        const c = await scraper.get(new URL(contactHref, page.url).href);
        contactEmails = extractEmails(cheerio.load(c.body), c.body);
      } catch {}
    }
    const year = new Date().getFullYear();
    const issues = [];
    if (!page.url.startsWith('https:')) issues.push('sin HTTPS');
    if (!$('meta[name="viewport"]').length) issues.push('no adaptada a móvil');
    const copyright = page.body.match(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/i);
    if (copyright && Number(copyright[1]) < year - 3) issues.push(`contenido de ${copyright[1]}`);
    if (!$('meta[name="description"]').attr('content')) issues.push('sin meta descripción');
    if (/wix|jimdo|site123|webnode/i.test(page.body) && issues.length) issues.push('plantilla genérica');
    return {
      ...out,
      webStatus: issues.length >= 2 ? 'mejorable' : 'correcta',
      webIssues: issues,
      email: place.email || emails[0] || contactEmails[0] || null,
      emailSource: place.email ? 'OpenStreetMap' : emails[0] || contactEmails[0] ? 'web del negocio' : null,
      instagram: place.instagram || links.find((h) => /instagram\.com\//i.test(h || '')) || null,
      facebook: place.facebook || links.find((h) => /facebook\.com\//i.test(h || '')) || null,
    };
  } catch (err) {
    return { ...out, webStatus: 'caida', webIssues: [err.message.slice(0, 120)] };
  }
}
