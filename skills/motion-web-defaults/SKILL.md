---
name: motion-web-defaults
description: Motion web por defecto: duraciones, curvas y accesibilidad
tasks: [siteDesign, designReview]
load: tool
priority: 60
---
- UI: 150-300 ms; entradas al hacer scroll ≤ 500 ms con --ease-out; nunca bounce ni elastic en webs de negocio.
- Anima solo transform y opacity. Nada de animar width/height/top.
- Todo movimiento con propósito (orientar, confirmar, jerarquizar); nada en bucle.
- Respeta prefers-reduced-motion: sin transformaciones, solo cambios instantáneos.
