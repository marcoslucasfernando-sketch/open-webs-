// Flujo completo por HTTP en modo demo (IA mock, referencias y negocios sintéticos, hosting local, email simulado).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildConfig } from '../src/config.js';
import { createServices, createApp } from '../src/app.js';

async function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-e2e-'));
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = buildConfig({
    DATA_DIR: dataDir, PUBLIC_URL: base, AI_RESEARCH: 'mock', AI_GENERATION: 'mock', SEARCH_PROVIDER: 'fixture',
    PLACES_PROVIDER: 'fixture', HOSTING_PROVIDER: 'local', MCP_PLAYWRIGHT: 'off', MCP_CHROME_DEVTOOLS: 'off', PANEL_TOKEN: 'secreto',
  });
  const services = createServices(config);
  server.on('request', createApp(services));
  const api = async (p, opts = {}) => {
    const res = await fetch(`${base}${p}`, { ...opts, headers: { 'content-type': 'application/json', authorization: 'Bearer secreto' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const waitJob = async (id) => {
    for (;;) {
      const { data } = await api(`/api/jobs/${id}`);
      if (data.status !== 'running') return data;
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  return { base, api, waitJob, services, dataDir, close: () => server.close() };
}

test('flujo principal: investigar → generar → editar → aprobar → publicar → verificar', { timeout: 120_000 }, async () => {
  const { base, api, waitJob, services, close } = await setup();
  try {
    assert.equal((await fetch(`${base}/api/status`)).status, 401, 'la API exige PANEL_TOKEN');
    const created = await api('/api/projects', { method: 'POST', body: { name: 'Fisio Tirma', sector: 'Fisioterapia', location: 'Telde', description: 'Fisioterapia deportiva y suelo pélvico.' } });
    assert.equal(created.status, 200);
    const job = await waitJob(created.data.jobId);
    assert.equal(job.status, 'done', job.error);

    const research = (await api(`/api/projects/${created.data.projectId}/research`)).data;
    assert.ok(research.references.length >= 10, 'mínimo 10 referencias por sector');
    assert.match(research.masterPrompt, /MASTER PROMPT/);

    const project = (await api(`/api/projects/${created.data.projectId}`)).data;
    assert.ok(project.result.decisions.length > 5);
    assert.ok(project.result.originality.original);
    assert.equal((await fetch(`${base}/preview/${project.id}/`)).status, 200);

    assert.equal((await api(`/api/projects/${project.id}/deploy`, { method: 'POST', body: { domain: 'fisiotirma.es' } })).status, 409, 'sin aprobar no se publica');
    await api(`/api/projects/${project.id}/approve`, { method: 'POST' });
    const blocked = await waitJob((await api(`/api/projects/${project.id}/deploy`, { method: 'POST', body: { domain: 'fisiotirma.es' } })).data.jobId);
    assert.equal(blocked.status, 'error');
    assert.match(blocked.error, /pendientes/);

    const spec = JSON.parse(JSON.stringify(project.result.spec).replace(/\[\[PENDIENTE:[^\]]*\]\]/g, 'Dato real'));
    assert.equal((await api(`/api/projects/${project.id}/spec`, { method: 'PUT', body: { spec } })).data.placeholders, 0);
    const deployed = await waitJob((await api(`/api/projects/${project.id}/deploy`, { method: 'POST', body: { domain: 'fisiotirma.es' } })).data.jobId);
    assert.equal(deployed.status, 'done', deployed.error);
    const after = (await api(`/api/projects/${project.id}`)).data;
    assert.equal(after.deploy.status, 'published');
    const live = await (await fetch(after.deploy.liveUrl)).text();
    assert.ok(live.includes(after.deploy.buildId), 'la web publicada contiene el build verificado');
  } finally {
    services.ai.mcp.closeAll();
    close();
  }
});

test('prospección: buscar → demos → campaña (simulada) con baja y exclusión', { timeout: 120_000 }, async () => {
  const { api, waitJob, services, dataDir, close } = await setup();
  try {
    await waitJob((await api('/api/leads/search', { method: 'POST', body: { sectorIds: ['restaurante'] } })).data.jobId);
    const leads = (await api('/api/leads')).data;
    assert.ok(leads.length > 0 && leads.every((l) => l.sectorId === 'restaurante'));
    const withEmail = leads.filter((l) => l.email).slice(0, 2);
    const noEmail = leads.find((l) => !l.email);
    const draft = await waitJob((await api('/api/campaigns', { method: 'POST', body: { leadIds: [...withEmail.map((l) => l.id), noEmail?.id].filter(Boolean) } })).data.jobId);
    assert.equal(draft.status, 'done', draft.error);
    assert.equal(draft.result.messages, withEmail.length);
    if (noEmail) assert.equal(draft.result.skipped[0].reason, 'sin email');

    const campaign = (await api(`/api/campaigns/${draft.result.campaignId}`)).data;
    const msg = campaign.messages[0];
    assert.match(msg.text, /Comunicación comercial/);
    assert.match(msg.headers['List-Unsubscribe'], /unsubscribe\?e=/);
    assert.equal((await api(`/api/campaigns/${campaign.id}/send`, { method: 'POST', body: {} })).status, 400, 'exige confirmación');

    const url = new URL(msg.headers['List-Unsubscribe'].slice(1, -1));
    services.outreach.unsubscribe(url.searchParams.get('e'), url.searchParams.get('t'));
    const sent = await waitJob((await api(`/api/campaigns/${campaign.id}/send`, { method: 'POST', body: { confirm: true } })).data.jobId);
    assert.equal(sent.status, 'done', sent.error);
    const final = (await api(`/api/campaigns/${campaign.id}`)).data;
    assert.equal(final.messages.find((m) => m.to === msg.to).status, 'skipped', 'el que se dio de baja no recibe');
    assert.equal(fs.readdirSync(path.join(dataDir, 'outbox')).length, withEmail.length - 1, 'modo simulación: .eml en outbox');
    assert.throws(() => services.outreach.unsubscribe(msg.to, 'token-falso'));
  } finally {
    services.ai.mcp.closeAll();
    close();
  }
});
