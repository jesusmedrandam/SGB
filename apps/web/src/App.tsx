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
import { AnimalPanel } from './AnimalPanel';
import { Brand } from './Brand';
import { GroupPanel } from './GroupPanel';
import { CatalogPanel } from './CatalogPanel';
import { PropertyTeamPanel } from './PropertyTeamPanel';
import { PropertySettingsPanel } from './PropertySettingsPanel';
import { SuperadminPanel } from './SuperadminPanel';
import { ReproductionPanel } from './ReproductionPanel';
import { ProductionPanel } from './ProductionPanel';
import { MovementPanel } from './MovementPanel';
import { HealthPanel } from './HealthPanel';
import { ShellIcon, type ShellIconName } from './ShellIcon';

type Theme = 'light' | 'dark';
type AppSession = SessionPayload & { overview: SessionOverview };
type SectionId = 'home'|'animals'|'groups'|'reproduction'|'production'|'catalogs'|
  'movements'|'health'|'team'|'settings'|'admin';
type NavigationItem = { id:SectionId; label:string; description:string; icon:ShellIconName;
  group:'principal'|'operations'|'configuration'; enabled:boolean };

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
  onPropertyCreated, onSettingsChanged, onOwnAccountCreated, theme, onToggleTheme }: {
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
  theme:Theme;
  onToggleTheme:()=>void;
}) {
  const { overview } = session;
  const activeProperty = overview.properties.find((item) => item.id === overview.activeContext?.propertyId);
  const [propertyId, setPropertyId] = useState(overview.activeContext?.propertyId || overview.properties[0]?.id || '');
  const property = overview.properties.find((item) => item.id === propertyId);
  const [roleId, setRoleId] = useState(overview.activeContext?.roleId || property?.roles[0]?.id || '');
  const [showOwnAccount, setShowOwnAccount] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [requestedSection, setRequestedSection] = useState<SectionId>(()=>
    window.location.hash.slice(1) as SectionId || 'home');
  const activeRole = activeProperty?.roles.find((role) => role.id === overview.activeContext?.roleId);
  const has=(permission:string)=>Boolean(activeProperty && activeRole?.permissions.includes(permission));
  const modules=activeProperty?.enabledModules??[];
  const navigation=([
    {id:'home',label:'Panel',description:'Resumen de tu propiedad',icon:'home',group:'principal',enabled:true},
    {id:'animals',label:'Animales',description:'Inventario y fichas',icon:'animals',group:'principal',enabled:has('ANIMAL_VIEW')},
    {id:'groups',label:'Grupos y potreros',description:'Grupos y ubicaciones',icon:'groups',group:'principal',enabled:has('GROUP_VIEW')},
    {id:'reproduction',label:'Reproducción',description:'Celos, preñeces y partos',icon:'reproduction',group:'operations',enabled:has('REPRODUCTION_VIEW')&&modules.includes('REPRODUCTION')},
    {id:'production',label:'Producción',description:'Lactancias y ordeños',icon:'production',group:'operations',enabled:has('PRODUCTION_VIEW')&&modules.includes('PRODUCTION')},
    {id:'movements',label:'Movimientos',description:'Grupos, potreros y traslados',icon:'movements',group:'operations',enabled:has('MOVEMENT_VIEW')&&modules.includes('MOVEMENTS')},
    {id:'health',label:'Sanidad',description:'Medicamentos y tratamientos',icon:'health',group:'operations',enabled:has('HEALTH_VIEW')&&modules.includes('HEALTH')},
    {id:'catalogs',label:'Catálogos',description:'Razas, colores y marquillas',icon:'catalogs',group:'configuration',enabled:has('CATALOG_VIEW')},
    {id:'team',label:'Equipo y roles',description:'Acceso a la propiedad',icon:'team',group:'configuration',enabled:has('MEMBERSHIP_VIEW')},
    {id:'settings',label:'Configuración',description:'Propiedades y módulos',icon:'settings',group:'configuration',enabled:has('MODULE_VIEW')},
    {id:'admin',label:'Administración',description:'Cuentas de la plataforma',icon:'admin',group:'configuration',enabled:overview.user.isSuperadmin},
  ] satisfies NavigationItem[]).filter((item)=>item.enabled);
  const section=navigation.some((item)=>item.id===requestedSection)?requestedSection:'home';
  const current=navigation.find((item)=>item.id===section)!;

  useEffect(()=>{
    const onHashChange=()=>setRequestedSection(window.location.hash.slice(1) as SectionId || 'home');
    window.addEventListener('hashchange',onHashChange);
    return ()=>window.removeEventListener('hashchange',onHashChange);
  },[]);
  function openSection(id:SectionId){
    setRequestedSection(id);setMenuOpen(false);
    window.location.hash=id==='home'?'home':id;
    window.scrollTo({top:0,behavior:'instant'});
  }

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

  return <div className="app-shell livestock-shell">
    {menuOpen&&<button className="mobile-overlay" type="button" aria-label="Cerrar menú"
      onClick={()=>setMenuOpen(false)}/>}
    <aside className={`sidebar${menuOpen?' sidebar-open':''}`}>
      <div className="sidebar-brand"><Brand/><button className="sidebar-close" type="button"
        aria-label="Cerrar menú" onClick={()=>setMenuOpen(false)}><ShellIcon name="close"/></button></div>
      <div className="sidebar-property"><span>Propiedad activa</span><strong>{activeProperty?.name??'Sin propiedad seleccionada'}</strong>
        <small>{activeRole?.name??'Selecciona un rol'}</small></div>
      <nav className="sidebar-nav" aria-label="Secciones">
        {(['principal','operations','configuration'] as const).map((group)=>{
          const items=navigation.filter((item)=>item.group===group);
          return items.length?<div key={group} className="nav-section">
            <span>{group==='principal'?'Gestión principal':group==='operations'?'Operaciones':'Cuenta y administración'}</span>
            {items.map((item)=><button key={item.id} type="button"
              className={`nav-item${section===item.id?' active':''}`} aria-current={section===item.id?'page':undefined}
              onClick={()=>openSection(item.id)}><ShellIcon name={item.icon}/><span>{item.label}</span>
              <ShellIcon name="chevron" size={15}/></button>)}
          </div>:null;
        })}
      </nav>
      <div className="sidebar-user"><span className="user-avatar">{overview.user.displayName.slice(0,1).toUpperCase()}</span>
        <span className="sidebar-user-copy"><strong>{overview.user.displayName}</strong>
          <small>{overview.user.isSuperadmin?'Superadministrador':activeRole?.name??'Usuario'}</small></span>
        <button type="button" aria-label="Cerrar sesión" title="Cerrar sesión" onClick={()=>void onLogout()}
          disabled={busy}><ShellIcon name="logout"/></button></div>
    </aside>
    <div className="shell-main">
    <header className="topbar">
      <div className="topbar-left"><button className="mobile-menu-button" type="button" aria-label="Abrir menú"
        onClick={()=>setMenuOpen(true)}><ShellIcon name="menu" size={22}/></button>
        <div><span className="breadcrumb">Sistema de Gestión Bovina</span><h2>{current.label}</h2></div></div>
      <div className="topbar-actions"><span className="connection-status"><i/>Servidor conectado</span>
        <button type="button" className="header-icon" onClick={onToggleTheme}
          title={theme==='dark'?'Usar modo claro':'Usar modo oscuro'}
          aria-label={theme==='dark'?'Usar modo claro':'Usar modo oscuro'}>
          <ShellIcon name={theme==='dark'?'sun':'moon'}/></button>
        <span className="header-avatar" aria-label={overview.user.displayName}>
          {overview.user.displayName.slice(0,1).toUpperCase()}</span></div>
    </header>
    <main className="dashboard page-content">
      {error && <div className="form-error dashboard-error" role="alert">{error}</div>}
      {invitation && <section className="invitation-banner">
        <div><span className="eyebrow">Invitación pendiente</span><h2>{invitation.property.name}</h2>
          <p>{invitation.invitedBy} te asignó {invitation.roles.map((role) => role.name).join(', ')}.</p></div>
        <button className="primary-button compact" type="button" disabled={busy} onClick={onAcceptInvitation}>
          {busy ? 'Aceptando…' : 'Aceptar invitación'}</button>
      </section>}
      {section==='home'&&<>
      <section className="welcome-card">
        <div><span className="eyebrow">Panel principal</span><h1>Hola, {overview.user.displayName.split(' ')[0]}</h1>
          <p>{overview.user.isSuperadmin
            ? activeProperty
              ? `Administras la plataforma y trabajas en ${activeProperty.name}.`
              : 'Desde aquí administrarás las cuentas, los módulos y la seguridad general de SGB.'
            : `Trabajando en ${activeProperty?.name || 'tu espacio de SGB'}.`}</p></div>
        <div className="access-badge"><span>✓</span><div><strong>Acceso verificado</strong><small>{overview.user.email}</small></div></div>
      </section>
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

      <section className="dashboard-modules section-block" aria-labelledby="module-heading">
        <div className="section-heading"><div><span className="eyebrow">Tu espacio de trabajo</span>
          <h2 id="module-heading">Módulos disponibles</h2></div></div>
        <div className="dashboard-module-grid">{navigation.filter((item)=>item.id!=='home').map((item)=><button
          key={item.id} type="button" className="dashboard-module-card" onClick={()=>openSection(item.id)}>
          <span className={`stat-icon stat-${item.id}`}><ShellIcon name={item.icon} size={23}/></span>
          <span className="dashboard-module-copy"><strong>{item.label}</strong><small>{item.description}</small></span>
          <ShellIcon name="chevron" size={17}/>
        </button>)}</div>
      </section>
      <section className="summary-grid" aria-label="Tu acceso">
        <article><span>Propiedades disponibles</span><strong>{overview.properties.length}</strong></article>
        <article><span>Módulos habilitados</span><strong>{activeProperty?.enabledModules.length??0}</strong></article>
        <article><span>Rol activo</span><strong>{activeRole?.name??'Sin rol'}</strong></article>
      </section>
      </>}
      {section==='admin' && overview.user.isSuperadmin && <SuperadminPanel accessToken={session.accessToken} />}
      {section==='team' && activeProperty && activeRole?.permissions.includes('MEMBERSHIP_VIEW')
        && <PropertyTeamPanel key={`${activeProperty?.id}:${activeRole.id}`} accessToken={session.accessToken} />}
      {section==='settings' && activeProperty && activeRole?.permissions.includes('MODULE_VIEW') &&
        <PropertySettingsPanel key={`${activeProperty?.id}:${activeRole.id}`} accessToken={session.accessToken}
          onPropertyCreated={onPropertyCreated} onSettingsChanged={onSettingsChanged} />}
      {section==='catalogs' && activeProperty && activeRole?.permissions.includes('CATALOG_VIEW') &&
        <CatalogPanel key={`${activeProperty?.id}:${activeRole.id}`} accessToken={session.accessToken}
          canManage={activeRole.permissions.includes('CATALOG_MANAGE')} />}
      {section==='animals' && activeProperty && activeRole?.permissions.includes('ANIMAL_VIEW') &&
        <AnimalPanel key={`${activeProperty.id}:${activeRole.id}`} accessToken={session.accessToken}
          canCreate={activeRole.permissions.includes('ANIMAL_CREATE')}
          canUpdate={activeRole.permissions.includes('ANIMAL_UPDATE')}
          canManageBrands={activeRole.permissions.includes('CATALOG_MANAGE')}
          canViewCatalogs={activeRole.permissions.includes('CATALOG_VIEW')} />}
      {section==='groups' && activeProperty && activeRole?.permissions.includes('GROUP_VIEW') &&
        <GroupPanel key={`groups:${activeProperty.id}:${activeRole.id}`} accessToken={session.accessToken}
          modules={activeProperty.enabledModules}
          canManage={activeRole.permissions.includes('GROUP_MANAGE')}
          canViewLocations={activeRole.permissions.includes('LOCATION_VIEW')}
          canManageLocations={activeRole.permissions.includes('LOCATION_MANAGE')}
          canAssignAnimals={activeRole.permissions.includes('ANIMAL_VIEW')
            && activeRole.permissions.includes('ANIMAL_UPDATE')} />}
      {section==='reproduction' && activeProperty && activeProperty.enabledModules.includes('REPRODUCTION')
        && activeRole?.permissions.includes('REPRODUCTION_VIEW') &&
        <ReproductionPanel key={`reproduction:${activeProperty.id}:${activeRole.id}`}
          accessToken={session.accessToken}
          canManage={activeRole.permissions.includes('REPRODUCTION_MANAGE')} />}
      {section==='production' && activeProperty && activeProperty.enabledModules.includes('PRODUCTION')
        && activeRole?.permissions.includes('PRODUCTION_VIEW') &&
        <ProductionPanel key={`production:${activeProperty.id}:${activeRole.id}`}
          accessToken={session.accessToken}
          canManage={activeRole.permissions.includes('PRODUCTION_MANAGE')} />}
      {section==='movements' && activeProperty && activeProperty.enabledModules.includes('MOVEMENTS')
        && activeRole?.permissions.includes('MOVEMENT_VIEW') &&
        <MovementPanel key={`movements:${activeProperty.id}:${activeRole.id}`}
          accessToken={session.accessToken} propertyId={activeProperty.id}
          canManage={activeRole.permissions.includes('MOVEMENT_MANAGE')}
          canCancel={activeRole.permissions.includes('MOVEMENT_CANCEL')} />}
      {section==='health' && activeProperty && activeProperty.enabledModules.includes('HEALTH')
        && activeRole?.permissions.includes('HEALTH_VIEW') &&
        <HealthPanel key={`health:${activeProperty.id}:${activeRole.id}`}
          accessToken={session.accessToken} canManage={activeRole.permissions.includes('HEALTH_MANAGE')} />}
    </main>
    <footer className="app-footer">SGB · Sistema de Gestión Bovina</footer>
    </div>
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
    {!session && <div className="theme-corner"><button className="icon-button" type="button"
      onClick={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')}
      aria-label={theme === 'dark' ? 'Usar modo claro' : 'Usar modo oscuro'}>{theme === 'dark' ? '☀' : '☾'}</button></div>}
    {initializing ? <main className="loading-screen"><Brand /><span className="spinner large" />
      <p>Restaurando sesión segura…</p></main>
      : session ? <Dashboard session={session} busy={busy} error={error} invitation={invitation}
        theme={theme} onToggleTheme={()=>setTheme((value)=>value==='dark'?'light':'dark')}
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
