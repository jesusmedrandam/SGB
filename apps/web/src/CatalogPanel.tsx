import { type FormEvent, useEffect, useState } from 'react';
import {
  ApiRequestError, createCatalogItem, getCatalogReference, listCatalogItems, setCatalogItemActive,
  type CatalogItem, type CatalogReference, type EditableCatalogCode,
} from './api';

const catalogs: Array<{ code: EditableCatalogCode; name: string }> = [
  { code: 'BREEDS', name: 'Razas' }, { code: 'COLORS', name: 'Colores' },
  { code: 'GRASS_TYPES', name: 'Pastos' },
  { code: 'HEALTH_CONDITION_TYPES', name: 'Problemas de salud' },
  { code: 'TREATMENT_TYPES', name: 'Tipos de tratamiento' },
  { code: 'AGROCHEMICAL_CATEGORIES', name: 'Categorías de productos' },
  { code: 'MEDIA_TAGS', name: 'Etiquetas multimedia' },
  { code: 'MOVEMENT_REASONS', name: 'Motivos de movimiento' },
];

export function CatalogPanel({ accessToken, canManage }: { accessToken: string; canManage: boolean }) {
  const [reference, setReference] = useState<CatalogReference | null>(null);
  const [items, setItems] = useState<Partial<Record<EditableCatalogCode, CatalogItem[]>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([getCatalogReference(accessToken),
      ...catalogs.map(({code}) => listCatalogItems(accessToken, code))])
      .then(([data, ...lists]) => {
        if (active) { setReference(data as CatalogReference); setItems(Object.fromEntries(
          catalogs.map(({code},index)=>[code, lists[index]])) as Record<EditableCatalogCode,CatalogItem[]>); }
      }).catch((failure) => { if (active) setError(message(failure)); });
    return () => { active = false; };
  }, [accessToken]);

  async function create(event: FormEvent<HTMLFormElement>, code: EditableCatalogCode) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get('name') || '').trim();
    setBusy(true); setError(null);
    try {
      await createCatalogItem(accessToken, code, name);
      const updated = await listCatalogItems(accessToken, code);
      setItems((previous) => ({ ...previous, [code]: updated }));
      form.reset();
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }

  async function change(code: EditableCatalogCode, id: string, active: boolean) {
    setBusy(true); setError(null);
    try {
      await setCatalogItemActive(accessToken, code, id, active);
      setItems((previous) => ({ ...previous, [code]: (previous[code]??[]).map((entry) =>
        entry.id === id ? { ...entry, active } : entry) }));
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }

  return <section className="section-block catalog-panel">
    <div className="section-heading"><div><span className="eyebrow">Núcleo ganadero</span><h2>Catálogos</h2>
      <p className="muted">Opciones del sistema y de tu cuenta, disponibles en todas tus propiedades.</p></div></div>
    {error && <div className="form-error admin-error" role="alert">{error}</div>}
    {!reference && !error && <p className="muted">Cargando catálogos…</p>}
    {reference && <>
      <p className="muted">Especies disponibles: {reference.species.map((species) => species.name).join(', ') || 'ninguna'}.
        Unidades de peso: {reference.units.filter((unit) => unit.contextCode === 'ANIMAL_WEIGHT')
          .map((unit) => unit.symbol).join(', ')}.</p>
      <div className="catalog-grid">{catalogs.map(({ code, name }) => <details className="team-block catalog-section" key={code}>
        <summary><strong>{name}</strong><small>{(items[code]??[]).length} opciones</small></summary>
        <div className="catalog-content">
          {canManage && reference.species.some((species) => species.code === 'BOVINE') &&
            <form className="catalog-create" onSubmit={(event) => void create(event, code)}>
              <label><span>Nueva opción</span><input name="name" minLength={2} maxLength={160}
                placeholder={`Ej. ${code === 'BREEDS' ? 'Charolais' : 'Colorado'}`} disabled={busy} required /></label>
              <button type="submit" className="primary-button compact" disabled={busy}>Agregar</button>
            </form>}
          {(items[code]??[]).length === 0 && <p className="muted">Aún no hay opciones registradas.</p>}
          {(items[code]??[]).map((entry) => <div className="property-module-row" key={entry.id}>
            <div><strong>{entry.name}</strong><small>{entry.systemDefined ? 'Del sistema'
              : entry.active ? 'Activa' : 'Inactiva · conserva su historial'}</small></div>
            {canManage && !entry.systemDefined && <label className="property-module-toggle">
              <input type="checkbox" checked={entry.active} disabled={busy}
                onChange={(event) => void change(code, entry.id, event.target.checked)}
                aria-label={`${entry.name}: opción activa`} /></label>}
          </div>)}
        </div>
      </details>)}</div>
    </>}
  </section>;
}

function message(error: unknown) {
  return error instanceof ApiRequestError ? error.message : 'No fue posible cargar o guardar el catálogo.';
}
