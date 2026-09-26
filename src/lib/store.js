import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Almacenamiento en ficheros JSON. En producción se sustituye por PostgreSQL + S3 (ver docs/ARQUITECTURA.md)
// manteniendo esta misma interfaz.
export class FileStore {
  constructor(dir, { secretKey = '' } = {}) {
    this.dir = dir;
    this.key = secretKey ? crypto.createHash('sha256').update(secretKey).digest() : null;
    for (const sub of ['projects', 'sectors', 'sites', 'secrets']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }

  #file(collection, id) {
    if (!/^[a-z0-9_.-]+$/i.test(id)) throw new Error(`Id no válido: ${id}`);
    return path.join(this.dir, collection, `${id}.json`);
  }

  get(collection, id) {
    const f = this.#file(collection, id);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  }

  put(collection, id, value) {
    const f = this.#file(collection, id);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, f);
    return value;
  }

  list(collection) {
    const dir = path.join(this.dir, collection);
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  }

  // Secretos (tokens OAuth) cifrados con AES-256-GCM si hay SECRET_KEY.
  getSecret(id) {
    const f = this.#file('secrets', id);
    if (!fs.existsSync(f)) return null;
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!raw.enc) return raw.value;
    if (!this.key) throw new Error('Secreto cifrado pero SECRET_KEY no está definido');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(raw.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(raw.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(raw.data, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  }

  putSecret(id, value) {
    const f = this.#file('secrets', id);
    if (!this.key) {
      fs.writeFileSync(f, JSON.stringify({ enc: false, value }), { mode: 0o600 });
      return;
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    fs.writeFileSync(
      f,
      JSON.stringify({ enc: true, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }),
      { mode: 0o600 },
    );
  }

  siteDir(projectId) {
    return path.join(this.dir, 'sites', projectId);
  }
}
