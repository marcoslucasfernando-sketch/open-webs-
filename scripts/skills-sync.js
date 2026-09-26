#!/usr/bin/env node
// Descarga las skills de terceros desde su repositorio ORIGINAL, fijadas al commit de skills/vendor.lock.json,
// verifica el commit y las copia a skills/vendor/ (ignorado por git). Uso:
//   node scripts/skills-sync.js            sincroniza todo
//   node scripts/skills-sync.js --check    solo comprueba que están instaladas y en el commit correcto
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = path.join(ROOT, 'skills/vendor.lock.json');
const VENDOR = path.join(ROOT, 'skills/vendor');
const CACHE = path.join(ROOT, '.cache/skills-src');

const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
const checkOnly = process.argv.includes('--check');
const ifMissing = process.argv.includes('--if-missing');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' } }).toString().trim();

function checkout(sourceId, source, files) {
  const dir = path.join(CACHE, source.repo);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, '.git'))) {
    git(dir, 'init', '-q');
    git(dir, 'remote', 'add', 'origin', `https://github.com/${source.repo}`);
  }
  let head = '';
  try {
    head = git(dir, 'rev-parse', 'HEAD');
  } catch {}
  if (head !== source.commit) {
    git(dir, 'fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', source.commit);
    git(dir, 'sparse-checkout', 'set', '--no-cone', ...files.map((f) => `/${f}`));
    git(dir, 'checkout', '-q', '--force', 'FETCH_HEAD');
    head = git(dir, 'rev-parse', 'HEAD');
  }
  if (head !== source.commit) throw new Error(`${sourceId}: commit inesperado ${head} (esperado ${source.commit})`);
  return dir;
}

function installed() {
  const meta = path.join(VENDOR, '_sources.json');
  if (!fs.existsSync(meta)) return false;
  const synced = JSON.parse(fs.readFileSync(meta, 'utf8'));
  return Object.entries(lock.sources).every(([id, s]) => synced[id]?.commit === s.commit);
}

function main() {
  const report = [];
  if (ifMissing && installed()) return;
  if (checkOnly) {
    for (const s of lock.skills) {
      const f = s.kind === 'asset' ? path.join(VENDOR, '_assets', path.basename(s.file)) : path.join(VENDOR, s.name, 'SKILL.md');
      const meta = path.join(VENDOR, '_sources.json');
      const ok = fs.existsSync(f) && fs.existsSync(meta) && JSON.parse(fs.readFileSync(meta, 'utf8'))[s.source]?.commit === lock.sources[s.source].commit;
      report.push([s.name, ok ? 'OK' : 'FALTA']);
    }
    console.table(report);
    process.exit(report.every(([, st]) => st === 'OK') ? 0 : 1);
  }

  fs.rmSync(VENDOR, { recursive: true, force: true });
  fs.mkdirSync(path.join(VENDOR, '_assets'), { recursive: true });
  fs.mkdirSync(path.join(VENDOR, '_licenses'), { recursive: true });
  const sourcesMeta = {};

  for (const [id, source] of Object.entries(lock.sources)) {
    const skills = lock.skills.filter((s) => s.source === id);
    const files = [...skills.map((s) => s.file), source.licenseFile, source.noticeFile].filter(Boolean);
    process.stdout.write(`· ${source.repo}@${source.commit.slice(0, 7)} … `);
    const dir = checkout(id, source, files);
    for (const s of skills) {
      const src = path.join(dir, s.file);
      if (!fs.existsSync(src)) throw new Error(`${id}: no existe ${s.file} en el commit fijado`);
      if (s.kind === 'asset') {
        fs.copyFileSync(src, path.join(VENDOR, '_assets', path.basename(s.file)));
        continue;
      }
      fs.mkdirSync(path.join(VENDOR, s.name), { recursive: true });
      fs.copyFileSync(src, path.join(VENDOR, s.name, 'SKILL.md'));
    }
    for (const f of [source.licenseFile, source.noticeFile].filter(Boolean)) {
      fs.mkdirSync(path.join(VENDOR, '_licenses', id), { recursive: true });
      fs.copyFileSync(path.join(dir, f), path.join(VENDOR, '_licenses', id, path.basename(f)));
    }
    sourcesMeta[id] = { repo: source.repo, commit: source.commit, license: source.license, syncedAt: new Date().toISOString() };
    console.log(`${skills.length} ficheros`);
  }
  fs.writeFileSync(path.join(VENDOR, '_sources.json'), JSON.stringify(sourcesMeta, null, 2));
  console.log(`Skills de terceros sincronizadas en ${path.relative(ROOT, VENDOR)}/`);
}

try {
  main();
} catch (err) {
  console.error(`\nError sincronizando skills: ${err.message}`);
  process.exit(1);
}
