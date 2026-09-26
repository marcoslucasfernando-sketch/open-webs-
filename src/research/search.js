import { hostnameOf } from '../lib/util.js';
import { listFixtureIds } from './scraper.js';

// Dominios que no son webs de negocio propias (directorios, redes sociales, marketplaces, prensa).
const EXCLUDED = [
  'google.', 'facebook.com', 'instagram.com', 'tiktok.com', 'twitter.com', 'x.com', 'linkedin.com', 'youtube.com',
  'wikipedia.org', 'tripadvisor.', 'yelp.', 'paginasamarillas.es', 'infoisinfo', 'cylex', 'habitissimo', 'doctoralia',
  'thefork.', 'eltenedor', 'booking.com', 'airbnb.', 'expedia.', 'idealista.com', 'fotocasa.es', 'milanuncios', 'amazon.',
  'justeat', 'glovo', 'ubereats', 'groupon', 'topdoctors', 'wikiloc', 'foursquare', 'pinterest.', 'reddit.com',
  'elconfidencial', 'elpais.com', 'abc.es', 'canarias7', 'laprovincia.es', 'europapress', 'guiarepsol', 'minube',
  'empresite', 'axesor', 'einforma', 'infoempresa', 'quehacerenmadrid', 'timeout.', 'michelin.',
];

export const isBusinessSite = (url) => {
  const host = hostnameOf(url);
  return Boolean(host) && !EXCLUDED.some((d) => host.includes(d));
};

export function buildQueries({ sector, location }) {
  const q = [];
  if (location) q.push(`${sector} ${location}`, `mejor ${sector} en ${location}`, `${sector} cerca de ${location} web oficial`);
  q.push(`${sector} web oficial`, `${sector} España`);
  return q;
}

// Todos los proveedores devuelven [{ url, title, snippet, query }].
export function createSearch(cfg, { fetch = globalThis.fetch } = {}) {
  const providers = {
    async brave(query) {
      if (!cfg.braveApiKey) throw new Error('BRAVE_API_KEY no configurado');
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=20&country=es&search_lang=es`;
      const res = await fetch(url, { headers: { accept: 'application/json', 'x-subscription-token': cfg.braveApiKey } });
      if (!res.ok) throw new Error(`Brave Search ${res.status}`);
      const json = await res.json();
      return (json.web?.results || []).map((r) => ({ url: r.url, title: r.title, snippet: r.description }));
    },
    async serpapi(query) {
      if (!cfg.serpapiKey) throw new Error('SERPAPI_KEY no configurado');
      const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&hl=es&gl=es&num=20&api_key=${cfg.serpapiKey}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`SerpAPI ${res.status}`);
      const json = await res.json();
      return (json.organic_results || []).map((r) => ({ url: r.link, title: r.title, snippet: r.snippet }));
    },
    async tavily(query) {
      if (!cfg.tavilyApiKey) throw new Error('TAVILY_API_KEY no configurado');
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.tavilyApiKey}` },
        body: JSON.stringify({ query, max_results: 20, search_depth: 'basic' }),
      });
      if (!res.ok) throw new Error(`Tavily ${res.status}`);
      const json = await res.json();
      return (json.results || []).map((r) => ({ url: r.url, title: r.title, snippet: r.content }));
    },
    // Modo demo: referencias sintéticas locales adaptadas al sector y la ciudad.
    async fixture(query, { sector, location } = {}) {
      return listFixtureIds().map((id, i) => ({
        url: `fixture://${id}?sector=${encodeURIComponent(sector || query)}&city=${encodeURIComponent(location || 'tu ciudad')}&name=${encodeURIComponent(`Referencia ${i + 1}`)}`,
        title: `Referencia ${i + 1}`,
        snippet: 'Referencia sintética (modo demo)',
      }));
    },
  };

  const provider = providers[cfg.searchProvider];
  if (!provider) throw new Error(`Proveedor de búsqueda desconocido: ${cfg.searchProvider}`);

  return {
    name: cfg.searchProvider,
    // Candidatos únicos por dominio (una referencia por negocio), excluyendo directorios.
    async candidates({ sector, location, exclude = [] }) {
      const seen = new Set(exclude.map(hostnameOf));
      const out = [];
      for (const query of buildQueries({ sector, location })) {
        let results = [];
        try {
          results = await provider(query, { sector, location });
        } catch (err) {
          if (out.length === 0 && query === buildQueries({ sector, location }).at(-1)) throw err;
          continue;
        }
        for (const r of results) {
          const host = r.url.startsWith('fixture://') ? r.url : hostnameOf(r.url);
          if (!r.url.startsWith('fixture://') && !isBusinessSite(r.url)) continue;
          if (seen.has(host)) continue;
          seen.add(host);
          out.push({ ...r, query });
          if (out.length >= cfg.maxCandidates) return out;
        }
        if (cfg.searchProvider === 'fixture') break;
      }
      return out;
    },
  };
}
