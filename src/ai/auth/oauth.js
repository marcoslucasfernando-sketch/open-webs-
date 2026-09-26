import crypto from 'node:crypto';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Gestor de tokens OAuth 2.0 para el proveedor de IA.
//  - client_credentials: servidor a servidor (p. ej. Azure OpenAI con Entra ID, o un gateway OAuth delante del modelo).
//  - authorization_code + PKCE: el operador conecta su cuenta desde el panel; se guardan access/refresh token cifrados
//    y se refrescan automáticamente.
export class OAuthTokenManager {
  constructor(cfg, { store, fetch = globalThis.fetch, secretId = 'llm-oauth' } = {}) {
    this.cfg = cfg;
    this.secretId = secretId;
    this.store = store;
    this.fetch = fetch;
    this.cached = null;
    this.pending = new Map(); // state -> { codeVerifier, createdAt }
  }

  get grant() {
    return this.cfg.grant;
  }

  status() {
    const tokens = this.#load();
    return {
      grant: this.cfg.grant,
      configured: Boolean(this.cfg.tokenUrl && this.cfg.clientId),
      connected: this.cfg.grant === 'client_credentials' ? Boolean(this.cfg.clientSecret) : Boolean(tokens?.access_token),
      expiresAt: tokens?.expires_at ?? null,
      hasRefreshToken: Boolean(tokens?.refresh_token),
      scope: tokens?.scope ?? this.cfg.scope,
    };
  }

  async getAccessToken() {
    const tokens = this.#load();
    if (tokens?.access_token && (!tokens.expires_at || tokens.expires_at - 60_000 > Date.now())) return tokens.access_token;

    if (this.cfg.grant === 'client_credentials') {
      const params = { grant_type: 'client_credentials' };
      if (this.cfg.scope) params.scope = this.cfg.scope;
      if (this.cfg.audience) params.audience = this.cfg.audience;
      return (await this.#tokenRequest(params)).access_token;
    }

    if (tokens?.refresh_token) {
      const params = { grant_type: 'refresh_token', refresh_token: tokens.refresh_token };
      if (this.cfg.scope) params.scope = this.cfg.scope;
      return (await this.#tokenRequest(params, tokens.refresh_token)).access_token;
    }
    throw new Error('OAuth no conectado: abre el panel y pulsa "Conectar proveedor de IA" (/auth/llm/start)');
  }

  invalidate() {
    const tokens = this.#load();
    if (tokens) this.#save({ ...tokens, access_token: null, expires_at: 0 });
  }

  // Paso 1 del flujo authorization_code: URL de autorización con PKCE (S256).
  buildAuthorizeUrl() {
    if (!this.cfg.authorizeUrl) throw new Error('OAUTH_AUTHORIZE_URL no configurado');
    const state = b64url(crypto.randomBytes(16));
    const codeVerifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest());
    this.pending.set(state, { codeVerifier, createdAt: Date.now() });
    const url = new URL(this.cfg.authorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.cfg.clientId);
    url.searchParams.set('redirect_uri', this.cfg.redirectUri);
    if (this.cfg.scope) url.searchParams.set('scope', this.cfg.scope);
    if (this.cfg.audience) url.searchParams.set('audience', this.cfg.audience);
    if (this.cfg.resource) url.searchParams.set('resource', this.cfg.resource);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { url: url.toString(), state };
  }

  // Paso 2: intercambio del código por tokens.
  async exchangeCode(code, state) {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || Date.now() - pending.createdAt > 10 * 60_000) throw new Error('state OAuth no válido o caducado');
    return this.#tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.cfg.redirectUri,
      code_verifier: pending.codeVerifier,
    });
  }

  disconnect() {
    this.cached = null;
    this.store?.putSecret(this.secretId, null);
  }

  async #tokenRequest(params, previousRefreshToken) {
    if (!this.cfg.tokenUrl) throw new Error('OAUTH_TOKEN_URL no configurado');
    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    const body = new URLSearchParams(params);
    if (this.cfg.resource) body.set('resource', this.cfg.resource); // RFC 8707 (requerido por la especificación MCP)
    if (this.cfg.clientAuth === 'basic' && this.cfg.clientSecret) {
      const basic = Buffer.from(`${encodeURIComponent(this.cfg.clientId)}:${encodeURIComponent(this.cfg.clientSecret)}`).toString('base64');
      headers.authorization = `Basic ${basic}`;
    } else {
      body.set('client_id', this.cfg.clientId);
      if (this.cfg.clientSecret) body.set('client_secret', this.cfg.clientSecret);
    }
    const res = await this.fetch(this.cfg.tokenUrl, { method: 'POST', headers, body: body.toString() });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = {};
    }
    if (!res.ok || !json.access_token) {
      throw new Error(`Error OAuth (${res.status}): ${json.error_description || json.error || text.slice(0, 200)}`);
    }
    const tokens = {
      access_token: json.access_token,
      token_type: json.token_type || 'Bearer',
      refresh_token: json.refresh_token || previousRefreshToken || null,
      scope: json.scope || this.cfg.scope,
      expires_at: json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : null,
    };
    this.#save(tokens);
    return tokens;
  }

  #load() {
    if (this.cached) return this.cached;
    this.cached = this.store?.getSecret(this.secretId) ?? null;
    return this.cached;
  }

  #save(tokens) {
    this.cached = tokens;
    this.store?.putSecret(this.secretId, tokens);
  }
}
