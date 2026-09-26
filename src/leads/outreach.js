import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { escapeHtml, newId, sleep } from '../lib/util.js';
import { resolveSector } from '../lib/sectors.js';
import { renderSite } from '../generator/render.js';
import { writeFiles } from '../generator/pipeline.js';

// Prospección: demo de web por negocio + email con la demo, con salvaguardas (LSSI/RGPD): identificación del
// remitente, motivo del contacto, baja con un clic, lista de exclusión, límite diario, intervalo mínimo y
// confirmación explícita de cada campaña. MAIL_DRY_RUN=true (por defecto) no envía nada: guarda los .eml.
export class OutreachService {
  constructor({ config, store, ai, generator, hosting, mailer, mcp }) {
    this.config = config;
    this.store = store;
    this.ai = ai;
    this.generator = generator;
    this.hosting = hosting;
    this.mailer = mailer;
    this.mcp = mcp;
    this.key = crypto.createHash('sha256').update(config.secretKey || `open-webs|${config.dataDir}`).digest();
  }

  // ---------- Leads ----------
  saveLeads(places) {
    for (const p of places) {
      const prev = this.store.get('leads', p.id) || {};
      this.store.put('leads', p.id, { ...prev, ...p, outreach: prev.outreach || { status: 'nuevo' } });
    }
  }

  listLeads() {
    const suppressed = new Set(this.suppression());
    return this.store.list('leads').map((l) => ({ ...l, suppressed: Boolean(l.email && suppressed.has(l.email.toLowerCase())) }));
  }

  // ---------- Demos ----------
  demoUrl(projectId) {
    return `${this.config.publicUrl.replace(/\/$/, '')}/demo/${projectId}/`;
  }

  async createDemo(lead, log = () => {}) {
    const projectId = lead.demo?.projectId || `demo_${lead.id.replace(/[^a-z0-9]/gi, '').slice(-24)}`;
    const project = {
      id: projectId,
      kind: 'demo',
      leadId: lead.id,
      createdAt: new Date().toISOString(),
      input: {
        name: lead.name,
        sector: lead.sector,
        location: lead.city || this.config.leads.region,
        city: lead.city,
        phone: lead.phone,
        email: null, // en la demo no se publica el email del negocio
        address: lead.address,
        lat: lead.lat,
        lon: lead.lon,
        website: lead.website,
        instagram: lead.instagram,
        facebook: lead.facebook,
      },
    };
    log(`Generando demo para ${lead.name}`);
    project.result = await this.generator.generate(project, log);
    const profile = resolveSector(lead.sector);
    const files = renderSite(project.result.spec, project.result.design, {
      mode: 'demo',
      schemaType: profile.schema,
      baseUrl: this.demoUrl(projectId).replace(/\/$/, ''),
      assets: this.generator.mediaFiles(projectId),
    });
    let url = this.demoUrl(projectId);
    if (this.config.leads.demoHosting === 'netlify' && this.hosting.name === 'netlify') {
      const site = await this.hosting.ensureSite({ siteId: lead.demo?.siteId, name: `demo-${lead.name}` });
      url = (await this.hosting.deploy(site.id, files, log)).url;
      project.demoSiteId = site.id;
    }
    writeFiles(path.join(this.store.siteDir(projectId), 'demo'), files);
    const preview = await this.#capturePreview(this.demoUrl(projectId), projectId).catch(() => null);
    project.demo = { url, preview, createdAt: new Date().toISOString() };
    this.store.put('projects', projectId, project);
    this.store.put('leads', lead.id, { ...lead, demo: { projectId, url, preview, siteId: project.demoSiteId } });
    return project;
  }

  // Captura del hero de la demo (para la tarjeta del email) con Playwright MCP.
  async #capturePreview(url, projectId) {
    if (!this.mcp?.has('playwright')) return null;
    await this.mcp.call('playwright__browser_resize', { width: 1200, height: 750 });
    await this.mcp.call('playwright__browser_navigate', { url });
    await this.mcp.call('playwright__browser_evaluate', { function: "() => document.querySelectorAll('.reveal').forEach((e) => e.classList.add('is-in'))" });
    const shot = await this.mcp.call('playwright__browser_take_screenshot', { type: 'jpeg' });
    if (!shot.images[0]) return null;
    fs.writeFileSync(path.join(this.store.siteDir(projectId), 'demo', 'preview.jpg'), Buffer.from(shot.images[0].split(',')[1], 'base64'));
    return `${this.demoUrl(projectId)}preview.jpg`;
  }

  // ---------- Baja y exclusión ----------
  suppression() {
    return this.store.get('suppression', 'list')?.emails || [];
  }

  unsubscribeToken(email) {
    return crypto.createHmac('sha256', this.key).update(email.toLowerCase()).digest('hex').slice(0, 32);
  }

  unsubscribeUrl(email) {
    return `${this.config.publicUrl.replace(/\/$/, '')}/unsubscribe?e=${encodeURIComponent(email)}&t=${this.unsubscribeToken(email)}`;
  }

  unsubscribe(email, token) {
    if (!email || token !== this.unsubscribeToken(email)) throw new Error('Enlace de baja no válido');
    const list = new Set(this.suppression());
    list.add(email.toLowerCase());
    this.store.put('suppression', 'list', { emails: [...list], updatedAt: new Date().toISOString() });
  }

  // ---------- Campañas ----------
  async composeEmail(lead) {
    const m = this.config.mail;
    const sender = { name: m.senderName, company: m.senderCompany };
    const { data } = await this.ai.generation.run('outreachEmail', { place: lead, demoUrl: lead.demo.url, sender }, { sectorId: resolveSector(lead.sector).id, useTools: false });
    const unsub = this.unsubscribeUrl(lead.email);
    const reason = lead.source === 'OpenStreetMap' ? 'tu negocio figura con estos datos de contacto en OpenStreetMap' : 'tu negocio publica este email en su web';
    const footerText = `\n\n—\n${m.senderName} · ${m.senderCompany}\n${m.senderAddress}\nComunicación comercial. Te escribo porque ${reason}.\nSi no quieres recibir más mensajes: ${unsub}`;
    const text = `${String(data.body).trim()}${footerText}`;
    const html = `<!doctype html><html lang="es"><body style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="padding:28px 28px 8px;font-size:15px;line-height:1.6">${escapeHtml(String(data.body).trim()).replace(/\n/g, '<br>').replace(escapeHtml(lead.demo.url), `<a href="${escapeHtml(lead.demo.url)}" style="color:#1d4ed8">${escapeHtml(lead.demo.url)}</a>`)}</td></tr>
${lead.demo.preview ? `<tr><td style="padding:12px 28px"><a href="${escapeHtml(lead.demo.url)}"><img src="${escapeHtml(lead.demo.preview)}" width="544" alt="Vista previa de la demo para ${escapeHtml(lead.name)}" style="width:100%;height:auto;border-radius:8px;border:1px solid #e4e4e7"></a></td></tr>` : ''}
<tr><td style="padding:8px 28px 28px"><a href="${escapeHtml(lead.demo.url)}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:999px;font-weight:bold">Ver la demo</a></td></tr>
<tr><td style="padding:16px 28px;background:#fafafa;font-size:12px;line-height:1.5;color:#71717a">${escapeHtml(m.senderName)} · ${escapeHtml(m.senderCompany)}<br>${escapeHtml(m.senderAddress)}<br>Comunicación comercial. Te escribo porque ${escapeHtml(reason)}.<br><a href="${escapeHtml(unsub)}" style="color:#71717a">Darme de baja</a></td></tr>
</table></td></tr></table></body></html>`;
    return {
      to: lead.email,
      from: m.from,
      replyTo: m.replyTo || undefined,
      subject: String(data.subject).slice(0, 120),
      text,
      html,
      headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    };
  }

  // Borrador: genera demo (si falta) y email por cada lead con email. Nada se envía aquí.
  async createCampaign(leadIds, log = () => {}) {
    const suppressed = new Set(this.suppression());
    const campaign = { id: newId('camp'), createdAt: new Date().toISOString(), status: 'draft', messages: [], skipped: [] };
    for (const id of leadIds) {
      let lead = this.store.get('leads', id);
      if (!lead) continue;
      if (!lead.email) {
        campaign.skipped.push({ leadId: id, name: lead.name, reason: 'sin email' });
        continue;
      }
      if (suppressed.has(lead.email.toLowerCase())) {
        campaign.skipped.push({ leadId: id, name: lead.name, reason: 'se dio de baja' });
        continue;
      }
      try {
        if (!lead.demo?.url) {
          await this.createDemo(lead, log);
          lead = this.store.get('leads', id);
        }
        const msg = await this.composeEmail(lead);
        campaign.messages.push({ leadId: id, name: lead.name, demoUrl: lead.demo.url, status: 'draft', ...msg });
        log(`Email preparado para ${lead.name}`);
      } catch (err) {
        campaign.skipped.push({ leadId: id, name: lead.name, reason: err.message.slice(0, 160) });
        log(`✗ ${lead.name}: ${err.message.slice(0, 120)}`);
      }
    }
    this.store.put('campaigns', campaign.id, campaign);
    return campaign;
  }

  sentToday() {
    const today = new Date().toISOString().slice(0, 10);
    return this.store.list('campaigns').flatMap((c) => c.messages).filter((m) => m.status === 'sent' && m.sentAt?.startsWith(today) && !m.dryRun).length;
  }

  // Envío tras confirmación explícita, respetando exclusión, límite diario e intervalo mínimo.
  async sendCampaign(campaignId, { confirm } = {}, log = () => {}) {
    if (confirm !== true) throw new Error('Confirma el envío de la campaña (confirm: true)');
    const campaign = this.store.get('campaigns', campaignId);
    if (!campaign) throw new Error('Campaña no encontrada');
    const m = this.config.mail;
    if (!this.mailer.dryRun && /\[\[|example\.com/.test(`${m.senderAddress} ${m.from}`)) {
      throw new Error('Configura SENDER_ADDRESS y MAIL_FROM reales antes de enviar (identificación del remitente obligatoria)');
    }
    campaign.status = 'sending';
    campaign.mailer = this.mailer.provider;
    this.store.put('campaigns', campaign.id, campaign);
    const suppressed = new Set(this.suppression());
    for (const msg of campaign.messages) {
      if (msg.status === 'sent') continue;
      if (suppressed.has(msg.to.toLowerCase())) {
        msg.status = 'skipped';
        msg.error = 'se dio de baja';
        continue;
      }
      if (!this.mailer.dryRun && this.sentToday() >= m.dailyLimit) {
        msg.status = 'pending';
        msg.error = `límite diario (${m.dailyLimit}) alcanzado`;
        log(`Límite diario alcanzado; el resto queda pendiente`);
        break;
      }
      try {
        const res = await this.mailer.send(msg);
        Object.assign(msg, { status: 'sent', sentAt: new Date().toISOString(), providerId: res.id, dryRun: this.mailer.dryRun, outboxFile: res.file });
        const lead = this.store.get('leads', msg.leadId);
        this.store.put('leads', msg.leadId, { ...lead, outreach: { status: this.mailer.dryRun ? 'simulado' : 'enviado', at: msg.sentAt, campaignId } });
        log(`${this.mailer.dryRun ? 'Simulado (outbox)' : 'Enviado'}: ${msg.name} <${msg.to}>`);
      } catch (err) {
        msg.status = 'error';
        msg.error = err.message.slice(0, 200);
        log(`✗ ${msg.name}: ${msg.error}`);
      }
      this.store.put('campaigns', campaign.id, campaign);
      if (!this.mailer.dryRun) await sleep(m.minIntervalMs);
    }
    campaign.status = campaign.messages.some((x) => x.status === 'pending') ? 'partial' : 'done';
    this.store.put('campaigns', campaign.id, campaign);
    return campaign;
  }
}
