import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAIProvider } from './providers/openai.js';
import { MockProvider } from './providers/mock.js';
import { OAuthTokenManager } from './auth/oauth.js';
import { SkillRegistry } from './skills.js';
import { McpManager } from './mcp.js';
import { tasks } from './prompts.js';

export const DEFAULT_SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills');

// Registro de proveedores. Para añadir uno nuevo (Anthropic, Gemini, modelo local...) basta con implementar
// generateJSON({ task, system, prompt, input, tools }) y registrarlo aquí; el resto de la plataforma no cambia.
const PROVIDERS = {
  openai: (model, ctx) => new OpenAIProvider({ model, config: ctx.config.ai.openai, oauth: ctx.oauth, fetch: ctx.fetch }),
  mock: (model) => new MockProvider({ model }),
};

// Herramientas MCP que GPT-6 Luna puede usar en cada tarea (lista blanca).
export const TASK_TOOLS = {
  analyzeReference: {
    playwright: ['browser_navigate', 'browser_take_screenshot', 'browser_evaluate', 'browser_resize', 'browser_snapshot', 'browser_wait_for'],
  },
  designReview: {
    playwright: ['browser_navigate', 'browser_take_screenshot', 'browser_resize', 'browser_evaluate', 'browser_snapshot'],
    'chrome-devtools': ['list_pages', 'navigate_page', 'list_console_messages', 'list_network_requests', 'lighthouse_audit', 'performance_start_trace', 'performance_analyze_insight', 'take_screenshot', 'get_css_styles', 'emulate'],
  },
  figmaImport: { figma: '*' },
};

export function parseModelSpec(spec) {
  const [provider, ...rest] = String(spec).split(':');
  return { provider, model: rest.join(':') || provider };
}

// Crea un cliente de IA por rol (research, generation). Cada rol puede usar proveedor/modelo distinto.
export function createAI({ config, store, fetch = globalThis.fetch, skills, mcp }) {
  const oauth = new OAuthTokenManager(config.ai.oauth, { store, fetch });
  const registry =
    skills ||
    new SkillRegistry(config.ai.skillsDir || DEFAULT_SKILLS_DIR, { mode: config.ai.skillsMode || 'hybrid', maxChars: config.ai.skillsMaxChars });
  const mcpManager = mcp || new McpManager(config.mcp?.servers || {}, { allowOrigins: [new URL(config.publicUrl).origin], fetch });
  const ctx = { config, oauth, fetch };

  const makeRole = (role) => {
    const { provider, model } = parseModelSpec(config.ai[role]);
    const factory = PROVIDERS[provider];
    if (!factory) throw new Error(`Proveedor de IA desconocido "${provider}" (rol ${role}). Disponibles: ${Object.keys(PROVIDERS).join(', ')}`);
    const client = factory(model, ctx);
    return {
      role,
      provider,
      model,
      client,
      // Ejecuta una tarea. Devuelve { data, meta } con skills y herramientas usadas (trazabilidad).
      async run(task, input, { sectorId, images = [], useTools = true } = {}) {
        const def = tasks[task];
        if (!def) throw new Error(`Tarea de IA desconocida: ${task}`);
        const allow = useTools && provider !== 'mock' ? TASK_TOOLS[task] || {} : {};
        const available = Object.keys(allow).filter((s) => mcpManager.has(s));
        const skillBlock = registry.build(task, sectorId, available);
        const trace = { skills: [...skillBlock.used], tools: [] };

        const definitions = [];
        if (skillBlock.index.length) {
          definitions.push({
            type: 'function',
            function: {
              name: 'load_skill',
              description: 'Carga las instrucciones completas de una skill por su nombre.',
              parameters: { type: 'object', properties: { name: { type: 'string', enum: skillBlock.index.map((s) => s.name) } }, required: ['name'] },
            },
          });
        }
        if (available.length) definitions.push(...(await mcpManager.functionDefs(Object.fromEntries(available.map((s) => [s, allow[s]])))));

        const tools = definitions.length
          ? {
              definitions,
              async handle(name, args) {
                if (name === 'load_skill') {
                  const skill = registry.get(args?.name);
                  if (!skill) return { text: `Skill no encontrada: ${args?.name}` };
                  trace.skills.push(skill.name);
                  return { text: skill.body };
                }
                trace.tools.push(name);
                try {
                  return await mcpManager.call(name, args);
                } catch (err) {
                  return { text: `ERROR: ${err.message}` };
                }
              },
            }
          : undefined;

        const data = await client.generateJSON({ task, system: def.system + skillBlock.text, prompt: def.prompt(input), input, tools, images });
        return { data, meta: { provider, model, task, skills: [...new Set(trace.skills)], tools: trace.tools } };
      },
    };
  };

  return {
    research: makeRole('research'),
    generation: makeRole('generation'),
    oauth,
    skills: registry,
    mcp: mcpManager,
    providers: Object.keys(PROVIDERS),
  };
}
