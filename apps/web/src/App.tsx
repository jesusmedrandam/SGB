import { type FormEvent, useEffect, useState } from 'react';
import {
  ApiRequestError,
  acceptInvitation,
  changeContext,
  createOwnAccount,
  getInvitationPreview,
  getSessionOverview,
  login,
  logout,
  register,
  refreshSession,
  resendVerification,
  verifyEmail,
  type InvitationPreview,
  type RegistrationResult,
  type SessionOverview,
  type SessionPayload,
} from './api';
import { AuthScreen, type VerificationState } from './AuthScreen';
import { Brand } from './Brand';
import { CatalogPanel } from './CatalogPanel';
import { PropertyTeamPanel } from './PropertyTeamPanel';
import { PropertySettingsPanel } from './PropertySettingsPanel';
import { SuperadminPanel } from './SuperadminPanel';

type Theme = 'light' | 'dark';
type AppSession = SessionPayload & { overview: SessionOverview };

const deviceStorageKey = 'sgb.device-id';
const themeStorageKey = 'sgb.theme';
const invitationStorageKey = 'sgb.pending-invitation';

function deviceId(): string {
  const existing = localStorage.getItem(deviceStorageKey);
  if (existing) return existing;
  const value = typeof crypto.randomUUID === 'function'
    ? `web-${crypto.randomUUID()}`
    : `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(deviceStorageKey, value);
  return value;
}

function initialTheme(): Theme {
  const saved = localStorage.getItem(themeStorageKey);
  if (saved === 'light' || saved === 'dark') return saved;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function errorMessage(error: unknown): string {
  return error instanceof ApiRequestError
    ? error.message
    : 'Ocurrió un error inesperado. Inténtalo nuevamente.';
}

function Dashboard({ session, busy, error, invitation, onAcceptInvitation, onLogout, onContextChange,
  onPropertyCreated, onSettingsChanged, onOwnAccountCreated }: {
  session: AppSession;
  busy: boolean;
  error: string | null;
  invitation: InvitationPreview | null;
  onAcceptInvitation: () => Promise<void>;
  onLogout: () => Promise<void>;
  onContextChange: (propertyId: string, roleId: string) => Promise<void>;
  onPropertyCreated: (propertyId: string, roleId: string) => Promise<void>;
  onSettingsChanged: () => Promise<void>;
  onOwnAccountCreated: (name: string) => Promise<void>;
}) {
  const { overview } = session;
  const activeProperty = overview.properties.find((item) => item.id === overview.activeContext?.propertyId);
  const [propertyId, setPropertyId] = useState(overview.activeContext?.propertyId || overview.properties[0]?.id || '');
  const property = overview.properties.find((item) => item.id === propertyId);
  const [roleId, setRoleId] = useState(overview.activeContext?.roleId || property?.roles[0]?.id || '');
  const [showOwnAccount, setShowOwnAccount] = useState(false);
  const activeRole = activeProperty?.roles.find((role) => role.id === overview.activeContext?.roleId);

  useEffect(() => {
    if (!property?.roles.some((role) => role.id === roleId)) setRoleId(property?.roles[0]?.id || '');
  }, [property, roleId]);

  useEffect(() => {
    if (overview.activeContext) {
      setPropertyId(overview.activeContext.propertyId);
      setRoleId(overview.activeContext.roleId);
    }
  }, [overview.activeContext?.propertyId, overview.activeContext?.roleId]);

  async function createOwn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name') || '').trim();
    await onOwnAccountCreated(name);
  }

  return <div className="app-shell">
    <header className="topbar">
      <Brand />
      <div className="topbar-actions">
        <span className="connection-status"><i />Servidor conectado</span>
        <div className="profile-button"><span>{overview.user.displayName.slice(0, 1).toUpperCase()}</span>
          <span className="profile-copy"><strong>{overview.user.displayName}</strong>
            <small>{overview.user.isSuperadmin ? 'Superadministrador' : 'Usuario'}</small></span></div>
        <button className="secondary-button compact" type="button" onClick={onLogout} disabled={busy}>Salir</button>
      </div>
    </header>
    <main className="dashboard">
      <section className="welcome-card">
        <div><span className="eyebrow">Panel principal</span><h1>Hola, {overview.user.displayName.split(' ')[0]}</h1>
          <p>{overview.user.isSuperadmin
            ? activeProperty
              ? `Administras la plataforma y trabajas en ${activeProperty.name}.`
              : 'Desde aquí administrarás las cuentas, los módulos y la seguridad general de SGB.'
            : `Trabajando en ${activeProperty?.name || 'tu espacio de SGB'}.`}</p></div>
        <div className="access-badge"><span>✓</span><div><strong>Acceso verificado</strong><small>{overview.user.email}</small></div></div>
      </section>
      {error && <div className="form-error dashboard-error" role="alert">{error}</div>}

      {invitation && <section className="invitation-banner">
        <div><span className="eyebrow">Invitación pendiente</span><h2>{invitation.property.name}</h2>
          <p>{invitation.invitedBy} te asignó {invitation.roles.map((role) => role.name).join(', ')}.</p></div>
        <button className="primary-button compact" type="button" disabled={busy} onClick={onAcceptInvitation}>
          {busy ? 'Aceptando…' : 'Aceptar invitación'}
        </button>
      </section>}

      {!overview.ownedAccount && <section className="context-card">
        <div><span className="eyebrow">Tu cuenta</span><h2>Propiedad propia</h2>
          <p className="muted">Puedes administrar tu propia finca y seguir colaborando en las demás.</p></div>
        {showOwnAccount ? <form className="new-property-form" onSubmit={createOwn}>
          <label><span>Nombre de la propiedad</span><input name="name" minLength={2} maxLength={160}
            placeholder="Ej. La Fortuna" required disabled={busy} /></label>
          <button className="primary-button compact" type="submit" disabled={busy}>
            {busy ? 'Creando…' : 'Crear mi propiedad'}</button>
        </form> : <button className="primary-button compact" type="button"
          onClick={() => setShowOwnAccount(true)}>Crear propiedad propia</button>}
      </section>}

      {overview.properties.length > 0 && <section className="context-card">
        <div><span className="eyebrow">Contexto activo</span><h2>Propiedad y rol</h2>
          <p className="muted">Cada operación se limita a la combinación seleccionada.</p></div>
        <div className="context-controls">
          <label><span>Propiedad</span><select value={propertyId} onChange={(event) => setPropertyId(event.target.value)}>
            {overview.properties.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label><span>Rol</span><select value={roleId} onChange={(event) => setRoleId(event.target.value)}>
            {property?.roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
          <button className="primary-button compact" type="button" disabled={busy || !propertyId || !roleId}
            onClick={() => onContextChange(propertyId, roleId)}>Aplicar</button>
        </div>
      </section>}

      <section className="summary-grid">
        <article><span>Tipo de acceso</span><strong>{overview.user.isSuperadmin
          ? overview.properties.length ? 'Global y por propiedad' : 'Global' : 'Por propiedad'}</strong></article>
        <article><span>Propiedades disponibles</span><strong>{overview.properties.length}</strong></article>
        <article><span>Sesión</span><strong>Protegida</strong></article>
      </section>

      {overview.user.isSuperadmin && <SuperadminPanel accessToken={session.accessToken} />}
      {activeProperty && activeRole && <section className="section-block">
        <div className="section-heading"><div><span className="eyebrow">Acceso disponible</span><h2>Módulos habilitados</h2></div></div>
        <div className="module-list">{(activeProperty?.enabledModules || []).map((module) => <span key={module}>{module}</span>)}</div>
      </section>}
      {activeProperty && activeRole?.permissions.includes('MEMBERSHIP_VIEW')
        && <PropertyTeamPanel key={`${activeProperty?.id}:${activeRole.id}`} accessToken={session.accessToken} />}
      {activeProperty && activeRole?.permissions.includes('MODULE_VIEW') &&
        <PropertySettingsPanel key={`${activeProperty?.id}:${activeRole.id}`} accessToken={session.accessToken}
          onPropertyCreated={onPropertyCreated} onSettingsChanged={onSettingsChanged} />}
      {activeProperty && activeRole?.permissions.includes('CATALOG_VIEW') &&
        <CatalogPanel key={`${activeProperty?.id}:${activeRole.id}`} accessToken={session.accessToken}
          canManage={activeRole.permissions.includes('CATALOG_MANAGE')} />}
    </main>
  </div>;
}

export function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [session, setSession] = useState<AppSession | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingRegistration, setPendingRegistration] = useState<{
    email: string; delivery: RegistrationResult['verificationDelivery'];
  } | null>(null);
  const [resendAccepted, setResendAccepted] = useState(false);
  const [verificationToken, setVerificationToken] = useState(
    () => new URLSearchParams(window.location.search).get('verify-email'),
  );
  const [verificationState, setVerificationState] = useState<VerificationState>(
    verificationToken ? 'CHECKING' : 'NONE',
  );
  const [verificationMessage, setVerificationMessage] = useState<string | null>(null);
  const [invitationToken, setInvitationToken] = useState(() =>
    new URLSearchParams(window.location.search).get('invitation')
      || localStorage.getItem(invitationStorageKey),
  );
  const [invitation, setInvitation] = useState<InvitationPreview | null>(null);
  const [invitationLoading, setInvitationLoading] = useState(Boolean(invitationToken));
  const [invitationError, setInvitationError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(themeStorageKey, theme);
  }, [theme]);

  async function completeSession(payload: SessionPayload) {
    const overview = await getSessionOverview(payload.accessToken);
    setSession({ ...payload, overview });
  }

  useEffect(() => {
    void (async () => {
      try { await completeSession(await refreshSession()); }
      catch (restoreError) {
        if (!(restoreError instanceof ApiRequestError) || restoreError.status === 0) setError(errorMessage(restoreError));
      } finally { setInitializing(false); }
    })();
  }, []);

  useEffect(() => {
    if (!verificationToken) return;
    void verifyEmail(verificationToken).then(() => {
      setVerificationState('VERIFIED');
      setVerificationMessage('Tu correo quedó verificado. Ya puedes iniciar sesión.');
    }).catch((verificationError) => {
      setVerificationState('INVALID');
      setVerificationMessage(errorMessage(verificationError));
    }).finally(() => {
      const url = new URL(window.location.href);
      url.searchParams.delete('verify-email');
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
      setVerificationToken(null);
    });
  }, [verificationToken]);

  useEffect(() => {
    if (!invitationToken) return;
    setInvitationLoading(true);
    void getInvitationPreview(invitationToken).then((preview) => {
      setInvitation(preview);
      setInvitationError(null);
      localStorage.setItem(invitationStorageKey, invitationToken);
    }).catch((previewError) => {
      setInvitation(null);
      setInvitationError(errorMessage(previewError));
      setInvitationToken(null);
      localStorage.removeItem(invitationStorageKey);
    }).finally(() => {
      setInvitationLoading(false);
      const url = new URL(window.location.href);
      url.searchParams.delete('invitation');
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    });
  }, [invitationToken]);

  useEffect(() => {
    if (!session) return;
    const delay = Math.max(10_000, new Date(session.accessExpiresAt).getTime() - Date.now() - 60_000);
    const timer = window.setTimeout(() => void refreshSession().then(completeSession).catch(() => setSession(null)), delay);
    return () => window.clearTimeout(timer);
  }, [session?.accessExpiresAt]);

  async function handleLogin(email: string, password: string) {
    setBusy(true); setError(null);
    try { await completeSession(await login(email, password, deviceId())); }
    catch (loginError) { setError(errorMessage(loginError)); }
    finally { setBusy(false); }
  }

  async function handleRegister(input: {
    displayName: string; propertyName?: string; email: string; password: string; invitationToken?: string;
  }) {
    setBusy(true); setError(null); setResendAccepted(false);
    try {
      const result = await register(input);
      setPendingRegistration({ email: input.email, delivery: result.verificationDelivery });
    } catch (registrationError) { setError(errorMessage(registrationError)); }
    finally { setBusy(false); }
  }

  async function handleAcceptInvitation() {
    if (!session || !invitationToken) return;
    setBusy(true); setError(null);
    try {
      const accepted = await acceptInvitation(session.accessToken, invitationToken);
      const overview = await getSessionOverview(session.accessToken);
      setSession({
        ...session,
        activeContext: { propertyId: accepted.propertyId, roleId: accepted.roleId },
        overview,
      });
      setInvitation(null);
      setInvitationToken(null);
      setInvitationError(null);
      localStorage.removeItem(invitationStorageKey);
    } catch (acceptError) { setError(errorMessage(acceptError)); }
    finally { setBusy(false); }
  }

  async function handleResend(email: string) {
    setBusy(true); setError(null); setResendAccepted(false);
    try { await resendVerification(email); setResendAccepted(true); }
    catch (resendError) { setError(errorMessage(resendError)); }
    finally { setBusy(false); }
  }

  function useLogin() {
    setPendingRegistration(null);
    setResendAccepted(false);
    setVerificationState('NONE');
    setVerificationMessage(null);
    setError(null);
  }

  async function handleLogout() {
    setBusy(true); setError(null);
    try { await logout(session?.accessToken || null); }
    catch (logoutError) { setError(errorMessage(logoutError)); }
    finally { setSession(null); setBusy(false); }
  }

  async function handleContextChange(propertyId: string, roleId: string) {
    if (!session) return;
    setBusy(true); setError(null);
    try {
      await changeContext(session.accessToken, propertyId, roleId);
      const overview = await getSessionOverview(session.accessToken);
      setSession({ ...session, activeContext: { propertyId, roleId }, overview });
    } catch (contextError) { setError(errorMessage(contextError)); }
    finally { setBusy(false); }
  }

  async function handleOwnAccountCreated(name: string) {
    if (!session) return;
    setBusy(true); setError(null);
    try {
      const created = await createOwnAccount(session.accessToken, name);
      await handlePropertyCreated(created.propertyId, created.roleId);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  async function handlePropertyCreated(propertyId: string, roleId: string) {
    if (!session) return;
    const overview = await getSessionOverview(session.accessToken);
    setSession({ ...session, activeContext: { propertyId, roleId }, overview });
  }

  async function handleSettingsChanged() {
    if (!session) return;
    const overview = await getSessionOverview(session.accessToken);
    setSession({ ...session, overview });
  }

  return <>
    <div className="theme-corner"><button className="icon-button" type="button"
      onClick={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')}
      aria-label={theme === 'dark' ? 'Usar modo claro' : 'Usar modo oscuro'}>{theme === 'dark' ? '☀' : '☾'}</button></div>
    {initializing ? <main className="loading-screen"><Brand /><span className="spinner large" />
      <p>Restaurando sesión segura…</p></main>
      : session ? <Dashboard session={session} busy={busy} error={error} invitation={invitation}
        onAcceptInvitation={handleAcceptInvitation} onLogout={handleLogout} onContextChange={handleContextChange}
        onPropertyCreated={handlePropertyCreated} onSettingsChanged={handleSettingsChanged}
        onOwnAccountCreated={handleOwnAccountCreated} />
        : <AuthScreen busy={busy} error={error} pendingRegistration={pendingRegistration}
          verificationState={verificationState} verificationMessage={verificationMessage}
          resendAccepted={resendAccepted} invitationToken={invitationToken} invitation={invitation}
          invitationLoading={invitationLoading} invitationError={invitationError}
          onLogin={handleLogin} onRegister={handleRegister}
          onResend={handleResend} onUseLogin={useLogin} />}
  </>;
}
