// Panel de Open Webs (sin dependencias salvo Leaflet para el mapa).
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let token = localStorage.getItem('panelToken') || '';
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  if (res.status === 401) {
    token = prompt('Token del panel (PANEL_TOKEN):') || '';
    localStorage.setItem('panelToken', token);
    return api(path, opts);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// Sigue un trabajo en segundo plano mostrando su registro.
async function followJob(jobId, logEl) {
  for (;;) {
    const job = await api(`/api/jobs/${jobId}`);
    if (logEl) logEl.innerHTML = job.logs.map((l) => `<li>${esc(l.msg)}</li>`).join('');
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
    if (job.status !== 'running') {
      if (job.status === 'error') throw new Error(job.error);
      return job;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
}

function dialog(html) {
  $('#dlg-body').innerHTML = html;
  $('#dlg').showModal();
}

// ---------------- Pestañas ----------------
$$('.tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    $$('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
    if (b.dataset.tab === 'mapa') initMap();
    if (b.dataset.tab === 'ajustes') loadSettings();
    if (b.dataset.tab === 'sectores') loadSectors();
    history.replaceState(null, '', `#${b.dataset.tab}`);
  }),
);
$$('.subtabs button').forEach((b) =>
  b.addEventListener('click', () => {
    $$('.subtabs button').forEach((x) => x.classList.toggle('active', x === b));
    $$('.sub').forEach((t) => t.classList.toggle('active', t.id === `sub-${b.dataset.sub}`));
  }),
);

// ---------------- Estado inicial ----------------
let STATUS;
async function boot() {
  STATUS = await api('/api/status');
  const sectors = await api('/api/sectors');
  $('#sector-list').innerHTML = sectors.catalog.map((s) => `<option value="${esc(s.label)}">`).join('');
  $('#sector-checks').innerHTML = sectors.catalog.map((s) => `<label class="inline"><input type="checkbox" value="${s.id}"> ${esc(s.label)}</label>`).join('');
  const ai = STATUS.ai;
  $('#mode-pill').textContent = `${ai.generation} · ${STATUS.mail.dryRun ? 'email simulado' : 'email real'}`;
  const projects = await api('/api/projects');
  $('#recent').innerHTML = projects.length ? `<h2>Proyectos</h2>${projects.map((p) => `<a href="#p=${p.id}">${esc(p.name)} <span class="muted small">· ${esc(p.sector)} · ${esc(p.status)}${p.deploy?.liveUrl ? ` · ${esc(p.deploy.liveUrl)}` : ''}</span></a>`).join('')}` : '';
  const hash = location.hash.slice(1);
  if (hash.startsWith('p=')) openProject(hash.slice(2));
  else if (hash) $(`.tabs button[data-tab="${hash}"]`)?.click();
}
window.addEventListener('hashchange', () => {
  const h = location.hash.slice(1);
  if (h.startsWith('p=')) openProject(h.slice(2));
  else if (h) $(`.tabs button[data-tab="${h}"]`)?.click();
});

// ---------------- Crear web ----------------
$('#form-project').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  $('#step-form').classList.add('hidden');
  $('#step-progress').classList.remove('hidden');
  try {
    const { projectId, jobId } = await api('/api/projects', { method: 'POST', body });
    await followJob(jobId, $('#progress-log'));
    location.hash = `p=${projectId}`;
  } catch (err) {
    $('#progress-log').insertAdjacentHTML('beforeend', `<li><b>Error:</b> ${esc(err.message)}</li>`);
    $('#step-form').classList.remove('hidden');
  }
});

let PROJECT;
async function openProject(id) {
  $$('.tabs button')[0].click();
  PROJECT = await api(`/api/projects/${id}`);
  if (!PROJECT.result) {
    $('#step-form').classList.add('hidden');
    $('#step-progress').classList.remove('hidden');
    if (PROJECT.jobId) await followJob(PROJECT.jobId, $('#progress-log')).catch(() => {});
    PROJECT = await api(`/api/projects/${id}`);
    if (!PROJECT.result) return;
  }
  $('#step-form').classList.add('hidden');
  $('#step-progress').classList.add('hidden');
  $('#step-review').classList.remove('hidden');
  $('#review-title').textContent = PROJECT.input.name;
  refreshPreview();
  renderContentEditor();
  renderDesignEditor();
  renderResearch();
  renderDecisions();
  renderPublish();
}

function refreshPreview() {
  $('#preview').src = `${PROJECT.previewUrl}?t=${Date.now()}`;
  $('#preview-open').href = PROJECT.previewUrl;
}
$$('.seg button').forEach((b) =>
  b.addEventListener('click', () => {
    $$('.seg button').forEach((x) => x.classList.toggle('active', x === b));
    $('#preview').classList.toggle('mobile', b.dataset.vp === 'mobile');
  }),
);

function renderContentEditor() {
  const spec = PROJECT.result.spec;
  const pending = PROJECT.placeholders;
  let html = pending ? `<p class="todo-hint">Hay ${pending} datos marcados como <b>[[PENDIENTE: …]]</b>. Complétalos antes de publicar.</p>` : '';
  spec.pages.forEach((page, pi) => {
    html += `<details ${pi === 0 ? 'open' : ''}><summary><b>${esc(page.navLabel)}</b> <span class="muted small">/${esc(page.slug)}</span></summary>
      <div class="sec"><h4>SEO</h4><input data-path="pages.${pi}.metaTitle" value="${esc(page.metaTitle)}" maxlength="60"><textarea data-path="pages.${pi}.metaDescription" rows="2" maxlength="158">${esc(page.metaDescription)}</textarea></div>`;
    page.sections.forEach((sec, si) => {
      html += `<div class="sec"><h4>${esc(sec.type)}</h4>`;
      for (const k of ['heading', 'subheading', 'body']) if (sec[k] !== undefined && (sec[k] || k === 'heading')) html += `<textarea data-path="pages.${pi}.sections.${si}.${k}" rows="${k === 'body' ? 4 : 2}">${esc(sec[k])}</textarea>`;
      (sec.items || []).forEach((it, ii) => {
        for (const k of ['title', 'text', 'q', 'a']) if (it[k] !== undefined) html += `<textarea data-path="pages.${pi}.sections.${si}.items.${ii}.${k}" rows="2">${esc(it[k])}</textarea>`;
      });
      if (sec.cta) html += `<input data-path="pages.${pi}.sections.${si}.cta.label" value="${esc(sec.cta.label)}">`;
      html += '</div>';
    });
    html += '</details>';
  });
  html += `<div class="row"><button class="btn primary" id="btn-save">Guardar y actualizar vista previa</button></div>`;
  $('#sub-contenido').innerHTML = html;
  $('#btn-save').addEventListener('click', saveContent);
}

async function saveContent() {
  const spec = structuredClone(PROJECT.result.spec);
  $$('#sub-contenido [data-path]').forEach((el) => {
    const keys = el.dataset.path.split('.');
    let o = spec;
    for (const k of keys.slice(0, -1)) o = o[k];
    o[keys.at(-1)] = el.value;
  });
  const r = await api(`/api/projects/${PROJECT.id}/spec`, { method: 'PUT', body: { spec } });
  PROJECT = await api(`/api/projects/${PROJECT.id}`);
  refreshPreview();
  renderContentEditor();
  renderPublish();
  return r;
}

function renderDesignEditor() {
  const d = PROJECT.result.design;
  const t = d.tokens;
  const color = (k, label) => `<label>${label}<input type="color" data-token="${k}" value="${esc(t[k])}"></label>`;
  $('#sub-diseno').innerHTML = `
    <div class="grid-form">${color('primary', 'Primario')}${color('accent', 'Acento')}${color('bg', 'Fondo')}${color('surface', 'Superficie')}${color('text', 'Texto')}${color('muted', 'Texto secundario')}
    <label>Fuente titulares<input data-token="headingFont" value="${esc(t.headingFont)}"></label><label>Fuente texto<input data-token="bodyFont" value="${esc(t.bodyFont)}"></label>
    <label>Radio<input data-token="radius" value="${esc(t.radius)}"></label>
    <label>Hero<select id="hero-variant">${['split', 'centered', 'editorial', 'fullbleed'].map((v) => `<option ${v === d.heroVariant ? 'selected' : ''}>${v}</option>`).join('')}</select></label></div>
    <div class="row"><button class="btn primary" id="btn-design">Aplicar</button></div>
    ${d.rationale?.length ? `<h2>Razonamiento de diseño</h2><ul>${d.rationale.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    ${d.rejectedTokens?.length ? `<p class="notice">Tokens de la IA descartados por contraste u originalidad: ${esc(d.rejectedTokens.join(', '))}</p>` : ''}
    ${PROJECT.result.qa ? `<h2>Revisión visual</h2><pre class="prompt">${esc(JSON.stringify(PROJECT.result.qa, null, 2))}</pre>` : ''}
    ${PROJECT.result.mediaSources?.length ? `<h2>Fuentes de imágenes</h2><table>${PROJECT.result.mediaSources.map((s) => `<tr><td>${esc(s.kind)}</td><td>${esc(s.status)}</td><td class="small">${esc(s.url)}</td></tr>`).join('')}</table>` : ''}`;
  $('#btn-design').addEventListener('click', async () => {
    const tokens = Object.fromEntries($$('#sub-diseno [data-token]').map((el) => [el.dataset.token, el.value]));
    await api(`/api/projects/${PROJECT.id}/spec`, { method: 'PUT', body: { tokens, heroVariant: $('#hero-variant').value } });
    PROJECT = await api(`/api/projects/${PROJECT.id}`);
    refreshPreview();
  });
}

async function renderResearch() {
  try {
    const r = await api(`/api/projects/${PROJECT.id}/research`);
    $('#sub-investigacion').innerHTML = `
      <p><b>${r.references.length}</b> referencias analizadas · búsqueda: ${esc(r.searchProvider)} · ${esc(r.createdAt.slice(0, 10))}</p>
      <table class="refs"><tr><th>Referencia</th><th>Hallazgos</th></tr>
      ${r.references.map((ref) => `<tr><td>${ref.screenshot ? `<img src="/sector-assets/${esc(r.id)}/${esc(ref.screenshot)}" alt="">` : ''}<a href="${esc(ref.url.startsWith('fixture') ? '#' : ref.url)}" target="_blank" rel="noopener">${esc(ref.host)}</a></td>
        <td class="small"><b>Secciones:</b> ${esc(ref.sections.join(' → '))}<br><b>Tono:</b> ${esc(ref.analysis?.toneSummary || '')}<br><b>CTAs:</b> ${esc((ref.ctas || []).slice(0, 4).join(' · '))}<br><b>Colores:</b> ${(ref.colors?.brand || []).slice(0, 4).map((c) => `<span class="dot" style="background:${esc(c.hex)}"></span>${esc(c.hex)}`).join(' ')}<br><b>Fuentes:</b> ${esc((ref.fonts || []).map((f) => f.name).join(', '))}</td></tr>`).join('')}
      </table>
      <h2>Master prompt del sector</h2><pre class="prompt">${esc(r.masterPrompt)}</pre>`;
  } catch (err) {
    $('#sub-investigacion').textContent = err.message;
  }
}

function renderDecisions() {
  $('#sub-decisiones').innerHTML = `<p class="muted small">Cada decisión enlaza con la evidencia de las referencias analizadas.</p>
    <table><tr><th>Área</th><th>Decisión</th><th>Justificación</th></tr>${PROJECT.result.decisions.map((d) => `<tr><td>${esc(d.area)}</td><td>${esc(d.decision)}</td><td class="small">${esc(d.justification)}${d.references?.length ? `<br><span class="muted">${d.references.length} referencias</span>` : ''}</td></tr>`).join('')}</table>
    <p class="small">Originalidad: ${PROJECT.result.originality.original ? '✓ sin fragmentos copiados' : `${PROJECT.result.originality.issues.length} fragmentos coinciden con referencias`}${PROJECT.result.originality.rewritten ? ` (reescritos ${PROJECT.result.originality.rewritten})` : ''}</p>`;
}

function renderPublish() {
  const dep = PROJECT.deploy;
  const approved = PROJECT.status === 'approved' || PROJECT.status === 'live' || dep;
  $('#sub-publicar').innerHTML = `
    ${!approved ? `<p>Revisa la web y apruébala para poder publicarla.</p><button class="btn primary" id="btn-approve">Aprobar la web</button>` : '<p>✓ Web aprobada</p>'}
    <div class="${approved ? '' : 'hidden'}">
      <h2>Publicar con mi dominio</h2>
      <div class="row"><input id="domain" placeholder="tudominio.com" value="${esc(dep?.domain || '')}"><button class="btn" id="btn-check">¿Disponible?</button></div>
      <div id="domain-info" class="small muted"></div>
      ${PROJECT.placeholders ? `<label class="inline"><input type="checkbox" id="force"> Publicar omitiendo los ${PROJECT.placeholders} datos pendientes</label>` : ''}
      <div class="row"><button class="btn primary" id="btn-deploy">Publicar con mi dominio</button>${dep?.buildId ? '<button class="btn" id="btn-verify">Verificar ahora</button>' : ''}</div>
      ${dep ? `<div class="notice">Estado: <b>${esc(dep.status)}</b>${dep.liveUrl ? ` · <a href="${esc(dep.liveUrl)}" target="_blank" rel="noopener">${esc(dep.liveUrl)}</a>` : ''}${dep.hostingUrl ? `<br>Hosting: <a href="${esc(dep.hostingUrl)}" target="_blank" rel="noopener">${esc(dep.hostingUrl)}</a>` : ''}${dep.error ? `<br>${esc(dep.error)}` : ''}</div>` : ''}
      ${dep?.dns?.instructions ? `<h2>DNS</h2><pre class="prompt">${esc(dep.dns.instructions)}</pre>` : ''}
      ${dep?.note ? `<p class="small muted">${esc(dep.note)}</p>` : ''}
      <ol id="deploy-log" class="log"></ol>
    </div>`;
  $('#btn-approve')?.addEventListener('click', async () => {
    await api(`/api/projects/${PROJECT.id}/approve`, { method: 'POST' });
    PROJECT = await api(`/api/projects/${PROJECT.id}`);
    renderPublish();
  });
  $('#btn-check')?.addEventListener('click', async () => {
    const r = await api(`/api/domains/check?domain=${encodeURIComponent($('#domain').value)}`);
    $('#domain-info').textContent = r.available === true ? 'Parece libre: cómpralo en tu registrador y vuelve a pulsar Publicar.' : r.available === false ? `Registrado${r.registrar ? ` (${r.registrar})` : ''}. Si es tuyo, publica.` : r.note || 'No se pudo comprobar.';
  });
  $('#btn-deploy')?.addEventListener('click', async () => {
    try {
      const { jobId } = await api(`/api/projects/${PROJECT.id}/deploy`, { method: 'POST', body: { domain: $('#domain').value, force: $('#force')?.checked } });
      await followJob(jobId, $('#deploy-log')).catch((e) => $('#deploy-log').insertAdjacentHTML('beforeend', `<li>${esc(e.message)}</li>`));
    } catch (err) {
      $('#deploy-log').innerHTML = `<li>${esc(err.message)}</li>`;
    }
    PROJECT = await api(`/api/projects/${PROJECT.id}`);
    renderPublish();
  });
  $('#btn-verify')?.addEventListener('click', async () => {
    const { jobId } = await api(`/api/projects/${PROJECT.id}/verify`, { method: 'POST' });
    await followJob(jobId, $('#deploy-log')).catch(() => {});
    PROJECT = await api(`/api/projects/${PROJECT.id}`);
    renderPublish();
  });
}

// ---------------- Mapa de prospección ----------------
let map, layer, LEADS = [];
const STATUS_COLOR = { 'sin-web': '#dc2626', caida: '#ea580c', mejorable: '#d97706', correcta: '#16a34a', pendiente: '#2563eb' };
const leadStatus = (l) => l.webStatus || (l.website ? 'pendiente' : 'sin-web');

function initMap() {
  if (map) return map.invalidateSize();
  const [s, w, n, e] = STATUS.leads.bbox;
  map = L.map('map').fitBounds([[s, w], [n, e]]);
  L.tileLayer(STATUS.leads.tileUrl, { maxZoom: 19, attribution: STATUS.leads.tileAttribution }).addTo(map);
  layer = L.layerGroup().addTo(map);
  loadLeads();
}

async function loadLeads() {
  LEADS = await api('/api/leads');
  renderLeads();
}

function visibleLeads() {
  const st = $('#f-status').value;
  const onlyEmail = $('#f-email').checked;
  return LEADS.filter((l) => (!st || leadStatus(l) === st) && (!onlyEmail || l.email));
}

function renderLeads() {
  const leads = visibleLeads();
  layer.clearLayers();
  for (const l of leads) {
    const m = L.circleMarker([l.lat, l.lon], { radius: 7, color: '#fff', weight: 1.5, fillColor: STATUS_COLOR[leadStatus(l)], fillOpacity: 0.95 });
    m.bindPopup(`<b>${esc(l.name)}</b><br>${esc(l.sector)}${l.city ? ` · ${esc(l.city)}` : ''}<br>Web: ${l.website ? `<a href="${esc(l.website)}" target="_blank" rel="noopener">${esc(l.website)}</a>` : 'no tiene'} (${esc(leadStatus(l))})<br>${l.email ? `Email: ${esc(l.email)}` : 'Sin email'}${l.phone ? `<br>Tel: ${esc(l.phone)}` : ''}${l.demo?.url ? `<br><a href="${esc(l.demo.url)}" target="_blank" rel="noopener">Ver demo</a>` : ''}<br><span class="small">Contacto: ${esc(l.outreach?.status || 'nuevo')}${l.suppressed ? ' · dado de baja' : ''}</span>`);
    m.addTo(layer);
  }
  $('#lead-count').textContent = `${leads.length} de ${LEADS.length} negocios · ${LEADS.filter((l) => l.email).length} con email`;
  $('#lead-list').innerHTML = leads
    .slice(0, 500)
    .map((l) => `<li><input type="checkbox" class="lead-sel" value="${esc(l.id)}"><div><span class="dot st-${leadStatus(l)}"></span><b>${esc(l.name)}</b> <span class="muted">· ${esc(l.sector)}${l.city ? ` · ${esc(l.city)}` : ''}</span><br><span class="small muted">${l.email ? esc(l.email) : 'sin email'}${l.demo?.url ? ` · <a href="${esc(l.demo.url)}" target="_blank" rel="noopener">demo</a>` : ''} · ${esc(l.outreach?.status || 'nuevo')}${l.suppressed ? ' · baja' : ''}</span></div></li>`)
    .join('');
}
$('#f-status').addEventListener('change', renderLeads);
$('#f-email').addEventListener('change', renderLeads);
$('#sel-all').addEventListener('change', (e) => $$('.lead-sel').forEach((c) => (c.checked = e.target.checked)));
const selected = () => $$('.lead-sel:checked').map((c) => c.value);

async function runMapJob(promise) {
  try {
    const { jobId } = await promise;
    const job = await followJob(jobId, $('#map-log'));
    await loadLeads();
    return job;
  } catch (err) {
    $('#map-log').insertAdjacentHTML('beforeend', `<li>${esc(err.message)}</li>`);
  }
}
$('#btn-search').addEventListener('click', () => runMapJob(api('/api/leads/search', { method: 'POST', body: { sectorIds: $$('#sector-checks input:checked').map((c) => c.value) } })));
$('#btn-enrich').addEventListener('click', () => runMapJob(api('/api/leads/enrich', { method: 'POST', body: { ids: selected() } })));
$('#btn-demos').addEventListener('click', () => runMapJob(api('/api/leads/demos', { method: 'POST', body: { ids: selected() } })));
$('#btn-campaign').addEventListener('click', async () => {
  const ids = selected();
  if (!ids.length) return alert('Selecciona negocios en la lista');
  const job = await runMapJob(api('/api/campaigns', { method: 'POST', body: { leadIds: ids } }));
  if (!job?.result?.campaignId) return;
  const c = await api(`/api/campaigns/${job.result.campaignId}`);
  dialog(`<h2>Revisar campaña (${c.messages.length} emails)</h2>
    ${c.skipped.length ? `<p class="notice">Omitidos: ${c.skipped.map((s) => `${esc(s.name)} (${esc(s.reason)})`).join(', ')}</p>` : ''}
    ${c.messages.map((m) => `<div class="msg"><b>Para:</b> ${esc(m.name)} &lt;${esc(m.to)}&gt;<br><b>Asunto:</b> ${esc(m.subject)}<br><a href="${esc(m.demoUrl)}" target="_blank" rel="noopener">Ver demo</a><hr>${esc(m.text)}</div>`).join('')}
    <p class="notice">${STATUS.mail.dryRun ? 'Modo simulación: los emails se guardan en data/outbox y NO se envían. Para enviar de verdad configura MAIL_DRY_RUN=false y un proveedor.' : `Se enviarán emails REALES (máx. ${STATUS.mail.dailyLimit}/día). La LSSI exige consentimiento previo para comunicaciones comerciales por email.`}</p>
    <label class="inline"><input type="checkbox" id="confirm-send"> Confirmo que he revisado los mensajes y asumo la responsabilidad del envío</label>
    <div class="row"><button type="button" class="btn primary" id="btn-send">${STATUS.mail.dryRun ? 'Simular envío' : 'Enviar'}</button></div><ol id="send-log" class="log"></ol>`);
  $('#btn-send').addEventListener('click', async () => {
    if (!$('#confirm-send').checked) return alert('Marca la confirmación');
    const { jobId } = await api(`/api/campaigns/${c.id}/send`, { method: 'POST', body: { confirm: true } });
    await followJob(jobId, $('#send-log')).catch((e) => $('#send-log').insertAdjacentHTML('beforeend', `<li>${esc(e.message)}</li>`));
    loadLeads();
  });
});

// ---------------- Sectores ----------------
async function loadSectors() {
  const s = await api('/api/sectors');
  $('#sector-list-view').innerHTML = s.researched.length
    ? `<table><tr><th>Sector</th><th>Zona</th><th>Referencias</th><th>Fecha</th><th></th></tr>${s.researched.map((x) => `<tr><td>${esc(x.sector)}</td><td>${esc(x.location || '—')}</td><td>${x.references}</td><td>${esc(x.createdAt.slice(0, 10))}</td><td><button class="btn" data-mp="${esc(x.id)}">Ver master prompt</button></td></tr>`).join('')}</table>`
    : '<p class="muted">Aún no hay sectores investigados.</p>';
  $$('[data-mp]').forEach((b) =>
    b.addEventListener('click', async () => {
      const rec = await api(`/api/sectors/${b.dataset.mp}`);
      $('#master-prompt').textContent = rec.masterPrompt;
      $('#master-prompt').classList.remove('hidden');
    }),
  );
}
$('#form-sector').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  body.force = Boolean(body.force);
  const { jobId } = await api('/api/sectors/research', { method: 'POST', body });
  $('#master-prompt').classList.remove('hidden');
  $('#master-prompt').textContent = 'Investigando…';
  const logEl = document.createElement('ol');
  await followJob(jobId, logEl).catch((err) => ($('#master-prompt').textContent = err.message));
  loadSectors();
});

// ---------------- Ajustes ----------------
async function loadSettings() {
  STATUS = await api('/api/status');
  const o = STATUS.ai.oauth;
  $('#ai-status').innerHTML = `<p>Investigación: <b>${esc(STATUS.ai.research)}</b><br>Generación: <b>${esc(STATUS.ai.generation)}</b><br>Autenticación: <b>${esc(STATUS.ai.auth)}</b>${STATUS.ai.auth === 'oauth' ? ` · flujo ${esc(o.grant)} · ${o.configured ? 'configurado' : 'sin configurar'} · ${o.connected ? '✓ conectado' : '✗ no conectado'}` : ''}</p>`;
  $('#status-json').textContent = JSON.stringify(STATUS, null, 2);
  const skills = await api('/api/skills');
  $('#skills').innerHTML = `<p class="muted small">${skills.length} skills. "inject": siempre en el prompt · "tool": GPT-6 Luna la carga bajo demanda.</p><table><tr><th>Skill</th><th>Tareas</th><th>Carga</th><th>Origen</th></tr>${skills.map((s) => `<tr><td><b>${esc(s.name)}</b><br><span class="small muted">${esc(s.description)}</span></td><td class="small">${esc(s.tasks.join(', '))}${s.sectors.length ? `<br>sectores: ${esc(s.sectors.join(', '))}` : ''}</td><td>${esc(s.load)}</td><td class="small">${esc(s.origin)}${s.license ? `<br>${esc(s.license)}` : ''}</td></tr>`).join('')}</table>`;
}
$('#btn-mcp').addEventListener('click', async () => {
  $('#mcp-status').textContent = 'Arrancando servidores MCP…';
  const st = await api('/api/mcp/status');
  $('#mcp-status').innerHTML = Object.entries(st).map(([k, v]) => `<p><b>${esc(k)}</b>: ${!v.enabled ? 'desactivado' : v.ok ? `✓ ${esc(v.server?.name || '')} ${esc(v.server?.version || '')} · ${v.tools.length} herramientas` : `✗ ${esc(v.error)}`}</p>`).join('');
});
$('#btn-llm-off').addEventListener('click', async () => {
  await api('/api/auth/llm/disconnect', { method: 'POST' });
  loadSettings();
});

boot().catch((err) => dialog(`<h2>Error</h2><p>${esc(err.message)}</p>`));
