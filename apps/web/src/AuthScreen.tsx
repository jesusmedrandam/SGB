import { FormEvent, useEffect, useState } from 'react';
import { Brand } from './Brand';
import type { InvitationPreview, RegistrationResult } from './api';

export type VerificationState = 'NONE' | 'CHECKING' | 'VERIFIED' | 'INVALID';

interface Props {
  busy: boolean;
  error: string | null;
  pendingRegistration: { email: string; delivery: RegistrationResult['verificationDelivery'] } | null;
  verificationState: VerificationState;
  verificationMessage: string | null;
  resendAccepted: boolean;
  invitationToken: string | null;
  invitation: InvitationPreview | null;
  invitationLoading: boolean;
  invitationError: string | null;
  onLogin: (email: string, password: string) => Promise<void>;
  onRegister: (input: {
    displayName: string; propertyName?: string; email: string; password: string; invitationToken?: string;
  }) => Promise<void>;
  onResend: (email: string) => Promise<void>;
  onUseLogin: () => void;
}

type Mode = 'LOGIN' | 'REGISTER' | 'PENDING' | 'VERIFY_RESULT' | 'INVITATION';

const frequencyNames: Record<string, string> = {
  HOURLY: 'Por hora', DAILY: 'Diario', WEEKLY: 'Semanal', BIWEEKLY: 'Quincenal',
  MONTHLY: 'Mensual', OTHER: 'Otro',
};

export function AuthScreen(props: Props) {
  const [mode, setMode] = useState<Mode>(props.verificationState !== 'NONE'
    ? 'VERIFY_RESULT' : props.invitationToken ? 'INVITATION' : 'LOGIN');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [propertyName, setPropertyName] = useState('');
  const [registerEmail, setRegisterEmail] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');

  useEffect(() => {
    if (props.pendingRegistration) setMode('PENDING');
  }, [props.pendingRegistration]);

  useEffect(() => {
    if (props.verificationState !== 'NONE') setMode('VERIFY_RESULT');
  }, [props.verificationState]);

  useEffect(() => {
    if (!props.invitation) return;
    setEmail(props.invitation.email);
    setRegisterEmail(props.invitation.email);
    if (props.verificationState === 'NONE' && !props.pendingRegistration) setMode('INVITATION');
  }, [props.invitation, props.pendingRegistration, props.verificationState]);

  function useLogin() {
    props.onUseLogin();
    setMode('LOGIN');
  }

  async function submitLogin(event: FormEvent) {
    event.preventDefault();
    await props.onLogin(email, password);
  }

  async function submitRegistration(event: FormEvent) {
    event.preventDefault();
    if (!passwordValid || registerPassword !== confirmation) return;
    await props.onRegister({
      displayName,
      ...(props.invitationToken ? { invitationToken: props.invitationToken } : { propertyName }),
      email: registerEmail,
      password: registerPassword,
    });
  }

  const requirements = {
    length: registerPassword.length >= 12,
    letter: /[A-Za-zÁÉÍÓÚáéíóúÑñ]/.test(registerPassword),
    number: /[0-9]/.test(registerPassword),
    matches: confirmation.length > 0 && registerPassword === confirmation,
  };
  const passwordValid = requirements.length && requirements.letter && requirements.number;

  return <main className="login-layout">
    <section className="login-intro">
      <div className="auth-logo-surface"><img src="/branding/logo-sgb-full.png" alt="Sistema de Gestión Bovina" /></div>
      <div className="intro-copy">
        <span className="eyebrow">Sistema de Gestión Bovina</span>
        <h1>La información de tu finca, organizada y disponible.</h1>
        <p>Animales, grupos, potreros, corrales, reproducción y producción en un mismo sistema.</p>
      </div>
      <div className="intro-points">
        <span>Acceso por roles y permisos</span><span>Información por propiedad</span><span>Diseño adaptable a celular y computador</span>
      </div>
    </section>

    <section className="login-panel">
      <div className={`login-card ${mode === 'REGISTER' ? 'registration-card' : ''}`}>
        <div className="mobile-brand"><Brand /></div>

        {mode === 'INVITATION' && <div className="verification-card invitation-preview">
          <span className="verification-icon">↗</span>
          <span className="eyebrow">Invitación de colaboración</span>
          {props.invitationLoading && <><h2>Consultando invitación…</h2><span className="spinner large" /></>}
          {props.invitationError && <><h2>No puede utilizarse</h2><div className="form-error">{props.invitationError}</div>
            <button className="secondary-button" type="button" onClick={useLogin}>Ir a iniciar sesión</button></>}
          {props.invitation && <>
            <h2>{props.invitation.property.name}</h2>
            <p><strong>{props.invitation.invitedBy}</strong> te invitó como {props.invitation.roles.map((role) => role.name).join(', ')}.</p>
            {props.invitation.employment && <div className="invitation-employment">
              <strong>{props.invitation.employment.jobTitle}</strong>
              {props.invitation.employment.payAmount !== null && <span>
                {props.invitation.employment.currency} {props.invitation.employment.payAmount.toFixed(2)}
                {props.invitation.employment.frequency
                  ? ` · ${frequencyNames[props.invitation.employment.frequency] || props.invitation.employment.frequency}`
                  : ''}
              </span>}
              {props.invitation.employment.notes && <small>{props.invitation.employment.notes}</small>}
            </div>}
            {props.invitation.existingUser
              ? <button className="primary-button" type="button" onClick={() => setMode('LOGIN')}>Iniciar sesión para aceptar</button>
              : <button className="primary-button" type="button" onClick={() => setMode('REGISTER')}>Crear cuenta para aceptar</button>}
          </>}
        </div>}

        {mode === 'LOGIN' && <>
          <div className="auth-tabs" role="tablist">
            <button className="active" type="button" role="tab">Ingresar</button>
            <button type="button" role="tab" onClick={() => setMode('REGISTER')}>Crear cuenta</button>
          </div>
          <span className="eyebrow">Acceso seguro</span>
          <h2>Iniciar sesión</h2>
          <p className="muted">Ingresa con el correo configurado para tu cuenta.</p>
          <form onSubmit={submitLogin} className="login-form">
            <label><span>Correo electrónico</span><input type="email" autoComplete="username"
              value={email} onChange={(event) => setEmail(event.target.value)}
              placeholder="nombre@correo.com" required disabled={props.busy} /></label>
            <label><span>Contraseña</span><span className="password-field">
              <input type={showPassword ? 'text' : 'password'} autoComplete="current-password"
                value={password} onChange={(event) => setPassword(event.target.value)}
                placeholder="Tu contraseña" required disabled={props.busy} />
              <button type="button" onClick={() => setShowPassword((value) => !value)}>
                {showPassword ? 'Ocultar' : 'Mostrar'}
              </button>
            </span></label>
            {props.error && <div className="form-error" role="alert">{props.error}</div>}
            <button className="primary-button" type="submit" disabled={props.busy}>
              {props.busy ? <><span className="spinner" />Ingresando…</> : 'Ingresar'}
            </button>
          </form>
          <p className="security-note">La sesión se protege de forma independiente en cada dispositivo.</p>
        </>}

        {mode === 'REGISTER' && <>
          <div className="auth-tabs" role="tablist">
            <button type="button" role="tab" onClick={useLogin}>Ingresar</button>
            <button className="active" type="button" role="tab">Crear cuenta</button>
          </div>
          <span className="eyebrow">{props.invitation ? 'Aceptar colaboración' : 'Primera propiedad incluida'}</span>
          <h2>{props.invitation ? 'Crear mi usuario' : 'Crear mi espacio'}</h2>
          <p className="muted">{props.invitation
            ? `Tu usuario quedará listo para colaborar en ${props.invitation.property.name}.`
            : 'Se creará tu usuario, cuenta administrativa y primera propiedad.'}</p>
          <form onSubmit={submitRegistration} className="login-form registration-form">
            <div className="field-pair">
              <label><span>Tu nombre</span><input autoComplete="name" value={displayName}
                onChange={(event) => setDisplayName(event.target.value)} minLength={2} maxLength={160}
                placeholder="Nombre completo" required disabled={props.busy} /></label>
              {!props.invitation && <label><span>Nombre de la propiedad</span><input value={propertyName}
                onChange={(event) => setPropertyName(event.target.value)} minLength={2} maxLength={160}
                placeholder="Ej. La Fortuna" required disabled={props.busy} /></label>}
            </div>
            <label><span>Correo electrónico</span><input type="email" autoComplete="email"
              value={registerEmail} onChange={(event) => setRegisterEmail(event.target.value)}
              placeholder="nombre@correo.com" required disabled={props.busy || Boolean(props.invitation)} /></label>
            <div className="field-pair">
              <label><span>Contraseña</span><input type="password" autoComplete="new-password"
                value={registerPassword} onChange={(event) => setRegisterPassword(event.target.value)}
                maxLength={128} required disabled={props.busy} /></label>
              <label><span>Confirmar contraseña</span><input type="password" autoComplete="new-password"
                value={confirmation} onChange={(event) => setConfirmation(event.target.value)}
                maxLength={128} required disabled={props.busy} /></label>
            </div>
            <div className="password-requirements" aria-live="polite">
              <span className={requirements.length ? 'valid' : ''}>✓ 12 caracteres</span>
              <span className={requirements.letter ? 'valid' : ''}>✓ Una letra</span>
              <span className={requirements.number ? 'valid' : ''}>✓ Un número</span>
              <span className={requirements.matches ? 'valid' : ''}>✓ Coinciden</span>
            </div>
            {props.error && <div className="form-error" role="alert">{props.error}</div>}
            <button className="primary-button" type="submit"
              disabled={props.busy || !passwordValid || !requirements.matches}>
              {props.busy ? <><span className="spinner" />Creando…</>
                : props.invitation ? 'Crear cuenta y continuar' : 'Crear cuenta y propiedad'}
            </button>
          </form>
        </>}

        {mode === 'PENDING' && props.pendingRegistration && <div className="verification-card">
          <span className="verification-icon">✉</span>
          <span className="eyebrow">Cuenta creada</span>
          <h2>Verifica tu correo</h2>
          <p>Enviamos el enlace de activación a <strong>{props.pendingRegistration.email}</strong>.</p>
          {props.pendingRegistration.delivery !== 'SENT' && <div className="form-error">
            La cuenta se creó, pero el correo no pudo enviarse. Verifica la configuración de correo y solicita otro.
          </div>}
          {props.resendAccepted && <div className="form-success">Si la cuenta sigue pendiente, enviaremos un nuevo enlace. Revisa también spam.</div>}
          {props.error && <div className="form-error" role="alert">{props.error}</div>}
          <button className="primary-button" type="button" disabled={props.busy}
            onClick={() => props.onResend(props.pendingRegistration!.email)}>
            {props.busy ? 'Solicitando…' : 'Reenviar correo'}
          </button>
          <button className="text-button auth-back" type="button" onClick={useLogin}>Volver a iniciar sesión</button>
        </div>}

        {mode === 'VERIFY_RESULT' && <div className="verification-card">
          <span className={`verification-icon ${props.verificationState === 'INVALID' ? 'failed' : ''}`}>
            {props.verificationState === 'CHECKING' ? <span className="spinner large" />
              : props.verificationState === 'VERIFIED' ? '✓' : '!'}
          </span>
          <span className="eyebrow">Verificación de correo</span>
          <h2>{props.verificationState === 'CHECKING' ? 'Validando enlace…'
            : props.verificationState === 'VERIFIED' ? 'Cuenta activada' : 'Enlace no válido'}</h2>
          <p>{props.verificationMessage || 'Espera un momento mientras comprobamos tu enlace.'}</p>
          {props.verificationState !== 'CHECKING' && <button className="primary-button" type="button" onClick={useLogin}>
            Ir a iniciar sesión
          </button>}
        </div>}
      </div>
    </section>
  </main>;
}
