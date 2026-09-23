import { type FormEvent, useEffect, useState } from 'react';
import {
  ApiRequestError, createAccountProperty, getPropertySettings, updatePropertyModule,
  type PropertySettings,
} from './api';

export function PropertySettingsPanel({ accessToken, onPropertyCreated, onSettingsChanged }: {
  accessToken: string;
  onPropertyCreated: (propertyId: string, roleId: string) => Promise<void>;
  onSettingsChanged: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<PropertySettings | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getPropertySettings(accessToken).then((value) => {
      if (active) setSettings(value);
    }).catch((loadError) => {
      if (active) setError(message(loadError));
    });
    return () => { active = false; };
  }, [accessToken]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get('name') || '').trim();
    setBusy(true); setError(null);
    try {
      const created = await createAccountProperty(accessToken, name);
      await onPropertyCreated(created.propertyId, created.roleId);
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }

  async function changeModule(code: string, enabled: boolean) {
    setBusy(true); setError(null);
    try {
      await updatePropertyModule(accessToken, code, enabled);
      setSettings(await getPropertySettings(accessToken));
      await onSettingsChanged();
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }

  return <section className="section-block property-settings-panel">
    <div className="section-heading"><div><span className="eyebrow">Configuración individual</span>
      <h2>Propiedades y módulos</h2>
      {settings && <p className="muted">{settings.account.name} · {settings.account.usedProperties} de {settings.account.maxProperties} propiedades.</p>}
    </div>
      {settings?.canCreate && settings.account.usedProperties < settings.account.maxProperties &&
        <button className="primary-button compact" type="button" onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? 'Cerrar' : '+ Propiedad'}
        </button>}
    </div>
    {error && <div className="form-error admin-error" role="alert">{error}</div>}
    {!settings && !error && <p className="muted">Cargando configuración…</p>}
    {settings && <>
      {settings.canCreate && settings.account.usedProperties >= settings.account.maxProperties &&
        <p className="muted">Se alcanzó el límite de esta cuenta. El superadministrador puede ampliarlo.</p>}
      {showCreate && <form className="new-property-form" onSubmit={create}>
        <label><span>Nombre de la nueva propiedad</span><input name="name" minLength={2} maxLength={160}
          autoComplete="off" required disabled={busy} placeholder="Ej. Finca El Estero" /></label>
        <button className="primary-button compact" disabled={busy} type="submit">
          {busy ? 'Creando…' : 'Crear propiedad'}</button>
      </form>}
      <div className="property-module-grid">{settings.modules.map((module) =>
        <div className="property-module-row" key={module.code}>
          <div><strong>{module.name}</strong><small>{module.isCore ? 'Siempre activo'
            : !module.accountEnabled ? 'Deshabilitado para la cuenta'
              : module.enabled ? 'Activo en esta propiedad' : 'Inactivo en esta propiedad'}</small></div>
          <label className="property-module-toggle"><input type="checkbox" checked={module.enabled}
            disabled={busy || !settings.canManageModules || module.isCore || !module.accountEnabled}
            onChange={(event) => void changeModule(module.code, event.target.checked)}
            aria-label={`${module.name} en esta propiedad`} /></label>
        </div>)}</div>
    </>}
  </section>;
}

function message(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : 'No fue posible completar la operación.';
}
