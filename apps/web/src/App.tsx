import { FormEvent, useEffect, useState } from 'react';
import {
  ApiRequestError,
  changeContext,
  getSessionOverview,
  login,
  logout,
  refreshSession,
  type SessionOverview,
  type SessionPayload,
} from './api';
import { SuperadminPanel } from './SuperadminPanel';

type Theme = 'light' | 'dark';
type AppSession = SessionPayload & { overview: SessionOverview };

const deviceStorageKey = 'sgb.device-id';
const themeStorageKey = 'sgb.theme';

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

function Brand() {
  return <div className="brand" aria-label="Sistema de Gestión Bovina">
    <span className="brand-mark" aria-hidden="true">SGB</span>
    <span className="brand-copy"><strong>SGB</strong><small>Gestión bovina</small></span>
  </div>;
}

function LoginScreen({ busy, error, onLogin }: {
  busy: boolean;
  error: string | null;
  onLogin: (email: string, password: string) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    await onLogin(email, password);
  }

  return <main className="login-layout">
    <section className="login-intro">
      <Brand />
      <div className="intro-copy">
        <span className="eyebrow">SGB 2.0</span>
        <h1>Tu finca, organizada y disponible donde estés.</h1>
        <p>Una nueva base preparada para trabajar por propiedad, por rol y con funcionamiento sin conexión.</p>
      </div>
      <div className="intro-points">
        <span>Seguridad y auditoría</span><span>Acceso por propiedad</span><span>Base para trabajo offline</span>
      </div>
    </section>

    <section className="login-panel">
      <div className="login-card">
        <div className="mobile-brand"><Brand /></div>
        <span className="eyebrow">Acceso seguro</span>
        <h2>Iniciar sesión</h2>
        <p className="muted">Ingresa con el correo configurado para tu cuenta.</p>
        <form onSubmit={submit} className="login-form">
          <label><span>Correo electrónico</span><input type="email" autoComplete="username"
            value={email} onChange={(event) => setEmail(event.target.value)}
            placeholder="nombre@correo.com" required disabled={busy} /></label>
          <label><span>Contraseña</span><span className="password-field">
            <input type={showPassword ? 'text' : 'password'} autoComplete="current-password"
              value={password} onChange={(event) => setPassword(event.target.value)}
              placeholder="Tu contraseña" required disabled={busy} />
            <button type="button" onClick={() => setShowPassword((value) => !value)}>
              {showPassword ? 'Ocultar' : 'Mostrar'}
            </button>
          </span></label>
          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? <><span className="spinner" />Ingresando…</> : 'Ingresar'}
          </button>
        </form>
        <p className="security-note">La sesión se protege de forma independiente en cada dispositivo.</p>
      </div>
    </section>
  </main>;
}

function Dashboard({ session, busy, error, onLogout, onContextChange }: {
  session: AppSession;
  busy: boolean;
  error: string | null;
  onLogout: () => Promise<void>;
  onContextChange: (propertyId: string, roleId: string) => Promise<void>;
}) {
  const { overview } = session;
  const activeProperty = overview.properties.find((item) => item.id === overview.activeContext?.propertyId);
  const [propertyId, setPropertyId] = useState(overview.activeContext?.propertyId || overview.properties[0]?.id || '');
  const property = overview.properties.find((item) => item.id === propertyId);
  const [roleId, setRoleId] = useState(overview.activeContext?.roleId || property?.roles[0]?.id || '');

  useEffect(() => {
    if (!property?.roles.some((role) => role.id === roleId)) setRoleId(property?.roles[0]?.id || '');
  }, [property, roleId]);

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
            ? 'Desde aquí administrarás las cuentas, los módulos y la seguridad general de SGB.'
            : `Trabajando en ${activeProperty?.name || 'tu espacio de SGB'}.`}</p></div>
        <div className="access-badge"><span>✓</span><div><strong>Acceso verificado</strong><small>{overview.user.email}</small></div></div>
      </section>
      {error && <div className="form-error dashboard-error" role="alert">{error}</div>}

      {!overview.user.isSuperadmin && overview.properties.length > 0 && <section className="context-card">
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
        <article><span>Tipo de acceso</span><strong>{overview.user.isSuperadmin ? 'Global' : 'Por propiedad'}</strong></article>
        <article><span>Propiedades disponibles</span><strong>{overview.properties.length}</strong></article>
        <article><span>Sesión</span><strong>Protegida</strong></article>
      </section>

      {overview.user.isSuperadmin ? <SuperadminPanel accessToken={session.accessToken} /> : <section className="section-block">
        <div className="section-heading"><div><span className="eyebrow">Acceso disponible</span><h2>Módulos habilitados</h2></div></div>
        <div className="module-list">{(activeProperty?.enabledModules || []).map((module) => <span key={module}>{module}</span>)}</div>
      </section>}
    </main>
  </div>;
}

export function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [session, setSession] = useState<AppSession | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return <>
    <div className="theme-corner"><button className="icon-button" type="button"
      onClick={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')}
      aria-label={theme === 'dark' ? 'Usar modo claro' : 'Usar modo oscuro'}>{theme === 'dark' ? '☀' : '☾'}</button></div>
    {initializing ? <main className="loading-screen"><Brand /><span className="spinner large" />
      <p>Restaurando sesión segura…</p></main>
      : session ? <Dashboard session={session} busy={busy} error={error} onLogout={handleLogout}
        onContextChange={handleContextChange} />
        : <LoginScreen busy={busy} error={error} onLogin={handleLogin} />}
  </>;
}
