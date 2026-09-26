import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Envío de emails. Proveedores: outbox (no envía: guarda .eml), smtp (nodemailer) y resend (HTTP).
export function createMailer(cfg, { dataDir, fetch = globalThis.fetch } = {}) {
  const provider = cfg.dryRun ? 'outbox' : cfg.provider;

  const outbox = async (msg) => {
    const dir = path.join(dataDir, 'outbox');
    fs.mkdirSync(dir, { recursive: true });
    const id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const eml = [
      `From: ${msg.from}`,
      `To: ${msg.to}`,
      msg.replyTo && `Reply-To: ${msg.replyTo}`,
      `Subject: ${msg.subject}`,
      ...Object.entries(msg.headers || {}).map(([k, v]) => `${k}: ${v}`),
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain; charset=utf-8',
      '',
      msg.text,
      '--b1',
      'Content-Type: text/html; charset=utf-8',
      '',
      msg.html,
      '--b1--',
    ]
      .filter((l) => l !== false && l !== undefined)
      .join('\r\n');
    fs.writeFileSync(path.join(dir, `${id}.eml`), eml);
    return { id, provider: 'outbox', file: `outbox/${id}.eml` };
  };

  const smtp = async (msg) => {
    if (!cfg.smtpUrl) throw new Error('SMTP_URL no configurado (p. ej. smtps://usuario:clave@smtp.tudominio.com:465)');
    const nodemailer = (await import('nodemailer')).default;
    const transport = nodemailer.createTransport(cfg.smtpUrl);
    const info = await transport.sendMail({ from: msg.from, to: msg.to, replyTo: msg.replyTo, subject: msg.subject, text: msg.text, html: msg.html, headers: msg.headers });
    return { id: info.messageId, provider: 'smtp' };
  };

  const resend = async (msg) => {
    if (!cfg.resendApiKey) throw new Error('RESEND_API_KEY no configurado');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.resendApiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: msg.from, to: [msg.to], reply_to: msg.replyTo || undefined, subject: msg.subject, text: msg.text, html: msg.html, headers: msg.headers }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`Resend ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
    return { id: json.id, provider: 'resend' };
  };

  const impl = { outbox, smtp, resend }[provider];
  if (!impl) throw new Error(`Proveedor de email desconocido: ${provider}`);
  return { provider, dryRun: provider === 'outbox', send: impl };
}
