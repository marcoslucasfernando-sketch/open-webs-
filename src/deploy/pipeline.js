import { normalizeDomain, sleep, newId } from '../lib/util.js';
import { resolveSector } from '../lib/sectors.js';
import { renderSite, countPlaceholders } from '../generator/render.js';
import { dnsPointsTo } from './dns.js';

// Publicación con dominio: hosting → dominio → DNS → SSL → verificación pública (no se da por terminado sin ella).
export class DeployService {
  constructor({ config, store, hosting, dns, generator, fetch = globalThis.fetch, resolver }) {
    this.config = config;
    this.store = store;
    this.hosting = hosting;
    this.dns = dns;
    this.generator = generator;
    this.fetch = fetch;
    this.resolver = resolver;
  }

  build(project, { domain, force = false }) {
    const { spec, design } = project.result;
    const pending = countPlaceholders(spec);
    if (pending && !force) {
      throw new Error(`Hay ${pending} datos pendientes ([[PENDIENTE]]) en los textos. Complétalos en el editor o publica con "forzar" para omitirlos.`);
    }
    const buildId = newId('build');
    const files = renderSite(spec, design, {
      mode: 'publish',
      schemaType: resolveSector(spec.business.sector).schema,
      baseUrl: `https://${domain}`,
      forms: this.hosting.name === 'netlify' ? 'netlify' : 'none',
      buildId,
      assets: this.generator.mediaFiles(project.id),
    });
    return { files, buildId };
  }

  async publish(project, { domain: rawDomain, force = false }, log = () => {}) {
    const domain = normalizeDomain(rawDomain);
    const state = { domain, steps: [], startedAt: new Date().toISOString() };
    const step = (name, data = {}) => {
      state.steps.push({ name, at: new Date().toISOString(), ...data });
      log(name);
    };

    const { files, buildId } = this.build(project, { domain, force });
    state.buildId = buildId;

    const site = await this.hosting.ensureSite({ siteId: project.deploy?.siteId, name: domain });
    state.siteId = site.id;
    state.siteName = site.name;
    step(`Sitio en ${this.hosting.name}: ${site.name}`);

    const deploy = await this.hosting.deploy(site.id, files, log);
    state.deployId = deploy.id;
    state.hostingUrl = deploy.url;
    step(`Desplegado en ${deploy.url}`);
    if (!(await this.verifyUrl(deploy.url, buildId, { attempts: 10 }))) throw new Error(`El despliegue no responde en ${deploy.url}`);
    step('Despliegue verificado en la URL del hosting');

    if (this.hosting.name === 'local') {
      state.status = 'published';
      state.liveUrl = deploy.url;
      state.note = 'Hosting local (desarrollo): sin dominio real. Configura HOSTING_PROVIDER=netlify para producción.';
      step('Publicado (local)');
      return state;
    }

    await this.hosting.setDomain(site.id, domain);
    step(`Dominio ${domain} asignado al sitio`);
    const targets = this.hosting.dnsTargets(site);
    state.dns = await this.dns.configure(domain, targets, { siteId: site.id });
    state.dnsTargets = targets;
    step(state.dns.mode === 'automatic' ? 'Registros DNS configurados automáticamente' : 'Instrucciones DNS generadas', { instructions: state.dns.instructions });
    state.status = 'waiting_dns';
    return state;
  }

  // Bucle de verificación: espera DNS → SSL → HTTPS con el build correcto. Se ejecuta en segundo plano.
  async waitUntilLive(state, log = () => {}, { timeoutMs = this.config.deploy.verifyTimeoutMs, intervalMs = this.config.deploy.verifyIntervalMs } = {}) {
    const deadline = Date.now() + timeoutMs;
    let sslRequested = false;
    while (Date.now() < deadline) {
      const dnsOk = state.dns?.mode === 'nameservers' ? true : await dnsPointsTo(state.domain, state.dnsTargets, this.resolver);
      if (dnsOk) {
        if (!sslRequested) {
          try {
            await this.hosting.provisionSsl(state.siteId);
            sslRequested = true;
            log('DNS correcto; certificado SSL solicitado');
          } catch (err) {
            log(`SSL aún no disponible: ${err.message.slice(0, 120)}`);
          }
        }
        if (await this.verifyUrl(`https://${state.domain}/`, state.buildId, { attempts: 1 })) {
          state.status = 'live';
          state.liveUrl = `https://${state.domain}/`;
          state.verifiedAt = new Date().toISOString();
          log(`✓ Verificado: ${state.liveUrl} responde con HTTPS y el build ${state.buildId}`);
          return state;
        }
      }
      await sleep(intervalMs);
    }
    state.status = 'verification_timeout';
    log('La verificación no se completó a tiempo; revisa el DNS y vuelve a pulsar "Verificar"');
    return state;
  }

  // La URL responde 200 y contiene el identificador del build desplegado.
  async verifyUrl(url, buildId, { attempts = 5, delayMs = 3000 } = {}) {
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await this.fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000), headers: { 'cache-control': 'no-cache' } });
        if (res.ok && (await res.text()).includes(buildId)) return true;
      } catch {}
      if (i < attempts - 1) await sleep(delayMs);
    }
    return false;
  }
}
