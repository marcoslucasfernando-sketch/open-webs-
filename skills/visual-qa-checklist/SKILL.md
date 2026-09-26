---
name: visual-qa-checklist
description: Checklist de revisión visual con Playwright y Chrome DevTools
tasks: [designReview]
load: inject
priority: 85
---
Pasos (en una pasada, sin bucles):
1. playwright__browser_navigate a la URL → playwright__browser_take_screenshot (escritorio 1440 px).
2. playwright__browser_resize 390x844 → captura móvil. Busca desbordes horizontales, textos cortados, botones < 44 px, menú.
3. chrome-devtools__list_pages → navigate_page (pageId) → list_console_messages (errores JS, 404).
4. Si existe chrome-devtools__lighthouse_audit: mode "snapshot", device "mobile" → anota accesibilidad y SEO < 90.
5. Revisa: jerarquía (un foco por pantalla), ritmo vertical, alineaciones, contraste, estados hover/focus, tamaño de H1 en móvil.
Salida: puntuación 0-10, incidencias con severidad y CSS correctivo mínimo (no rediseñar).
