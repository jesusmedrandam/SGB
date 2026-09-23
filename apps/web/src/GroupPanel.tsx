import { type FormEvent, useEffect, useState } from 'react';
import {
  ApiRequestError, assignAnimalToGroup, createGroup, createLocation, getAnimals,
  listGroups, listLocations, setGroupLocation, setGroupState, updateGroup,
  type Animal, type LivestockGroup, type PhysicalLocation,
} from './api';

const label = (place: { kind: 'PASTURE' | 'CORRAL'; name: string }) =>
  `${place.kind === 'PASTURE' ? 'Potrero' : 'Corral'}: ${place.name}`;
const message = (error: unknown) => error instanceof ApiRequestError
  ? error.message : 'No fue posible completar la operación.';

export function GroupPanel({ accessToken, modules, canManage, canViewLocations,
  canManageLocations, canAssignAnimals }: {
  accessToken: string; modules: string[]; canManage: boolean; canViewLocations: boolean;
  canManageLocations: boolean; canAssignAnimals: boolean;
}) {
  const [groups, setGroups] = useState<LivestockGroup[] | null>(null);
  const [locations, setLocations] = useState<PhysicalLocation[]>([]);
  const [animals, setAnimals] = useState<Animal[]>([]);
  const [animalSearch, setAnimalSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const canPlace = ['PASTURES', 'CORRALS', 'MOVEMENTS'].every((code) => modules.includes(code));
  const availableKinds = (['PASTURE', 'CORRAL'] as const).filter((kind) =>
    modules.includes(kind === 'PASTURE' ? 'PASTURES' : 'CORRALS'));

  useEffect(() => {
    let active = true;
    void Promise.all([listGroups(accessToken), canViewLocations ? listLocations(accessToken) : Promise.resolve([])])
      .then(([nextGroups, nextLocations]) => {
        if (active) { setGroups(nextGroups); setLocations(nextLocations); }
      }).catch((failure) => { if (active) setError(message(failure)); });
    return () => { active = false; };
  }, [accessToken, canViewLocations, revision]);

  useEffect(() => {
    if (!canAssignAnimals) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void getAnimals(accessToken, 1, animalSearch.trim()).then((page) => {
        if (active) setAnimals(page.items);
      }).catch((failure) => { if (active) setError(message(failure)); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [accessToken, canAssignAnimals, animalSearch, revision]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await action(); setRevision((value) => value + 1); }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }

  function addGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void run(async () => {
      await createGroup(accessToken, {
        name: String(data.get('name')).trim(),
        description: String(data.get('description') || '').trim() || null,
        locationId: String(data.get('locationId') || '') || null,
      });
      form.reset();
    });
  }

  function addLocation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void run(async () => {
      await createLocation(accessToken, {
        name: String(data.get('name')).trim(),
        description: String(data.get('description') || '').trim() || null,
        kind: String(data.get('kind')) as PhysicalLocation['kind'],
      });
      form.reset();
    });
  }

  function editGroup(event: FormEvent<HTMLFormElement>, entry: LivestockGroup) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run(() => updateGroup(accessToken, entry.id, {
      name: String(data.get('name')).trim(),
      description: String(data.get('description') || '').trim() || null,
      expectedVersion: entry.version,
    }));
  }

  function moveGroup(event: FormEvent<HTMLFormElement>, entry: LivestockGroup) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run(() => setGroupLocation(accessToken, entry.id, {
      locationId: String(data.get('locationId') || '') || null,
      expectedVersion: entry.version,
    }));
  }

  function assignAnimal(event: FormEvent<HTMLFormElement>, entry: LivestockGroup) {
    event.preventDefault();
    const animalId = String(new FormData(event.currentTarget).get('animalId') || '');
    const animal = animals.find((item) => item.id === animalId);
    if (!animal) return;
    void run(() => assignAnimalToGroup(accessToken, entry.id, {
      animalId, expectedAnimalVersion: animal.version,
    }));
  }

  return <section className="section-block group-panel">
    <div className="section-heading"><div><span className="eyebrow">Núcleo ganadero</span>
      <h2>Grupos y ubicaciones</h2><p className="muted">Cada grupo, potrero y corral pertenece a la propiedad activa.</p>
    </div></div>
    {error && <div className="form-error admin-error" role="alert">{error}</div>}
    {canViewLocations && <div className="group-locations">
      <h3>Potreros y corrales</h3>
      {canManageLocations && availableKinds.length > 0 &&
        <form className="group-new-form" onSubmit={addLocation}>
          <label><span>Tipo</span><select name="kind" disabled={busy}>
            {availableKinds.map((kind) => <option key={kind} value={kind}>
              {kind === 'PASTURE' ? 'Potrero' : 'Corral'}</option>)}</select></label>
          <label><span>Nombre *</span><input name="name" required maxLength={160} disabled={busy} /></label>
          <label className="group-description"><span>Descripción</span>
            <textarea name="description" rows={2} maxLength={5000} disabled={busy} /></label>
          <button className="secondary-button compact" type="submit" disabled={busy}>Agregar ubicación</button>
        </form>}
      {locations.length === 0 ? <p className="muted">Todavía no hay potreros ni corrales.</p>
        : <div className="group-location-list">{locations.map((place) =>
          <div key={place.id} className="group-location-item"><strong>{label(place)}</strong>
            <small>{place.group ? `Grupo: ${place.group.name}` : 'Sin grupo'}
              {place.active ? '' : ' · Inactivo'}</small></div>)}</div>}
    </div>}
    {canManage && <form className="group-new-form" onSubmit={addGroup}>
      <h3>Nuevo grupo</h3>
      <label><span>Nombre *</span><input name="name" required maxLength={160} disabled={busy}
        placeholder="Ej. Paridas" /></label>
      <label className="group-description"><span>Descripción</span>
        <textarea name="description" rows={2} maxLength={5000} disabled={busy} /></label>
      {canPlace && canManageLocations && canViewLocations && <label><span>Ubicación inicial</span>
        <select name="locationId" disabled={busy} defaultValue="">
          <option value="">Sin ubicación</option>
          {locations.filter((place) => place.active && !place.group)
            .map((place) => <option key={place.id} value={place.id}>{label(place)}</option>)}
        </select></label>}
      <button className="primary-button compact" type="submit" disabled={busy}>Crear grupo</button>
    </form>}
    {!canPlace && <p className="muted">Para ubicar grupos se necesitan activos los módulos Potreros,
      Corrales y Movimientos en la cuenta y la propiedad.</p>}
    {canAssignAnimals && <label className="group-animal-search"><span>Buscar animal para asignarlo</span>
      <input value={animalSearch} onChange={(event) => setAnimalSearch(event.target.value)}
        maxLength={80} placeholder="Nombre o arete" /></label>}
    <h3>Grupos de esta propiedad</h3>
    {groups === null ? <p className="muted">Cargando grupos…</p>
      : groups.length === 0 ? <p className="muted">Todavía no hay grupos.</p>
        : <div className="group-card-list">{groups.map((entry) =>
          <article className="group-card" key={entry.id}>
            <div className="group-card-heading"><div><h4>{entry.name}{entry.active ? '' : ' · Archivado'}</h4>
              <p className="muted">{entry.description || 'Sin descripción'}</p>
              <small>{entry.animalCount} {entry.animalCount === 1 ? 'animal' : 'animales'} · {entry.location
                ? label(entry.location) : 'Sin ubicación'}</small></div>
              {canManage && <button type="button" className="secondary-button compact" disabled={busy}
                onClick={() => void run(() => setGroupState(accessToken, entry.id, {
                  active: !entry.active, expectedVersion: entry.version,
                }))}>{entry.active ? 'Archivar' : 'Reactivar'}</button>}
            </div>
            {entry.active && canManage && <form className="group-inline-form" key={`edit:${entry.version}`}
              onSubmit={(event) => editGroup(event, entry)}>
              <label><span>Nombre</span><input name="name" defaultValue={entry.name}
                required maxLength={160} disabled={busy} /></label>
              <label><span>Descripción</span><textarea name="description" rows={2}
                defaultValue={entry.description || ''} maxLength={5000} disabled={busy} /></label>
              <button className="secondary-button compact" type="submit" disabled={busy}>Guardar grupo</button>
            </form>}
            {entry.active && canManage && canManageLocations && canViewLocations
              && (canPlace || entry.location) && <form className="group-inline-form"
                key={`place:${entry.version}`} onSubmit={(event) => moveGroup(event, entry)}>
                <label><span>Ubicación del grupo</span><select name="locationId"
                  defaultValue={entry.location?.id || ''} disabled={busy}>
                  <option value="">Sin ubicación</option>
                  {canPlace && locations.filter((place) => place.active
                    && (!place.group || place.group.id === entry.id)).map((place) =>
                    <option key={place.id} value={place.id}>{label(place)}</option>)}
                  {!canPlace && entry.location && <option value={entry.location.id}>
                    {label(entry.location)}</option>}
                </select></label>
                <button className="secondary-button compact" type="submit" disabled={busy}>
                  Guardar ubicación</button>
              </form>}
            {entry.active && canAssignAnimals && <form className="group-inline-form"
              onSubmit={(event) => assignAnimal(event, entry)}>
              <label><span>Asignar animal</span><select name="animalId" required defaultValue=""
                disabled={busy || (entry.location !== null && !canPlace)}>
                <option value="" disabled>Selecciona un animal</option>
                {animals.map((animal) => <option key={animal.id} value={animal.id}>
                  {animal.name}{animal.earTagCode ? ` · ${animal.earTagCode}` : ''}</option>)}
              </select></label>
              <button className="secondary-button compact" type="submit" disabled={busy
                || (entry.location !== null && !canPlace)}>Asignar</button>
            </form>}
          </article>)}</div>}
  </section>;
}
