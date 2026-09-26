// Utilidades de color: parseo, HSL, contraste WCAG y distancia perceptual aproximada.

export function parseColor(input) {
  const s = String(input).trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    if (h.length === 8 && Number.parseInt(h.slice(6, 8), 16) < 128) return null; // casi transparente
    return { r: Number.parseInt(h.slice(0, 2), 16), g: Number.parseInt(h.slice(2, 4), 16), b: Number.parseInt(h.slice(4, 6), 16) };
  }
  m = s.match(/^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (m) {
    if (m[4] !== undefined) {
      const a = m[4].endsWith('%') ? Number.parseFloat(m[4]) / 100 : Number.parseFloat(m[4]);
      if (a < 0.5) return null;
    }
    return { r: +m[1], g: +m[2], b: +m[3] };
  }
  return null;
}

export const toHex = ({ r, g, b }) =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

export function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

export function hslToRgb({ h, s, l }) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return { r: f(h + 1 / 3) * 255, g: f(h) * 255, b: f(h - 1 / 3) * 255 };
}

export const hslToHex = (hsl) => toHex(hslToRgb(hsl));

function luminance({ r, g, b }) {
  const c = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function contrastRatio(a, b) {
  const la = luminance(typeof a === 'string' ? parseColor(a) : a);
  const lb = luminance(typeof b === 'string' ? parseColor(b) : b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Distancia euclídea ponderada ("redmean"), suficiente para detectar colores casi idénticos.
export function colorDistance(a, b) {
  const x = typeof a === 'string' ? parseColor(a) : a;
  const y = typeof b === 'string' ? parseColor(b) : b;
  const rm = (x.r + y.r) / 2;
  const dr = x.r - y.r, dg = x.g - y.g, db = x.b - y.b;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

export function isNeutral(rgb) {
  const { s, l } = rgbToHsl(rgb);
  return s < 0.12 || l > 0.94 || l < 0.08;
}

const HUE_FAMILIES = [
  ['rojo', 0, 15], ['naranja', 15, 45], ['amarillo', 45, 65], ['verde-lima', 65, 90],
  ['verde', 90, 160], ['turquesa', 160, 195], ['azul', 195, 250], ['violeta', 250, 290],
  ['magenta', 290, 335], ['rojo', 335, 360],
];

export function hueFamily(hex) {
  const rgb = typeof hex === 'string' ? parseColor(hex) : hex;
  if (!rgb) return null;
  if (isNeutral(rgb)) return 'neutro';
  const { h } = rgbToHsl(rgb);
  return HUE_FAMILIES.find(([, a, b]) => h >= a && h < b)?.[0] ?? 'rojo';
}

export const FAMILY_CENTER = {
  rojo: 355, naranja: 28, amarillo: 50, 'verde-lima': 78, verde: 140,
  turquesa: 178, azul: 215, violeta: 268, magenta: 315,
};
