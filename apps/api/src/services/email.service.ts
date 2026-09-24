import { env } from '../config.js';

export type EmailDelivery = 'SENT' | 'UNAVAILABLE' | 'FAILED';

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]!);
}

function frontendUrl(parameters: Record<string, string>): string {
  const url = new URL(env.FRONTEND_URL);
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
  return url.toString();
}

async function sendTransactionalEmail(input: {
  email: string;
  displayName: string;
  subject: string;
  tag: string;
  htmlContent: string;
}): Promise<EmailDelivery> {
  if (!env.BREVO_API_KEY || !env.BREVO_SENDER_EMAIL) return 'UNAVAILABLE';

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
        subject: input.subject,
        tags: [input.tag],
        htmlContent: input.htmlContent,
      }),
    });
    if (!response.ok) {
      console.error(`Brevo rechazó ${input.tag} (${response.status}).`);
      return 'FAILED';
    }
    return 'SENT';
  } catch (error) {
    console.error(`No fue posible enviar ${input.tag}.`, error);
    return 'FAILED';
  }
}

export async function sendVerificationEmail(input: {
  email: string;
  displayName: string;
  token: string;
  expiresAt: Date;
  invitationToken?: string;
}): Promise<EmailDelivery> {
  const parameters: Record<string, string> = { 'verify-email': input.token };
  if (input.invitationToken) parameters.invitation = input.invitationToken;
  const link = frontendUrl(parameters);
  const expires = new Intl.DateTimeFormat('es-EC', {
    dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Guayaquil',
  }).format(input.expiresAt);

  return sendTransactionalEmail({
    email: input.email,
    displayName: input.displayName,
    subject: 'Verifica tu cuenta de SGB',
    tag: 'sgb-email-verification',
    htmlContent: `<html><body style="font-family:Arial,sans-serif;color:#173126;line-height:1.6">
      <div style="max-width:560px;margin:auto;padding:28px;border:1px solid #d8e2dc;border-radius:18px">
        <p style="font-weight:800;color:#087a4b">SGB · Gestión bovina</p>
        <h1 style="font-size:26px">Verifica tu correo</h1>
        <p>Hola, ${escapeHtml(input.displayName)}. Confirma tu correo para activar tu cuenta.</p>
        <p style="margin:28px 0"><a href="${escapeHtml(link)}" style="display:inline-block;padding:13px 20px;border-radius:12px;background:#087a4b;color:white;text-decoration:none;font-weight:700">Verificar mi cuenta</a></p>
        <p style="font-size:13px;color:#64756c">El enlace vence el ${escapeHtml(expires)}. Si no creaste esta cuenta, ignora este mensaje.</p>
      </div></body></html>`,
  });
}

export async function sendPasswordResetEmail(input:{email:string;displayName:string;token:string;
  expiresAt:Date}):Promise<EmailDelivery>{
  const link=frontendUrl({'reset-password':input.token});
  const expires=new Intl.DateTimeFormat('es-EC',{dateStyle:'long',timeStyle:'short',
    timeZone:'America/Guayaquil'}).format(input.expiresAt);
  return sendTransactionalEmail({email:input.email,displayName:input.displayName,
    subject:'Recupera tu acceso a SGB',tag:'sgb-password-reset',
    htmlContent:`<html><body style="font-family:Arial,sans-serif;color:#173126;line-height:1.6">
      <div style="max-width:560px;margin:auto;padding:28px;border:1px solid #d8e2dc;border-radius:18px">
        <p style="font-weight:800;color:#087a4b">SGB · Gestión bovina</p>
        <h1>Recuperar acceso</h1>
        <p>Hola, ${escapeHtml(input.displayName)}. Solicitaron restablecer la contraseña de tu cuenta.</p>
        <p style="margin:28px 0"><a href="${escapeHtml(link)}" style="display:inline-block;padding:13px 20px;border-radius:12px;background:#087a4b;color:white;text-decoration:none;font-weight:700">Cambiar contraseña</a></p>
        <p style="font-size:13px;color:#64756c">El enlace vence el ${escapeHtml(expires)} y solo se puede usar una vez. Si no lo solicitaste, ignora este correo.</p>
      </div></body></html>`,
  });
}

export async function sendPropertyInvitationEmail(input: {
  email: string;
  displayName: string;
  inviterName: string;
  propertyName: string;
  roleNames: string[];
  token: string;
  expiresAt: Date;
}): Promise<EmailDelivery> {
  const link = frontendUrl({ invitation: input.token });
  const expires = new Intl.DateTimeFormat('es-EC', {
    dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Guayaquil',
  }).format(input.expiresAt);

  return sendTransactionalEmail({
    email: input.email,
    displayName: input.displayName,
    subject: `${input.inviterName} te invitó a ${input.propertyName} en SGB`,
    tag: 'sgb-property-invitation',
    htmlContent: `<html><body style="font-family:Arial,sans-serif;color:#173126;line-height:1.6">
      <div style="max-width:560px;margin:auto;padding:28px;border:1px solid #d8e2dc;border-radius:18px">
        <p style="font-weight:800;color:#087a4b">SGB · Gestión bovina</p>
        <h1 style="font-size:26px">Invitación a una propiedad</h1>
        <p>${escapeHtml(input.inviterName)} te invitó a colaborar en <strong>${escapeHtml(input.propertyName)}</strong>.</p>
        <p>Rol${input.roleNames.length === 1 ? '' : 'es'}: ${escapeHtml(input.roleNames.join(', '))}.</p>
        <p style="margin:28px 0"><a href="${escapeHtml(link)}" style="display:inline-block;padding:13px 20px;border-radius:12px;background:#087a4b;color:white;text-decoration:none;font-weight:700">Revisar invitación</a></p>
        <p style="font-size:13px;color:#64756c">El enlace vence el ${escapeHtml(expires)}. Solo puede aceptarlo la cuenta asociada a este correo.</p>
      </div></body></html>`,
  });
}
