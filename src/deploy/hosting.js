import fs from 'node:fs';
import path from 'node:path';
import { sha1, sleep, slugify } from '../lib/util.js';

// Balanceador de Netlify para dominios apex con DNS externo (documentación de Netlify: "Configure external DNS").
export const NETLIFY_APEX_IP = '75.2.60.5';

// Netlify: despliegue por "file digest" (se suben solo los ficheros que Netlify no tiene), dominio y SSL.
export class NetlifyHosting {
  constructor({ token, accountSlug, fetch = globalThis.fetch }) {
    if (!token) throw new Error('NETLIFY_AUTH_TOKEN no configurado');
    this.name = 'netlify';
    this.token = token;
    this.accountSlug = accountSlug;
    this.fetch = fetch;
    this.api = 'https://api.netlify.com/api/v1';
  }

  async #req(method, url, body, { raw = false } = {}) {
    const res = await this.fetch(`${this.api}${url}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(raw ? { 'content-type': 'application/octet-stream' } : body ? { 'content-type': 'application/json' } : {}) },
      body: raw ? body : body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Netlify ${method} ${url} → ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }

  async ensureSite({ siteId, name }) {
    if (siteId) return this.#req('GET', `/sites/${siteId}`);
    const base = slugify(name).slice(0, 40);
    for (let i = 0; i < 5; i++) {
      const candidate = i === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
      try {
        return await this.#req('POST', this.accountSlug ? `/${this.accountSlug}/sites` : '/sites', { name: candidate });
      } catch (err) {
        if (!/422|name/i.test(err.message) || i === 4) throw err;
      }
    }
  }

  async deploy(siteId, files, log = () => {}) {
    const digest = {};
    const byHash = new Map();
    for (const [rel, content] of Object.entries(files)) {
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
      const h = sha1(buf);
      digest[`/${rel}`] = h;
      byHash.set(h, { rel, buf });
    }
    const deploy = await this.#req('POST', `/sites/${siteId}/deploys`, { files: digest });
    const required = deploy.required || [];
    log(`Netlify: ${Object.keys(digest).length} ficheros, ${required.length} por subir`);
    for (const h of required) {
      const { rel, buf } = byHash.get(h);
      await this.#req('PUT', `/deploys/${deploy.id}/files/${rel.split('/').map(encodeURIComponent).join('/')}`, buf, { raw: true });
    }
    for (let i = 0; i < 90; i++) {
      const d = await this.#req('GET', `/deploys/${deploy.id}`);
      if (d.state === 'ready') return { id: d.id, url: d.ssl_url || d.url, deployUrl: d.deploy_ssl_url || d.deploy_url };
      if (d.state === 'error') throw new Error(`Netlify: el despliegue falló (${d.error_message || 'sin detalle'})`);
      await sleep(2000);
    }
    throw new Error('Netlify: el despliegue no terminó a tiempo');
  }

  async setDomain(siteId, domain) {
    return this.#req('PATCH', `/sites/${siteId}`, { custom_domain: domain, domain_aliases: [`www.${domain}`] });
  }

  async provisionSsl(siteId) {
    try {
      await this.#req('POST', `/sites/${siteId}/ssl`);
      return true;
    } catch (err) {
      if (/already|exists/i.test(err.message)) return true;
      throw err;
    }
  }

  // Objetivos DNS para configurar el dominio con DNS externo.
  dnsTargets(site) {
    return { apexA: NETLIFY_APEX_IP, wwwCname: `${site.name}.netlify.app` };
  }

  // Netlify DNS: crea la zona y devuelve los nameservers que hay que poner en el registrador.
  async createDnsZone(siteId, domain) {
    const zones = await this.#req('GET', `/dns_zones`);
    const existing = zones.find((z) => z.name === domain);
    if (existing) return existing;
    return this.#req('POST', '/dns_zones', { name: domain, site_id: siteId, ...(this.accountSlug ? { account_slug: this.accountSlug } : {}) });
  }
}

// Hosting local (desarrollo/demo): publica en data/published/<nombre>/ y lo sirve la propia plataforma.
export class LocalHosting {
  constructor({ dataDir, publicUrl }) {
    this.name = 'local';
    this.dir = path.join(dataDir, 'published');
    this.publicUrl = publicUrl.replace(/\/$/, '');
  }

  async ensureSite({ siteId, name }) {
    const id = siteId || slugify(name);
    return { id, name: id, url: `${this.publicUrl}/published/${id}/` };
  }

  async deploy(siteId, files) {
    const dir = path.join(this.dir, siteId);
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [rel, content] of Object.entries(files)) {
      const f = path.join(dir, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content);
    }
    const url = `${this.publicUrl}/published/${siteId}/`;
    return { id: `local-${Date.now()}`, url, deployUrl: url };
  }

  async setDomain() {
    return null;
  }

  async provisionSsl() {
    return false;
  }

  dnsTargets() {
    return null;
  }
}

export function createHosting(config, { fetch } = {}) {
  const d = config.deploy;
  if (d.hosting === 'netlify') return new NetlifyHosting({ token: d.netlifyToken, accountSlug: d.netlifyAccountSlug, fetch });
  return new LocalHosting({ dataDir: config.dataDir, publicUrl: config.publicUrl });
}
