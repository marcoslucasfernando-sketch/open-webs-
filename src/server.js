import { loadDotEnv, buildConfig } from './config.js';
import { createServices, startServer } from './app.js';

loadDotEnv();
const config = buildConfig();
const services = createServices(config);
const server = await startServer(services);

const { ai } = services;
console.log(`Open Webs escuchando en ${config.publicUrl}`);
console.log(`  IA: investigación=${config.ai.research} · generación=${config.ai.generation} · auth=${config.ai.openai.auth}`);
console.log(`  Skills: ${ai.skills.skills.length} cargadas${ai.skills.vendorMissing?.length ? ` (faltan ${ai.skills.vendorMissing.length}: ejecuta npm run skills:sync)` : ''}`);
console.log(`  MCP: ${Object.keys(config.mcp.servers).filter((s) => ai.mcp.has(s)).join(', ') || 'ninguno'}`);
console.log(`  Hosting: ${services.hosting.name} · DNS: ${config.deploy.dns} · Email: ${services.mailer.provider}${services.mailer.dryRun ? ' (simulación)' : ''}`);

const shutdown = () => {
  ai.mcp.closeAll();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
