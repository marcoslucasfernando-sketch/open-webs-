// Proveedor para APIs compatibles con OpenAI Chat Completions (OpenAI, Azure OpenAI, gateways).
// Modelo por defecto: gpt-6-luna. Autenticación: OAuth 2.0 (Bearer obtenido por OAuthTokenManager) o API key.
export class OpenAIProvider {
  constructor({ model, config, oauth, fetch = globalThis.fetch }) {
    this.name = 'openai';
    this.model = model;
    this.cfg = config;
    this.oauth = oauth;
    this.fetch = fetch;
  }

  async #authHeader() {
    if (this.cfg.auth === 'apikey') {
      if (!this.cfg.apiKey) throw new Error('LLM_AUTH=apikey pero OPENAI_API_KEY está vacío');
      return `Bearer ${this.cfg.apiKey}`;
    }
    return `Bearer ${await this.oauth.getAccessToken()}`;
  }

  #url(path) {
    const url = new URL(`${this.cfg.baseUrl}${path}`);
    if (this.cfg.apiVersion) url.searchParams.set('api-version', this.cfg.apiVersion);
    return url.toString();
  }

  async listModels() {
    const res = await this.fetch(this.#url('/models'), { headers: { authorization: await this.#authHeader() } });
    if (!res.ok) throw new Error(`GET /models → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    return (json.data || []).map((m) => m.id);
  }

  async generateJSON({ system, prompt, tools, images = [] }) {
    const vision = this.cfg.vision !== false;
    const userContent =
      vision && images.length
        ? [{ type: 'text', text: prompt }, ...images.slice(0, 6).map((url) => ({ type: 'image_url', image_url: { url } }))]
        : prompt;
    const messages = [
      { role: 'system', content: `${system}\nResponde ÚNICAMENTE con un objeto JSON válido.` },
      { role: 'user', content: userContent },
    ];
    // Bucle de tool calling (skills bajo demanda + herramientas MCP). Sin tools es una única llamada.
    for (let step = 0; step < 16; step++) {
      const message = await this.#chat(messages, tools?.definitions);
      if (tools && message.tool_calls?.length) {
        messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls });
        const shots = [];
        for (const call of message.tool_calls) {
          let args = {};
          try {
            args = JSON.parse(call.function?.arguments || '{}');
          } catch {}
          const out = await tools.handle(call.function?.name, args);
          const result = typeof out === 'string' ? { text: out } : out || { text: '' };
          if (result.images?.length) shots.push(...result.images);
          messages.push({ role: 'tool', tool_call_id: call.id, content: String(result.text || (result.images?.length ? '[captura adjunta a continuación]' : '')) });
        }
        // Las capturas de las herramientas se entregan como mensaje de usuario (los mensajes "tool" solo admiten texto).
        if (vision && shots.length) {
          messages.push({ role: 'user', content: [{ type: 'text', text: 'Capturas devueltas por las herramientas:' }, ...shots.slice(-4).map((url) => ({ type: 'image_url', image_url: { url } }))] });
        }
        continue;
      }
      return parseJsonLoose(message.content ?? '');
    }
    throw new Error(`LLM ${this.model}: demasiadas llamadas a herramientas`);
  }

  async #chat(messages, toolDefs) {
    const body = { model: this.model, messages, response_format: { type: 'json_object' } };
    if (toolDefs?.length) body.tools = toolDefs;
    if (this.cfg.temperature !== undefined && !Number.isNaN(this.cfg.temperature)) body.temperature = this.cfg.temperature;

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.fetch(this.#url('/chat/completions'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: await this.#authHeader() },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
      if (res.status === 401 && this.cfg.auth !== 'apikey' && attempt === 0) {
        this.oauth.invalidate(); // token revocado o caducado antes de tiempo: se pide uno nuevo
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`LLM ${this.model} → ${res.status}: ${text.slice(0, 300)}`);
      const message = JSON.parse(text).choices?.[0]?.message;
      if (!message) throw new Error(`LLM ${this.model}: respuesta sin mensaje`);
      return message;
    }
    throw new Error(`LLM ${this.model}: reintentos agotados`);
  }
}

export function parseJsonLoose(content) {
  try {
    return JSON.parse(content);
  } catch {
    const m = String(content).match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error(`La respuesta del modelo no es JSON: ${String(content).slice(0, 200)}`);
  }
}
