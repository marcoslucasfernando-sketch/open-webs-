import dns from 'node:dns/promises';

// Configuración DNS del dominio del cliente. Devuelve siempre { mode, records|nameservers, previous, instructions }.

export class CloudflareDns {
  constructor({ token, fetch = globalThis.fetch }) {
    if (!token) throw new Error('CLOUDFLARE_API_TOKEN no configurado');
    this.name = 'cloudflare';
    this.token = token;
    this.fetch = fetch;
  }

  async #req(method, url, body) {
    const res = await this.fetch(`https://api.cloudflare.com/client/v4${url}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    if (!json.success) throw new Error(`Cloudflare ${method} ${url}: ${JSON.stringify(json.errors).slice(0, 300)}`);
    return json.result;
  }

  // Apunta apex (A) y www (CNAME) al hosting. Guarda los registros anteriores para poder revertir.
  async configure(domain, targets) {
    const zones = await this.#req('GET', `/zones?name=${encodeURIComponent(domain)}`);
    if (!zones.length) throw new Error(`El dominio ${domain} no está en esta cuenta de Cloudflare`);
    const zoneId = zones[0].id;
    const previous = [];
    const upsert = async (name, type, content) => {
      const existing = await this.#req('GET', `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`);
      for (const r of existing.filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type))) {
        previous.push({ type: r.type, name: r.name, content: r.content, proxied: r.proxied });
        if (r.type === type && r.content === content) return;
        await this.#req('DELETE', `/zones/${zoneId}/dns_records/${r.id}`);
      }
      await this.#req('POST', `/zones/${zoneId}/dns_records`, { type, name, content, ttl: 1, proxied: false });
    };
    await upsert(domain, 'A', targets.apexA);
    await upsert(`www.${domain}`, 'CNAME', targets.wwwCname);
    return {
      mode: 'automatic',
      records: [{ type: 'A', name: domain, value: targets.apexA }, { type: 'CNAME', name: `www.${domain}`, value: targets.wwwCname }],
      previous,
    };
  }
}

export class NetlifyDns {
  constructor({ hosting }) {
    this.name = 'netlify';
    this.hosting = hosting;
  }

  async configure(domain, targets, { siteId }) {
    const zone = await this.hosting.createDnsZone(siteId, domain);
    const ns = zone.dns_servers || [];
    return {
      mode: 'nameservers',
      nameservers: ns,
      instructions: `En tu registrador de dominios, cambia los servidores DNS (nameservers) de ${domain} por:\n${ns.map((n) => `  • ${n}`).join('\n')}\nNetlify creará automáticamente los registros y el certificado SSL.`,
    };
  }
}

export class ManualDns {
  constructor() {
    this.name = 'manual';
  }

  async configure(domain, targets) {
    if (!targets) return { mode: 'none', instructions: 'Hosting local: no requiere DNS.' };
    return {
      mode: 'manual',
      records: [{ type: 'A', name: '@', value: targets.apexA }, { type: 'CNAME', name: 'www', value: targets.wwwCname }],
      instructions: `En el panel DNS de tu registrador para ${domain}, crea o sustituye:\n  • Registro A   @    →  ${targets.apexA}\n  • Registro CNAME www → ${targets.wwwCname}\nElimina otros registros A/AAAA de @ y CNAME de www. La plataforma detectará el cambio y activará el SSL.`,
    };
  }
}

export function createDns(config, { hosting, fetch } = {}) {
  const kind = config.deploy.dns;
  if (hosting?.name === 'local') return new ManualDns();
  if (kind === 'cloudflare') return new CloudflareDns({ token: config.deploy.cloudflareToken, fetch });
  if (kind === 'netlify' && hosting?.name === 'netlify') return new NetlifyDns({ hosting });
  return new ManualDns();
}

// ¿Apunta ya el dominio al hosting?
export async function dnsPointsTo(domain, targets, resolver = dns) {
  try {
    if (targets?.apexA) {
      const a = await resolver.resolve4(domain);
      if (a.includes(targets.apexA)) return true;
    }
    const cname = await resolver.resolveCname(`www.${domain}`).catch(() => []);
    return Boolean(targets?.wwwCname && cname.some((c) => c.replace(/\.$/, '') === targets.wwwCname));
  } catch {
    return false;
  }
}

// Disponibilidad orientativa de un dominio vía RDAP (sin clave): se consulta el servidor RDAP oficial del TLD
// según el registro de IANA (con rdap.org como respaldo). 404 ⇒ probablemente libre.
let ianaBootstrap = null;
const RDAP_HEADERS = { accept: 'application/rdap+json, application/json', 'user-agent': 'open-webs/0.1 (comprobación de dominios)' };

async function rdapBase(tld, fetchImpl) {
  if (!ianaBootstrap) {
    const res = await fetchImpl('https://data.iana.org/rdap/dns.json', { headers: RDAP_HEADERS, signal: AbortSignal.timeout(10_000) });
    ianaBootstrap = res.ok ? await res.json() : { services: [] };
  }
  const service = ianaBootstrap.services.find(([tlds]) => tlds.includes(tld));
  return service?.[1]?.[0] || null;
}

export async function domainAvailability(domain, fetchImpl = globalThis.fetch) {
  const tld = domain.split('.').pop();
  const bases = [];
  try {
    const base = await rdapBase(tld, fetchImpl);
    if (!base) return { domain, available: null, note: `El dominio .${tld} no ofrece RDAP; compruébalo en tu registrador` };
    bases.push(base.endsWith('/') ? base : `${base}/`);
  } catch {
    bases.push('https://rdap.org/'); // IANA no disponible: respaldo
  }
  for (const base of bases) {
    try {
      const res = await fetchImpl(`${base}domain/${encodeURIComponent(domain)}`, { headers: RDAP_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(10_000) });
      if (res.status === 404) return { domain, available: true, source: base };
      if (res.ok) {
        const json = await res.json();
        const registrar = json.entities?.find((e) => e.roles?.includes('registrar'))?.vcardArray?.[1]?.find((v) => v[0] === 'fn')?.[3] || null;
        return { domain, available: false, registrar, source: base };
      }
    } catch {}
  }
  return { domain, available: null };
}
