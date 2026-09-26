# Open Webs

Plataforma SaaS que crea la web de un negocio de forma automática: investiga **10 webs de referencia del sector**, genera un **master prompt** reutilizable, y **GPT-6 Luna** (por OAuth) redacta y diseña una web original con skills de diseño (Taste, Frontend Design, Impeccable, Emil Kowalski) y herramientas de navegador (Playwright MCP, Chrome DevTools MCP, Figma MCP). El usuario la revisa, la aprueba y la publica con su dominio (Netlify + DNS + SSL). La plataforma no la da por publicada hasta verificar que responde en Internet.

Incluye un **mapa interactivo de Gran Canaria** para localizar negocios, ver si tienen web, generar una demo para cada uno y enviársela por email.

La especificación completa, con diagramas, APIs y fases, está en **[docs/ARQUITECTURA.md](docs/ARQUITECTURA.md)**.

## Inicio rápido

```bash
npm install            # instala dependencias y descarga las skills de terceros (fijadas por commit)
npm run demo           # modo demo sin credenciales → http://localhost:3000
npm test               # tests (unitarios + extremo a extremo)
npm run doctor         # diagnóstico: IA, skills, MCP, hosting, DNS, email y mapa
```

Para producción:

```bash
cp .env.example .env   # configura GPT-6 Luna (OAuth), búsqueda, Netlify, DNS y email
npm start
```

- **GPT-6 Luna por OAuth**: `OAUTH_GRANT=client_credentials` (servidor a servidor) o `authorization_code` (pulsa "Conectar proveedor de IA" en Ajustes).
- **Figma**: en Ajustes, "Conectar Figma" (inicias sesión en Figma una vez).
- **Email**: por defecto `MAIL_DRY_RUN=true`, que no envía nada y guarda los `.eml` en `data/outbox`.

## Estructura

```
src/
  ai/          proveedores (openai = GPT-6 Luna, mock), OAuth, skills, cliente MCP, prompts
  research/    búsqueda, scraping (robots.txt, SSRF), extracción, captura con Taste, master prompt
  generator/   copy, originalidad, tokens de diseño, render HTML/CSS, SEO
  media/       fotos y logo del negocio (web, Instagram, Facebook) con el navegador
  deploy/      Netlify, DNS (Cloudflare, Netlify, manual), verificación
  leads/       OpenStreetMap, análisis de webs, demos, campañas y envío
  app.js       API REST y servidor de estáticos
public/        panel (crear web, mapa, sectores, ajustes)
skills/        25 skills propias + vendor.lock.json (25 de terceros)
fixtures/      referencias y negocios sintéticos para demo y tests
scripts/       doctor, demo, skills-sync
```
