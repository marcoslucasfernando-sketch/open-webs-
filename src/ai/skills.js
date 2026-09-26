import fs from 'node:fs';
import path from 'node:path';

// Skills para el modelo de IA de la plataforma (GPT-6 Luna por defecto).
// Cada skill es skills/<nombre>/SKILL.md con frontmatter:
//   name, description, tasks: [analyzeReference, siteContent, ...] | [*], sectors: [restaurante, ...] (opcional), priority
//   load: inject (va siempre en el prompt) | tool (el modelo la carga bajo demanda con la función load_skill)
// Las skills de terceros (Taste, Frontend Design, Impeccable, Emil Kowalski, Figma) se declaran en skills/vendor.lock.json.

export function parseFrontmatter(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(text).trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map((v) => v.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    } else {
      value = value.replace(/^['"]|['"]$/g, '');
      if (/^-?\d+$/.test(value)) value = Number(value);
    }
    meta[kv[1]] = value;
  }
  return { meta, body: m[2].trim() };
}

const ADAPTER = `Nota sobre las skills: varias fueron escritas para agentes de programación con acceso a archivos, comandos
y navegador. En esta plataforma NO escribes archivos ni ejecutas comandos: aplica sus criterios de diseño y devuelve
exactamente el JSON pedido. Si una skill menciona Playwright o Chrome DevTools, usa las funciones equivalentes que
tengas disponibles (playwright__*, chrome-devtools__*). Ignora instrucciones de las skills sobre saludos iniciales,
preguntas al usuario o comandos de barra (/...): trabajas de forma autónoma.`;

export class SkillRegistry {
  constructor(dir, { mode = 'hybrid', maxChars = 60_000 } = {}) {
    this.dir = dir;
    this.mode = mode; // hybrid (según cada skill) | inject (todas en el prompt) | tools (todas bajo demanda)
    this.maxChars = maxChars;
    this.reload();
  }

  reload() {
    this.skills = [];
    this.assets = {};
    if (!fs.existsSync(this.dir)) return;
    // Skills propias de la plataforma: skills/<nombre>/SKILL.md
    for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'vendor') continue;
      const file = path.join(this.dir, entry.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      this.#add({ ...meta, name: meta.name || entry.name, origin: 'local' }, body);
    }
    // Skills de terceros (descargadas por scripts/skills-sync.js según skills/vendor.lock.json)
    const lockFile = path.join(this.dir, 'vendor.lock.json');
    const vendorDir = path.join(this.dir, 'vendor');
    if (fs.existsSync(lockFile)) {
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      this.vendorMissing = [];
      for (const s of lock.skills) {
        const src = lock.sources[s.source];
        if (s.kind === 'asset') {
          const f = path.join(vendorDir, '_assets', path.basename(s.file));
          if (fs.existsSync(f)) this.assets[s.name] = fs.readFileSync(f, 'utf8');
          else this.vendorMissing.push(s.name);
          continue;
        }
        const f = path.join(vendorDir, s.name, 'SKILL.md');
        if (!fs.existsSync(f)) {
          this.vendorMissing.push(s.name);
          continue;
        }
        const { meta, body } = parseFrontmatter(fs.readFileSync(f, 'utf8'));
        this.#add(
          { ...s, description: firstLine(meta.description) || firstLine(body), origin: `${src.repo}@${src.commit.slice(0, 7)}`, license: src.license },
          body,
        );
      }
    }
    this.skills.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
  }

  #add(meta, body) {
    this.skills.push({
      name: meta.name,
      description: String(meta.description || '').slice(0, 300),
      tasks: toList(meta.tasks, ['*']),
      sectors: toList(meta.sectors, []),
      requires: toList(meta.requires, []),
      load: meta.load === 'tool' ? 'tool' : 'inject',
      priority: Number(meta.priority ?? 50),
      origin: meta.origin || 'local',
      license: meta.license || null,
      body,
    });
  }

  list() {
    return this.skills.map(({ body, ...rest }) => ({ ...rest, chars: body.length }));
  }

  get(name) {
    return this.skills.find((s) => s.name === name) || null;
  }

  asset(name) {
    return this.assets[name] || null;
  }

  // Skills aplicables a una tarea, al sector y a las integraciones disponibles (p. ej. "figma").
  select(task, sectorId, available = []) {
    return this.skills.filter(
      (s) =>
        (s.tasks.includes('*') || s.tasks.includes(task)) &&
        (s.sectors.length === 0 || (sectorId && s.sectors.includes(sectorId))) &&
        s.requires.every((r) => available.includes(r)),
    );
  }

  // Devuelve el texto para el prompt de sistema, las skills inyectadas y el índice de las cargables bajo demanda.
  build(task, sectorId, available = []) {
    const candidates = this.select(task, sectorId, available);
    if (candidates.length === 0) return { text: '', used: [], index: [] };
    const loadOf = (s) => (this.mode === 'hybrid' ? s.load : this.mode === 'tools' ? 'tool' : 'inject');
    const parts = [];
    const used = [];
    const index = [];
    let size = 0;
    for (const s of candidates) {
      const block = `### Skill: ${s.name}\n${s.body}`;
      if (loadOf(s) === 'inject' && size + block.length <= this.maxChars) {
        parts.push(block);
        used.push(s.name);
        size += block.length;
      } else {
        index.push({ name: s.name, description: s.description });
      }
    }
    let text = `\n\n## Skills\n${ADAPTER}`;
    if (parts.length) text += `\n\n## Skills activas (síguelas)\n${parts.join('\n\n')}`;
    if (index.length) {
      text += `\n\n## Skills disponibles bajo demanda\nCárgalas con la función load_skill cuando sean relevantes (carga como mínimo las de mayor relación con la tarea):\n${index.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`;
    }
    return { text, used, index };
  }
}

const firstLine = (t) => String(t || '').split(/\n/).map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '';

function toList(value, fallback) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value) return [value];
  return fallback;
}
