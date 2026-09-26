#!/usr/bin/env node
// Arranca la plataforma en modo demo: IA simulada, referencias y negocios sintéticos, hosting local y email simulado.
// Útil para ver el flujo completo sin credenciales. Para producción usa `npm start` con tu .env.
const demo = {
  AI_RESEARCH: 'mock',
  AI_GENERATION: 'mock',
  SEARCH_PROVIDER: 'fixture',
  PLACES_PROVIDER: 'fixture',
  HOSTING_PROVIDER: 'local',
  MAIL_DRY_RUN: 'true',
  DATA_DIR: 'data-demo',
};
for (const [k, v] of Object.entries(demo)) process.env[k] ??= v;
await import('../src/server.js');
