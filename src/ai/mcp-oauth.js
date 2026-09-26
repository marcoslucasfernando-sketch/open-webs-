import { OAuthTokenManager } from './auth/oauth.js';

// OAuth para servidores MCP remotos según la especificación MCP (descubrimiento RFC 9728/8414, registro dinámico
// RFC 7591 y PKCE). Usado para el MCP oficial de Figma (https://mcp.figma.com/mcp, scope mcp:connect).
export class McpOAuth {
  constructor(name, { resourceUrl, redirectUri, store, fetch = globalThis.fetch, clientName = 'Open Webs' }) {
    this.name = name;
    this.resourceUrl = resourceUrl;
    this.redirectUri = redirectUri;
    this.store = store;
    this.fetch = fetch;
    this.clientName = clientName;
    this.manager = null;
  }

  async #discover() {
    const origin = new URL(this.resourceUrl).origin;
    const pr = await (await this.fetch(`${origin}/.well-known/oauth-protected-resource`)).json();
    const as = pr.authorization_servers?.[0];
    if (!as) throw new Error(`MCP ${this.name}: sin servidor de autorización`);
    const meta = await (await this.fetch(`${as.replace(/\/$/, '')}/.well-known/oauth-authorization-server`)).json();
    return { meta, scope: (pr.scopes_supported || []).join(' ') };
  }

  async #client(meta) {
    const key = `mcp-client-${this.name}`;
    const saved = this.store.getSecret(key);
    if (saved?.client_id && saved.redirect_uri === this.redirectUri) return saved;
    if (!meta.registration_endpoint) throw new Error(`MCP ${this.name}: no admite registro dinámico; configura un client_id manualmente`);
    const res = await this.fetch(meta.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: this.clientName,
        redirect_uris: [this.redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.client_id) throw new Error(`MCP ${this.name}: registro de cliente rechazado (${res.status}) ${JSON.stringify(json).slice(0, 200)}`);
    const client = { client_id: json.client_id, client_secret: json.client_secret || '', redirect_uri: this.redirectUri };
    this.store.putSecret(key, client);
    return client;
  }

  async getManager() {
    if (this.manager) return this.manager;
    const { meta, scope } = await this.#discover();
    const client = await this.#client(meta);
    this.manager = new OAuthTokenManager(
      {
        grant: 'authorization_code',
        authorizeUrl: meta.authorization_endpoint,
        tokenUrl: meta.token_endpoint,
        clientId: client.client_id,
        clientSecret: client.client_secret,
        clientAuth: 'post',
        scope,
        redirectUri: this.redirectUri,
        resource: this.resourceUrl,
      },
      { store: this.store, fetch: this.fetch, secretId: `mcp-oauth-${this.name}` },
    );
    return this.manager;
  }

  // Token para el transporte HTTP del cliente MCP (se refresca automáticamente).
  async token() {
    return (await this.getManager()).getAccessToken();
  }

  connected() {
    return Boolean(this.store.getSecret(`mcp-oauth-${this.name}`)?.access_token || this.store.getSecret(`mcp-oauth-${this.name}`)?.refresh_token);
  }
}
