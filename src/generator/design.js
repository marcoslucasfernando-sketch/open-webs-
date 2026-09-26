import { seededRandom } from '../lib/util.js';
import { FAMILY_CENTER, hslToHex, contrastRatio, colorDistance, parseColor, rgbToHsl } from '../lib/color.js';

// Parejas tipográficas (Google Fonts) por estilo. Se evita la fuente de titulares más usada por las referencias.
const FONT_PAIRS = {
  serif: [['Fraunces', 'Inter'], ['DM Serif Display', 'DM Sans'], ['Cormorant Garamond', 'Manrope'], ['Newsreader', 'Public Sans'], ['Playfair Display', 'Source Sans 3']],
  sans: [['Manrope', 'Inter'], ['Plus Jakarta Sans', 'Inter'], ['Sora', 'Inter'], ['Outfit', 'Nunito Sans'], ['Space Grotesk', 'IBM Plex Sans'], ['Figtree', 'Figtree']],
  display: [['Syne', 'Inter'], ['Bricolage Grotesque', 'Inter'], ['Unbounded', 'Manrope'], ['Archivo Black', 'Archivo']],
};

export const MIN_DISTANCE_TO_REFERENCES = 45;

// Tokens base deterministas y ORIGINALES: coherentes con la familia de color y el estilo tipográfico del sector,
// pero con tono desplazado, contraste AA garantizado y distancia mínima a cada color de marca de las referencias.
export function baseTokens({ business, sectorRecord, profile }) {
  const rand = seededRandom(`${business.name}|${business.sector}`);
  const stats = sectorRecord?.stats || {};
  const synth = sectorRecord?.synthesis || {};
  const family = synth.designGuidelines?.colorFamilies?.[0] || stats.colorFamilies?.[0]?.[0] || profile.family || 'azul';
  const refColors = (stats.brandColors || []).filter((c) => parseColor(c));

  let hue = (FAMILY_CENTER[family] ?? FAMILY_CENTER.azul) + (rand() - 0.5) * 26;
  let primary;
  for (let attempt = 0; attempt < 24; attempt++) {
    const sat = 0.52 + rand() * 0.22;
    let l = 0.46;
    primary = hslToHex({ h: hue, s: sat, l });
    while (contrastRatio(primary, '#ffffff') < 4.6 && l > 0.2) primary = hslToHex({ h: hue, s: sat, l: (l -= 0.02) });
    if (refColors.every((c) => colorDistance(primary, c) >= MIN_DISTANCE_TO_REFERENCES)) break;
    hue += 9;
  }
  const accentHue = rand() > 0.5 ? hue + 160 + rand() * 40 : hue + 35 + rand() * 20;
  const accent = hslToHex({ h: accentHue, s: 0.7, l: 0.56 });
  const tokens = {
    primary,
    primaryInk: '#ffffff',
    accent,
    bg: hslToHex({ h: hue, s: 0.3, l: 0.985 }),
    surface: hslToHex({ h: hue, s: 0.28, l: 0.955 }),
    text: hslToHex({ h: hue, s: 0.3, l: 0.12 }),
    muted: hslToHex({ h: hue, s: 0.12, l: 0.36 }),
    ...pickFonts(synth.designGuidelines?.typographyStyle || stats.typographyStyle || profile.typography, stats.fonts, rand),
    radius: `${[6, 10, 14, 18][Math.floor(rand() * 4)]}px`,
    space: '8px',
    maxWidth: '1180px',
  };
  return tokens;
}

function pickFonts(style, refFonts = [], rand) {
  const pairs = FONT_PAIRS[style] || FONT_PAIRS.sans;
  const used = new Set((refFonts || []).slice(0, 3).map(([f]) => String(f).toLowerCase()));
  const options = pairs.filter(([h]) => !used.has(h.toLowerCase()));
  const [headingFont, bodyFont] = (options.length ? options : pairs)[Math.floor(rand() * (options.length || pairs.length))];
  return { headingFont, bodyFont };
}

const HEX = /^#[0-9a-f]{6}$/i;
const FONT = /^[A-Za-z0-9 ]{2,40}$/;

// Acepta los tokens propuestos por GPT-6 Luna solo si mantienen accesibilidad y originalidad; si no, conserva los base.
export function mergeTokens(base, proposed = {}, refColors = []) {
  const out = { ...base };
  const rejected = [];
  const okColor = (v) => HEX.test(v || '');
  for (const key of ['primary', 'accent', 'bg', 'surface', 'text', 'muted']) {
    if (okColor(proposed[key])) out[key] = proposed[key].toLowerCase();
  }
  for (const key of ['headingFont', 'bodyFont']) if (FONT.test(proposed[key] || '')) out[key] = proposed[key];
  for (const key of ['radius', 'space', 'maxWidth']) if (/^\d{1,4}px$/.test(proposed[key] || '')) out[key] = proposed[key];

  const checks = [
    ['primary', () => contrastRatio(out.primary, out.primaryInk) >= 4.5],
    ['text', () => contrastRatio(out.text, out.bg) >= 7],
    ['muted', () => contrastRatio(out.muted, out.bg) >= 4.5],
    ['primary', () => refColors.every((c) => !parseColor(c) || colorDistance(out.primary, c) >= MIN_DISTANCE_TO_REFERENCES)],
  ];
  for (const [key, ok] of checks) {
    if (!ok()) {
      rejected.push(key);
      out[key] = base[key];
    }
  }
  if (contrastRatio(out.primary, out.primaryInk) < 4.5) out.primaryInk = rgbToHsl(parseColor(out.primary)).l > 0.6 ? '#111111' : '#ffffff';
  return { tokens: out, rejected: [...new Set(rejected)] };
}

// Saneado del CSS generado por la IA: sin @import salvo Google Fonts, sin url() externas, sin expresiones.
export function sanitizeCss(css = '', maxLen = 8000) {
  let s = String(css).slice(0, maxLen);
  s = s.replace(/<\/?style[^>]*>/gi, '');
  s = s.replace(/@import\s+(?:url\()?\s*['"]?(?!https:\/\/fonts\.googleapis\.com\/)[^;]+;/gi, '');
  s = s.replace(/url\(\s*['"]?(?!data:image\/svg\+xml)(?!#)[^)]*\)/gi, 'none');
  s = s.replace(/expression\s*\(|javascript:|behavior\s*:|-moz-binding/gi, '');
  s = s.replace(/<\/?script/gi, '');
  return s.trim();
}

export function googleFontsHref(tokens) {
  const fam = (f, w) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@${w}`;
  const families = tokens.headingFont === tokens.bodyFont ? [fam(tokens.headingFont, '400;500;600;700')] : [fam(tokens.headingFont, '500;600;700'), fam(tokens.bodyFont, '400;500;600')];
  return `https://fonts.googleapis.com/css2?${families.join('&')}&display=swap`;
}
