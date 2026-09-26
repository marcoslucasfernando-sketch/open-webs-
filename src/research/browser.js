// Captura de referencias con el navegador real vía Playwright MCP + el extractor de Taste (references/extract.js):
// estilos calculados de toda la página (colores por área, escala tipográfica, espaciado, radios, sombras, grid,
// transiciones) y una captura del viewport para que GPT-6 Luna vea el diseño.
export class BrowserCapture {
  constructor({ mcp, extractScript }) {
    this.mcp = mcp;
    this.script = extractScript;
  }

  get available() {
    return Boolean(this.mcp?.has('playwright') && this.script);
  }

  async capture(url) {
    await this.mcp.call('playwright__browser_navigate', { url });
    await this.mcp.call('playwright__browser_wait_for', { time: 1.5 }).catch(() => {});
    const evaluated = await this.mcp.call('playwright__browser_evaluate', { function: this.script });
    const measurements = parseEvaluateResult(evaluated.text);
    const shot = await this.mcp.call('playwright__browser_take_screenshot', { type: 'jpeg' });
    return { measurements, screenshot: shot.images[0] || null };
  }
}

// La respuesta de browser_evaluate es Markdown: "### Result\n<json>\n### Ran Playwright code ...".
export function parseEvaluateResult(text) {
  if (String(text).startsWith('ERROR')) throw new Error(text.slice(0, 300));
  const m = String(text).match(/### Result\s*\n([\s\S]*?)(?:\n### |\s*$)/);
  const raw = (m ? m[1] : text).trim();
  const value = JSON.parse(raw);
  return typeof value === 'string' ? JSON.parse(value) : value;
}

// Resume las medidas de Taste en rasgos comparables entre referencias.
export function summarizeMeasurements(m) {
  if (!m) return null;
  const top = (arr, n = 5) => (arr || []).slice(0, n).map((x) => x.value ?? x);
  return {
    pageBackground: m.colors?.pageBackground,
    accentColors: top(m.colors?.accentCandidates, 5),
    backgroundColors: top(m.colors?.backgroundColors, 4),
    textColors: top(m.colors?.textColors, 3),
    fontFamilies: top(m.typography?.uniqueFamilies, 4),
    h1: m.typography?.headings?.h1,
    h2: m.typography?.headings?.h2,
    body: m.typography?.body,
    radii: top(m.effects?.radii, 4),
    shadows: top(m.effects?.shadows, 3),
    transitions: (m.effects?.transitions || []).slice(0, 5),
    containerMaxWidth: m.layout?.containerMaxWidth,
    sectionGaps: (m.sectionGaps || []).slice(0, 6),
    grid: m.grid,
    buttons: (m.buttons || []).slice(0, 3),
    reducedMotion: m.reducedMotion,
    focusVisible: m.focusVisible,
  };
}
