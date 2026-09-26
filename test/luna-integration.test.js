// Integración de extremo a extremo del núcleo de IA con un servidor falso compatible con OpenAI que hace de
// gpt-6-luna: OAuth client_credentials → skills (inject + load_skill) → herramientas MCP reales (Playwright) → capturas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildConfig } from '../src/config.js';
import { FileStore } from '../src/lib/store.js';
import { createAI } from '../src/ai/index.js';

const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const canRunBrowser = fs.existsSync(CHROMIUM) && !process.env.SKIP_MCP_TESTS;

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(srv));
  });
}
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });

test('gpt-6-luna vía OAuth usa skills y herramientas MCP de Playwright', { skip: !canRunBrowser && 'Chromium no disponible', timeout: 240_000 }, async () => {
  const page = await listen((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>Demo Luna</title><h1 style="color:#b4532a;font-family:Georgia">Hola</h1>');
  });
  const pageUrl = `http://127.0.0.1:${page.address().port}/`;

  const seen = { tokenRequests: 0, models: new Set(), systemPrompts: [], sawImage: false, toolNames: [] };
  let step = 0;
  const llm = await listen(async (req, res) => {
    const body = await readBody(req);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/oauth/token') {
      seen.tokenRequests++;
      assert.match(body, /grant_type=client_credentials/);
      return res.end(JSON.stringify({ access_token: 'tok-luna', token_type: 'Bearer', expires_in: 3600 }));
    }
    assert.equal(req.headers.authorization, 'Bearer tok-luna');
    const json = JSON.parse(body);
    seen.models.add(json.model);
    seen.systemPrompts.push(json.messages[0].content);
    seen.toolNames = (json.tools || []).map((t) => t.function.name);
    seen.sawImage ||= json.messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url'));
    const call = (name, args) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `c${step}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
    step++;
    if (step === 1) return res.end(JSON.stringify(call('load_skill', { name: 'emil-review-animations' })));
    if (step === 2) return res.end(JSON.stringify(call('playwright__browser_navigate', { url: pageUrl })));
    if (step === 3) return res.end(JSON.stringify(call('playwright__browser_take_screenshot', { type: 'png' })));
    return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ score: 8, issues: [], fixesCss: '' }) } }] }));
  });
  const llmUrl = `http://127.0.0.1:${llm.address().port}`;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-'));
  const config = buildConfig({
    DATA_DIR: dataDir,
    OPENAI_BASE_URL: `${llmUrl}/v1`,
    LLM_AUTH: 'oauth',
    OAUTH_GRANT: 'client_credentials',
    OAUTH_TOKEN_URL: `${llmUrl}/oauth/token`,
    OAUTH_CLIENT_ID: 'cid',
    OAUTH_CLIENT_SECRET: 'secret',
    CHROMIUM_PATH: CHROMIUM,
    MCP_CHROME_DEVTOOLS: 'off',
    PUBLIC_URL: pageUrl,
  });
  const ai = createAI({ config, store: new FileStore(dataDir) });
  try {
    const { data, meta } = await ai.generation.run('designReview', { business: { name: 'Demo' }, previewUrl: pageUrl, spec: {} });
    assert.equal(data.score, 8);
    assert.deepEqual([...seen.models], ['gpt-6-luna']);
    assert.equal(seen.tokenRequests, 1, 'el token OAuth se reutiliza entre llamadas');
    assert.match(seen.systemPrompts[0], /### Skill: frontend-design/);
    assert.match(seen.systemPrompts[0], /### Skill: impeccable/);
    assert.ok(seen.toolNames.includes('load_skill'));
    assert.ok(seen.toolNames.includes('playwright__browser_take_screenshot'));
    assert.ok(seen.sawImage, 'la captura de Playwright llega al modelo como imagen');
    assert.ok(meta.skills.includes('emil-review-animations'));
    assert.deepEqual(meta.tools, ['playwright__browser_navigate', 'playwright__browser_take_screenshot']);
  } finally {
    ai.mcp.closeAll();
    page.close();
    llm.close();
  }
});
