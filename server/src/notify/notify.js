import { log } from '../lib/logger.js';

// Email and SMS. With a provider configured they are sent for real:
//   email: Resend (RESEND_API_KEY, EMAIL_FROM)
//   SMS:   Twilio (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM)
// Without one, outside production, messages go to an in-memory test inbox
// (GET /api/v1/dev/outbox) so every flow can be tried locally. In production
// without a provider the feature reports itself as unavailable.

const OUTBOX_LIMIT = 200;
const outbox = [];

export function getOutbox() {
  return [...outbox].reverse();
}
export function clearOutbox() {
  outbox.length = 0;
}

export class NotConfiguredError extends Error {}

export function channels(config) {
  return {
    email: Boolean(config.resendApiKey) || config.devOutbox,
    sms: Boolean(config.twilio) || config.devOutbox,
    outbox: config.devOutbox && !(config.resendApiKey && config.twilio),
  };
}

function toOutbox(kind, msg) {
  outbox.push({ kind, ...msg, sentAt: new Date().toISOString() });
  if (outbox.length > OUTBOX_LIMIT) outbox.shift();
  log.info(`${kind}.outbox`, { to: msg.to, subject: msg.subject ?? null });
}

export async function sendEmail(config, { to, subject, text, html }) {
  if (config.resendApiKey) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.emailFrom, to: [to], subject, text, html }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      log.error('email.failed', { status: res.status, detail: detail.slice(0, 200) });
      throw new Error(`Email provider returned ${res.status}`);
    }
    return;
  }
  if (!config.devOutbox) throw new NotConfiguredError('Email is not set up on this server');
  toOutbox('email', { to, subject, text });
}

export async function sendSms(config, { to, body }) {
  if (config.twilio) {
    const { accountSid, authToken, from } = config.twilio;
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      log.error('sms.failed', { status: res.status, detail: detail.slice(0, 200) });
      throw new Error(`SMS provider returned ${res.status}`);
    }
    return;
  }
  if (!config.devOutbox) throw new NotConfiguredError('Text messages are not set up on this server');
  toOutbox('sms', { to, text: body });
}
