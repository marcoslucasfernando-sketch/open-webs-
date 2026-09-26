import fs from 'node:fs';
import path from 'node:path';
import { defaultMcpServers } from './ai/mcp.js';

// Carga mínima de .env (sin dependencias). Las variables ya definidas en el entorno tienen prioridad.
export function loadDotEnv(file = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

export function buildConfig(env = process.env) {
  const port = int(env.PORT, 3000);
  const publicUrl = env.PUBLIC_URL || `http://localhost:${port}`;
  return {
    port,
    publicUrl,
    dataDir: path.resolve(env.DATA_DIR || 'data'),
    panelToken: env.PANEL_TOKEN || '',
    secretKey: env.SECRET_KEY || '',

    ai: {
      // Formato "proveedor:modelo". Cada rol puede usar un modelo distinto.
      research: env.AI_RESEARCH || 'openai:gpt-6-luna',
      generation: env.AI_GENERATION || 'openai:gpt-6-luna',
      skillsDir: env.SKILLS_DIR || '',
      skillsMode: env.SKILLS_MODE || 'hybrid', // hybrid | inject | tools
      skillsMaxChars: int(env.SKILLS_MAX_CHARS, 60_000),
      openai: {
        baseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
        apiVersion: env.OPENAI_API_VERSION || '', // p. ej. Azure OpenAI: 2025-04-01-preview
        auth: env.LLM_AUTH || 'oauth', // oauth | apikey
        apiKey: env.OPENAI_API_KEY || '',
        temperature: env.LLM_TEMPERATURE === undefined ? undefined : Number(env.LLM_TEMPERATURE),
        timeoutMs: int(env.LLM_TIMEOUT_MS, 180_000),
        vision: bool(env.LLM_VISION, true), // enviar capturas al modelo
      },
      oauth: {
        grant: env.OAUTH_GRANT || 'client_credentials', // client_credentials | authorization_code
        tokenUrl: env.OAUTH_TOKEN_URL || '',
        authorizeUrl: env.OAUTH_AUTHORIZE_URL || '',
        clientId: env.OAUTH_CLIENT_ID || '',
        clientSecret: env.OAUTH_CLIENT_SECRET || '',
        clientAuth: env.OAUTH_CLIENT_AUTH || 'post', // post | basic
        scope: env.OAUTH_SCOPE || '',
        audience: env.OAUTH_AUDIENCE || '',
        redirectUri: env.OAUTH_REDIRECT_URI || `${publicUrl}/auth/llm/callback`,
      },
    },

    mcp: {
      servers: defaultMcpServers(env),
    },

    research: {
      searchProvider: env.SEARCH_PROVIDER || 'fixture', // brave | serpapi | tavily | fixture
      braveApiKey: env.BRAVE_API_KEY || '',
      serpapiKey: env.SERPAPI_KEY || '',
      tavilyApiKey: env.TAVILY_API_KEY || '',
      minReferences: int(env.MIN_REFERENCES, 10),
      maxCandidates: int(env.MAX_CANDIDATES, 30),
      sectorCacheDays: int(env.SECTOR_CACHE_DAYS, 30),
      fetchTimeoutMs: int(env.FETCH_TIMEOUT_MS, 15_000),
      userAgent: env.CRAWLER_USER_AGENT || 'OpenWebsResearchBot/0.1 (+https://github.com/marcoslucasfernando-sketch/open-webs-)',
      respectRobots: bool(env.RESPECT_ROBOTS, true),
    },

    deploy: {
      hosting: env.HOSTING_PROVIDER || 'local', // netlify | local
      dns: env.DNS_PROVIDER || 'manual', // cloudflare | netlify | manual
      registrar: env.REGISTRAR_PROVIDER || 'manual', // namecheap | manual
      netlifyToken: env.NETLIFY_AUTH_TOKEN || '',
      netlifyAccountSlug: env.NETLIFY_ACCOUNT_SLUG || '',
      cloudflareToken: env.CLOUDFLARE_API_TOKEN || '',
      namecheap: {
        apiUser: env.NAMECHEAP_API_USER || '',
        apiKey: env.NAMECHEAP_API_KEY || '',
        username: env.NAMECHEAP_USERNAME || env.NAMECHEAP_API_USER || '',
        clientIp: env.NAMECHEAP_CLIENT_IP || '',
        sandbox: bool(env.NAMECHEAP_SANDBOX, true),
      },
      verifyTimeoutMs: int(env.VERIFY_TIMEOUT_MS, 30 * 60_000),
      verifyIntervalMs: int(env.VERIFY_INTERVAL_MS, 20_000),
    },

    leads: {
      placesProvider: env.PLACES_PROVIDER || 'fixture', // overpass | google | fixture
      googlePlacesKey: env.GOOGLE_PLACES_API_KEY || '',
      overpassUrl: env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter',
      // Gran Canaria: sur, oeste, norte, este
      bbox: (env.LEADS_BBOX || '27.73,-15.84,28.19,-15.35').split(',').map(Number),
      region: env.LEADS_REGION || 'Gran Canaria',
      demoHosting: env.DEMO_HOSTING || 'platform', // platform (/demo/<id>/) | netlify (subdominio *.netlify.app)
    },

    mail: {
      provider: env.MAIL_PROVIDER || 'outbox', // outbox (no envía, guarda .eml) | resend | brevo | smtp
      dryRun: bool(env.MAIL_DRY_RUN, true),
      from: env.MAIL_FROM || 'Open Webs <hola@example.com>',
      replyTo: env.MAIL_REPLY_TO || '',
      senderName: env.SENDER_NAME || 'Tu nombre',
      senderCompany: env.SENDER_COMPANY || 'Tu empresa',
      senderAddress: env.SENDER_ADDRESS || '[[Dirección postal del remitente]]',
      resendApiKey: env.RESEND_API_KEY || '',
      brevoApiKey: env.BREVO_API_KEY || '',
      smtpUrl: env.SMTP_URL || '',
      dailyLimit: int(env.MAIL_DAILY_LIMIT, 50),
      minIntervalMs: int(env.MAIL_MIN_INTERVAL_MS, 30_000),
    },
  };
}
