import { type FormEvent, useEffect, useState } from 'react';
import {
  ApiRequestError, createGroup, createLocation,listCatalogItems,
  listGroups, listLocations, setGroupState, updateGroup, updateLocation,
  type CatalogItem,type LivestockGroup, type PhysicalLocation, type LocationInput,
} from './api';

const label = (place: { kind: 'PASTURE' | 'CORRAL'; name: string }) =>
  `${place.kind === 'PASTURE' ? 'Potrero' : 'Corral'}: ${place.name}`;
const message = (error: unknown) => error instanceof ApiRequestError
  ? error.message : 'No fue posible completar la operación.';
function locationInput(data: FormData, kind: PhysicalLocation['kind'],catalog:CatalogItem[]): LocationInput {
  const optional = (key: string) => String(data.get(key) || '').trim() || null;
  const number = (key: string) => optional(key) === null ? null : Number(optional(key));
  const grasses = data.getAll('grassName').map(String).map((name, index) => ({
    name: name.trim(),catalogItemId:catalog.find(item=>item.name===name)?.id??null,
    percent: data.getAll('grassPercent')[index]
      ? Number(data.getAll('grassPercent')[index]) : null,
    area: data.getAll('grassArea')[index] ? Number(data.getAll('grassArea')[index]) : null,
    areaUnitCode: data.getAll('grassAreaUnit')[index]
      ? String(data.getAll('grassAreaUnit')[index]) : null,
    sowingDate: data.getAll('grassSowing')[index]
      ? String(data.getAll('grassSowing')[index]) : null,
    notes: data.getAll('grassNotes')[index]
      ? String(data.getAll('grassNotes')[index]) : null,
  })).filter((grass) => grass.name);
  return { name: String(data.get('name') || '').trim(), description: optional('description'), kind,
    area: number('area'), areaUnitCode: optional('areaUnitCode'),
    capacityEstimate: number('capacityEstimate'), waterAvailable: data.get('waterAvailable') === 'on',
    ...(kind === 'PASTURE' ? { pastureUse: optional('pastureUse'),
      lastRestDate: optional('lastRestDate'), grasses } : {
      floorMaterial: optional('floorMaterial'), covered: data.get('covered') === 'on' }),
  };
}
function LocationFields({ place,grassCatalog }: { place?: PhysicalLocation | undefined;
  grassCatalog:CatalogItem[] }) {
  const [grassCount, setGrassCount] = useState(place?.grasses.length ?? 0);
  const pasture = (place?.kind ?? 'PASTURE') === 'PASTURE';
  return <>
    <label><span>Área</span><input type="number" name="area" step="0.0001" min="0.0001"
      defaultValue={place?.area ?? ''} /></label>
    <label><span>Unidad de área</span><select name="areaUnitCode" defaultValue={place?.areaUnitCode ?? ''}>
      <option value="">Sin área</option><option value="HECTARE">ha</option>
      <option value="SQUARE_METER">m²</option>
    </select></label>
    <label><span>Capacidad estimada (animales)</span><input type="number" name="capacityEstimate"
      min="0" step="1" defaultValue={place?.capacityEstimate ?? ''} /></label>
    <label><span>Agua disponible</span><input type="checkbox" name="waterAvailable"
      defaultChecked={place?.waterAvailable ?? false} /></label>
    {pasture ? <>
      <label><span>Tipo de uso</span><select name="pastureUse" defaultValue={place?.pastureUse ?? ''}>
        <option value="">Sin especificar</option><option value="PASTOREO">Pastoreo</option>
        <option value="CORTE">Corte</option><option value="MIXTO">Mixto</option>
        <option value="DESCANSO">Descanso</option>
      </select></label>
      <label><span>Último descanso</span><input type="date" name="lastRestDate"
        defaultValue={place?.lastRestDate ?? ''} /></label>
      <fieldset className="animal-colors"><legend>Pastos</legend>
        {Array.from({ length: grassCount }, (_, index) => <div key={index} className="group-inline-form">
          <label><span>Pasto</span><select name="grassName"
            defaultValue={place?.grasses[index]?.name ?? ''}>
            <option value="">Selecciona</option>
            {place?.grasses[index]?.name&&!grassCatalog.some(item=>item.name===place.grasses[index]?.name)
              && <option value={place.grasses[index]?.name}>{place.grasses[index]?.name} (anterior)</option>}
            {grassCatalog.filter(item=>item.active).map(item=><option key={item.id}
              value={item.name}>{item.name}</option>)}
          </select></label>
          <label><span>% estimado</span><input type="number" name="grassPercent" min="0"
            max="100" step="0.01" defaultValue={place?.grasses[index]?.percent ?? ''} /></label>
          <label><span>Área estimada</span><input type="number" name="grassArea" min="0.0001"
            step="0.0001" defaultValue={place?.grasses[index]?.area ?? ''} /></label>
          <label><span>Unidad</span><select name="grassAreaUnit"
            defaultValue={place?.grasses[index]?.areaUnitCode ?? ''}>
            <option value="">Sin área</option><option value="HECTARE">ha</option>
            <option value="SQUARE_METER">m²</option>
          </select></label>
          <label><span>Siembra</span><input type="date" name="grassSowing"
            defaultValue={place?.grasses[index]?.sowingDate ?? ''} /></label>
          <label><span>Observaciones</span><input name="grassNotes" maxLength={300}
            defaultValue={place?.grasses[index]?.notes ?? ''} /></label>
        </div>)}
        <button type="button" className="secondary-button compact"
          onClick={() => setGrassCount((count) => Math.min(count + 1, 30))}>+ Pasto</button>
      </fieldset>
    </> : <>
      <label><span>Material del piso</span><input name="floorMaterial" maxLength={100}
        defaultValue={place?.floorMaterial ?? ''} /></label>
      <label><span>Cubierto</span><input type="checkbox" name="covered"
        defaultChecked={place?.covered ?? false} /></label>
    </>}
  </>;
}

export function GroupPanel({ accessToken, modules, canManage, canViewLocations,
  canManageLocations }: {
  accessToken: string; modules: string[]; canManage: boolean; canViewLocations: boolean;
  canManageLocations: boolean;
}) {
  const [groups, setGroups] = useState<LivestockGroup[] | null>(null);
  const [locations, setLocations] = useState<PhysicalLocation[]>([]);
  const [grassCatalog,setGrassCatalog]=useState<CatalogItem[]>([]);
  const [newLocationKind, setNewLocationKind] = useState<PhysicalLocation['kind']>('PASTURE');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const canPlace = ['PASTURES', 'CORRALS', 'MOVEMENTS'].every((code) => modules.includes(code));
  const availableKinds = (['PASTURE', 'CORRAL'] as const).filter((kind) =>
    modules.includes(kind === 'PASTURE' ? 'PASTURES' : 'CORRALS'));
  const locationKind = availableKinds.includes(newLocationKind)
    ? newLocationKind : availableKinds[0] ?? 'PASTURE';

  useEffect(() => {
    let active = true;
    void Promise.all([listGroups(accessToken), canViewLocations ? listLocations(accessToken) : Promise.resolve([])])
      .then(([nextGroups, nextLocations]) => {
        if (active) { setGroups(nextGroups); setLocations(nextLocations); }
      }).catch((failure) => { if (active) setError(message(failure)); });
    return () => { active = false; };
  }, [accessToken, canViewLocations, revision]);

  useEffect(()=>{let active=true;void listCatalogItems(accessToken,'GRASS_TYPES')
    .then(items=>{if(active)setGrassCatalog(items);}).catch(failure=>{if(active)setError(message(failure));});
    return()=>{active=false;};},[accessToken,revision]);

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
      });
      form.reset();
    });
  }

  function addLocation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void run(async () => {
      await createLocation(accessToken,
        locationInput(data, String(data.get('kind')) as PhysicalLocation['kind'],grassCatalog));
      form.reset();
    });
  }

  function editLocation(event: FormEvent<HTMLFormElement>, place: PhysicalLocation) {
    event.preventDefault();
    void run(() => updateLocation(accessToken, place.id, {
      ...locationInput(new FormData(event.currentTarget), place.kind,grassCatalog), expectedVersion: place.version,
    }));
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

  return <section className="section-block group-panel">
    <div className="section-heading"><div><span className="eyebrow">Núcleo ganadero</span>
      <h2>Grupos y ubicaciones</h2><p className="muted">Cada grupo, potrero y corral pertenece a la propiedad activa.</p>
    </div></div>
    {error && <div className="form-error admin-error" role="alert">{error}</div>}
    {canViewLocations && <div className="group-locations">
      <h3>Potreros y corrales</h3>
      {canManageLocations && availableKinds.length > 0 && <details className="group-create-toggle">
        <summary>+ Agregar potrero o corral</summary>
        <form className="group-new-form" onSubmit={addLocation}>
          <label><span>Tipo</span><select name="kind" disabled={busy} value={locationKind}
              onChange={(event) => setNewLocationKind(event.target.value as PhysicalLocation['kind'])}>
            {availableKinds.map((kind) => <option key={kind} value={kind}>
              {kind === 'PASTURE' ? 'Potrero' : 'Corral'}</option>)}</select></label>
          <label><span>Nombre *</span><input name="name" required maxLength={160} disabled={busy} /></label>
          <label className="group-description"><span>Descripción</span>
            <textarea name="description" rows={2} maxLength={5000} disabled={busy} /></label>
          <LocationFields key={locationKind} grassCatalog={grassCatalog} place={locationKind === 'CORRAL'
            ? { kind: 'CORRAL' } as PhysicalLocation : undefined} />
          <button className="secondary-button compact" type="submit" disabled={busy}>Agregar ubicación</button>
        </form></details>}
      {locations.length === 0 ? <p className="muted">Todavía no hay potreros ni corrales.</p>
        : <div className="group-location-list">{locations.map((place) =>
          <details key={place.id} className="group-location-item"><summary><strong>{label(place)}</strong>
            <small>{place.group ? `Grupo: ${place.group.name}` : 'Sin grupo'}
              {place.active ? '' : ' · Inactivo'}
              {place.area ? ` · ${place.area} ${place.areaUnitCode === 'HECTARE' ? 'ha' : 'm²'}` : ''}
              {place.capacityEstimate != null ? ` · Capacidad: ${place.capacityEstimate}` : ''}
              {place.kind === 'PASTURE' && place.pastureUse ? ` · ${place.pastureUse}` : ''}</small></summary>
            {place.description&&<p>{place.description}</p>}
            <small>Agua: {place.waterAvailable?'Sí':'No'}
              {place.kind==='CORRAL'?` · Cubierto: ${place.covered?'Sí':'No'}`:''}</small>
            {place.grasses.length > 0 && <small>Pastos: {place.grasses.map((grass) =>
              `${grass.name}${grass.percent != null ? ` (${grass.percent}%)` : ''}`).join(', ')}</small>}
            {canManageLocations && <details className="group-edit-toggle"><summary>Editar potrero o corral</summary>
            <form className="group-new-form"
              key={`${place.id}:${place.version}`} onSubmit={(event) => editLocation(event, place)}>
              <label><span>Nombre</span><input name="name" required defaultValue={place.name} /></label>
              <label><span>Descripción</span><textarea name="description"
                defaultValue={place.description ?? ''} /></label>
              <LocationFields place={place} grassCatalog={grassCatalog} />
              <button className="secondary-button compact" disabled={busy}>Guardar ubicación</button>
            </form></details>}</details>)}</div>}
    </div>}
    {canManage && <details className="group-create-toggle"><summary>+ Crear grupo</summary>
      <form className="group-new-form" onSubmit={addGroup}>
      <h3>Nuevo grupo</h3>
      <label><span>Nombre *</span><input name="name" required maxLength={160} disabled={busy}
        placeholder="Ej. Paridas" /></label>
      <label className="group-description"><span>Descripción</span>
        <textarea name="description" rows={2} maxLength={5000} disabled={busy} /></label>
      {canPlace && <small>La primera ubicación se asigna desde Movimientos.</small>}
      <button className="primary-button compact" type="submit" disabled={busy}>Crear grupo</button>
    </form></details>}
    {canPlace && <p className="muted">Las rotaciones y los cambios de potrero o corral se registran en Movimientos.</p>}
    <h3>Grupos de esta propiedad</h3>
    {groups === null ? <p className="muted">Cargando grupos…</p>
      : groups.length === 0 ? <p className="muted">Todavía no hay grupos.</p>
        : <div className="group-card-list">{groups.map((entry) =>
          <details className="group-card" key={entry.id}><summary>
            <div className="group-card-heading"><div><h4>{entry.name}{entry.active ? '' : ' · Archivado'}</h4>
              <small>{entry.animalCount} {entry.animalCount === 1 ? 'animal' : 'animales'} · {entry.location
                ? label(entry.location) : 'Sin ubicación'}</small></div></div></summary>
            <p className="muted">{entry.description || 'Sin descripción'}</p>
            {canManage && <button type="button" className="secondary-button compact" disabled={busy}
                onClick={() => void run(() => setGroupState(accessToken, entry.id, {
                  active: !entry.active, expectedVersion: entry.version,
                }))}>{entry.active ? 'Archivar' : 'Reactivar'}</button>}
            {entry.active && canManage && <details className="group-edit-toggle"><summary>Editar grupo</summary>
            <form className="group-inline-form" key={`edit:${entry.version}`}
              onSubmit={(event) => editGroup(event, entry)}>
              <label><span>Nombre</span><input name="name" defaultValue={entry.name}
                required maxLength={160} disabled={busy} /></label>
              <label><span>Descripción</span><textarea name="description" rows={2}
                defaultValue={entry.description || ''} maxLength={5000} disabled={busy} /></label>
              <button className="secondary-button compact" type="submit" disabled={busy}>Guardar grupo</button>
            </form></details>}
          </details>)}</div>}
  </section>;
}
