import { env } from '../config.js';

export type EmailDelivery = 'SENT' | 'UNAVAILABLE' | 'FAILED';

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]!);
}

function verificationUrl(token: string): string {
  const url = new URL(env.FRONTEND_URL);
  url.searchParams.set('verify-email', token);
  return url.toString();
}

export async function sendVerificationEmail(input: {
  email: string;
  displayName: string;
  token: string;
  expiresAt: Date;
}): Promise<EmailDelivery> {
  if (!env.BREVO_API_KEY || !env.BREVO_SENDER_EMAIL) return 'UNAVAILABLE';

  const link = verificationUrl(input.token);
  const safeName = escapeHtml(input.displayName);
  const safeLink = escapeHtml(link);
  const expires = new Intl.DateTimeFormat('es-EC', {
    dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Guayaquil',
  }).format(input.expiresAt);

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      signal: AbortSignal.timeout(env.EMAIL_REQUEST_TIMEOUT_MS),
      headers: {
        accept: 'application/json',
        'api-key': env.BREVO_API_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: env.BREVO_SENDER_NAME, email: env.BREVO_SENDER_EMAIL },
        to: [{ name: input.displayName, email: input.email }],
        subject: 'Verifica tu cuenta de SGB',
        tags: ['sgb-email-verification'],
        htmlContent: `<html><body style="font-family:Arial,sans-serif;color:#173126;line-height:1.6">
          <div style="max-width:560px;margin:auto;padding:28px;border:1px solid #d8e2dc;border-radius:18px">
            <p style="font-weight:800;color:#087a4b">SGB · Gestión bovina</p>
            <h1 style="font-size:26px">Verifica tu correo</h1>
            <p>Hola, ${safeName}. Confirma tu correo para activar tu cuenta y primera propiedad.</p>
            <p style="margin:28px 0"><a href="${safeLink}" style="display:inline-block;padding:13px 20px;border-radius:12px;background:#087a4b;color:white;text-decoration:none;font-weight:700">Verificar mi cuenta</a></p>
            <p style="font-size:13px;color:#64756c">El enlace vence el ${escapeHtml(expires)}. Si no creaste esta cuenta, ignora este mensaje.</p>
          </div></body></html>`,
      }),
    });

    if (!response.ok) {
      console.error(`Brevo rechazó el correo de verificación (${response.status}).`);
      return 'FAILED';
    }
    return 'SENT';
  } catch (error) {
    console.error('No fue posible enviar el correo de verificación.', error);
    return 'FAILED';
  }
}
