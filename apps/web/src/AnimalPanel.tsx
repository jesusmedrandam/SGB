import { type FormEvent, useEffect, useState } from 'react';
import {
  ApiRequestError, createAnimal, createBrand, getAnimal, getAnimals, listBrands,
  listCatalogItems, setBrandActive, updateAnimalBrands, updateAnimalCatalogs,
  listOwners, listAccountUsers, createOwner, updateBrandOwners, updateAnimalOwners,
  updateAnimalDescription, updateAnimalParents,
  type Animal, type AnimalList, type CatalogItem, type LivestockBrand, type LivestockOwner, type ParentSelection,
} from './api';

interface AnimalChoices { BREEDS: CatalogItem[]; COLORS: CatalogItem[] }

async function loadAnimalChoices(accessToken: string): Promise<AnimalChoices> {
  const [breeds, colors] = await Promise.all([
    listCatalogItems(accessToken, 'BREEDS'), listCatalogItems(accessToken, 'COLORS'),
  ]);
  return { BREEDS: breeds, COLORS: colors };
}

function CatalogFields({ choices, selected }: { choices: AnimalChoices; selected?: Animal | null }) {
  const breeds = selected?.breeds || (selected?.breed ? [selected.breed] : []);
  const colors = selected?.colors || [];
  const availableBreed = choices.BREEDS.filter((entry) => entry.active &&
    (!entry.speciesCode || entry.speciesCode === 'BOVINE'));
  const availableColors = choices.COLORS.filter((entry) => entry.active &&
    (!entry.speciesCode || entry.speciesCode === 'BOVINE'));
  for (const breed of breeds) {
    if (!availableBreed.some((entry) => entry.id === breed.id))
      availableBreed.push({ id: breed.id, name: breed.name, catalogCode: 'BREEDS',
        speciesCode: 'BOVINE', systemDefined: false, active: false });
  }
  for (const color of colors) {
    if (!availableColors.some((entry) => entry.id === color.id)) {
      availableColors.push({ id: color.id, name: color.name, catalogCode: 'COLORS',
        speciesCode: 'BOVINE', systemDefined: false, active: false });
    }
  }
  return <>
    <fieldset className="animal-colors"><legend>Razas</legend>
      {availableBreed.map((entry) => <label key={entry.id}>
        <input type="checkbox" name="breedIds" value={entry.id}
          defaultChecked={breeds.some((breed) => breed.id === entry.id)} />
        <span>{entry.name}{entry.active ? '' : ' (inactiva)'}</span>
      </label>)}
    </fieldset>
    <fieldset className="animal-colors"><legend>Colores</legend>
      {availableColors.length === 0 && <small>No hay colores disponibles en esta finca.</small>}
      {availableColors.map((entry) => <label key={entry.id}>
        <input type="checkbox" name="colorIds" value={entry.id}
          defaultChecked={colors.some((color) => color.id === entry.id)} />
        <span>{entry.name}{entry.active ? '' : ' (inactivo)'}</span>
      </label>)}
    </fieldset>
  </>;
}

function OwnerFields({ owners, selected }: { owners: LivestockOwner[]; selected?: Animal | null }) {
  const available = owners.filter((owner) => owner.active || selected?.owners?.some((entry) => entry.id === owner.id));
  return <fieldset className="animal-colors"><legend>Propietarios (total 100%)</legend>
    {available.map((owner) => <div key={owner.id} className="group-inline-form">
      <label><input type="checkbox" name="ownerIds" value={owner.id}
        defaultChecked={selected?.owners?.some((entry) => entry.id === owner.id)} /> {owner.name}</label>
      <label><span>Porcentaje</span><input type="number" name={`percent:${owner.id}`}
        min="0.01" max="100" step="0.01"
        defaultValue={selected?.owners?.find((entry) => entry.id === owner.id)?.percent ?? ''} /></label>
      <label><input type="radio" name="primary" value={owner.id}
        defaultChecked={selected?.owners?.find((entry) => entry.id === owner.id)?.isPrimary} /> Principal</label>
    </div>)}
    <small>Selecciona al menos uno; indica porcentajes que sumen 100% y uno principal.</small>
  </fieldset>;
}
function ownerInput(data: FormData) {
  const ids = data.getAll('ownerIds').map(String);
  if (!ids.length) throw new Error('Selecciona al menos un propietario.');
  const owners = ids.map((partyId) => ({ partyId,
    percent: Number(data.get(`percent:${partyId}`)), isPrimary: data.get('primary') === partyId }));
  if (owners.filter((owner) => owner.isPrimary).length !== 1 ||
    Math.abs(owners.reduce((sum, owner) => sum + owner.percent, 0) - 100) > 0.001)
    throw new Error('Indica un propietario principal y porcentajes que sumen 100%.');
  return owners;
}

function BrandFields({ brands, selected }: { brands: LivestockBrand[]; selected?: Animal | null }) {
  const chosen = selected?.brands ?? [];
  const available = brands.filter((brand) => brand.active || chosen.some((entry) => entry.id === brand.id));
  return <fieldset className="animal-colors"><legend>Marquillas de la cuenta</legend>
    {available.length === 0 && <small>Registra primero una marquilla en la sección Marquillas.</small>}
    {available.map((brand) => <label key={brand.id}>
      <input type="checkbox" name="brandIds" value={brand.id}
        defaultChecked={chosen.some((entry) => entry.id === brand.id)} />
      <span>{brand.name}{brand.active ? '' : ' (inactiva)'}</span>
    </label>)}
  </fieldset>;
}

function ParentField({ accessToken, child, role }: {
  accessToken: string; child: Animal; role: 'mother' | 'father';
}) {
  const current = child[role];
  const [mode, setMode] = useState<'none' | 'animal' | 'reported'>(
    current ? current.animalId ? 'animal' : 'reported' : 'none',
  );
  const [search, setSearch] = useState('');
  const [candidates, setCandidates] = useState<Animal[]>([]);
  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    if (mode !== 'animal') return;
    let active = true;
    const timer = window.setTimeout(() => {
      void getAnimals(accessToken, 1, search).then((page) => {
        if (active) { setCandidates(page.items); setLoadError(false); }
      }).catch(() => { if (active) setLoadError(true); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [accessToken, mode, search]);
  const label = role === 'mother' ? 'Madre' : 'Padre';
  const eligible = candidates.filter((entry) => entry.id !== child.id
    && entry.sex === (role === 'mother' ? 'FEMALE' : 'MALE')
    && (!child.birthDate || !entry.birthDate || entry.birthDate < child.birthDate));
  return <fieldset className="animal-parent-field"><legend>{label}</legend>
    <label><span>Tipo de registro</span><select name={`${role}Mode`} value={mode}
      onChange={(event) => setMode(event.target.value as typeof mode)}>
      <option value="none">Sin registrar</option>
      <option value="animal">Animal registrado en esta propiedad</option>
      <option value="reported">Nombre informado (externo)</option>
    </select></label>
    {mode === 'animal' && <>
      <label><span>Buscar {label.toLowerCase()}</span><input value={search}
        onChange={(event) => setSearch(event.target.value)} maxLength={80} /></label>
      <label><span>Animal</span><select name={`${role}AnimalId`} defaultValue={current?.animalId || ''} required>
        <option value="">Selecciona un animal</option>
        {current?.animalId && !eligible.some((entry) => entry.id === current.animalId)
          && <option value={current.animalId}>{current.name} (actual)</option>}
        {eligible.map((entry) => <option key={entry.id} value={entry.id}>
          {entry.name}{entry.earTagCode ? ` · ${entry.earTagCode}` : ''}
        </option>)}
      </select></label>
      {loadError && <small>No se pudieron cargar los animales; intenta buscar de nuevo.</small>}
    </>}
    {mode === 'reported' && <label><span>Nombre informado</span>
      <input name={`${role}ReportedName`} defaultValue={current?.animalId === null ? current.name : ''}
        minLength={1} maxLength={160} required /></label>}
  </fieldset>;
}

export function AnimalPanel({ accessToken, canCreate, canUpdate, canViewCatalogs, canManageBrands }: {
  accessToken: string; canCreate: boolean; canUpdate: boolean;
  canViewCatalogs: boolean; canManageBrands: boolean;
}) {
  const [result, setResult] = useState<AnimalList | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<Animal | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<AnimalChoices | null>(null);
  const [brands, setBrands] = useState<LivestockBrand[] | null>(null);
  const [owners, setOwners] = useState<LivestockOwner[]>([]);
  const [accountUsers, setAccountUsers] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    let active = true;
    void getAnimals(accessToken, page, search).then((list) => {
      if (active) { setResult(list); setError(null); }
    }).catch((failure) => { if (active) setError(message(failure)); });
    return () => { active = false; };
  }, [accessToken, page, search, revision]);

  useEffect(() => {
    if (!canViewCatalogs) return;
    let active = true;
    void loadAnimalChoices(accessToken)
      .then((value) => { if (active) setChoices(value); })
      .catch(() => { if (active) setChoices(null); });
    return () => { active = false; };
  }, [accessToken, canViewCatalogs]);

  useEffect(() => {
    let active = true;
    void listOwners(accessToken).then((value) => { if (active) setOwners(value); })
      .catch((failure) => { if (active) setError(message(failure)); });
    if (canManageBrands) void listAccountUsers(accessToken).then((value) => {
      if (active) setAccountUsers(value);
    }).catch((failure) => { if (active) setError(message(failure)); });
    void listBrands(accessToken).then((value) => { if (active) setBrands(value); })
      .catch((failure) => { if (active) setError(message(failure)); });
    return () => { active = false; };
  }, [accessToken]);

  function find(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1); setSearch(searchInput.trim()); setSelected(null);
  }

  async function open(id: string) {
    setBusy(true); setError(null);
    try {
      setSelected(await getAnimal(accessToken, id));
      void listBrands(accessToken).then(setBrands).catch((failure) => setError(message(failure)));
      if (canViewCatalogs) void loadAnimalChoices(accessToken).then(setChoices).catch(() => setChoices(null));
    }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const optional = (key: string) => String(data.get(key) || '').trim() || undefined;
    const weight = optional('initialWeight');
    const earTagCode = optional('earTagCode');
    const birthDate = optional('birthDate');
    const entryDate = optional('entryDate');
    const breedIds = data.getAll('breedIds').map(String);
    const colorIds = data.getAll('colorIds').map(String);
    const brandIds = data.getAll('brandIds').map(String);
    let animalOwners: ReturnType<typeof ownerInput>;
    try { animalOwners = ownerInput(data); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Propietarios inválidos.'); return; }
    setBusy(true); setError(null);
    try {
      const created = await createAnimal(accessToken, {
        name: String(data.get('name') || '').trim(),
        description: String(data.get('description') || '').trim() || null,
        sex: String(data.get('sex')) as Animal['sex'],
        speciesCode: 'BOVINE',
        ...(earTagCode ? { earTagCode } : {}),
        ...(birthDate ? { birthDate } : {}),
        ...(entryDate ? { entryDate } : {}),
        ...(weight ? { initialWeight: Number(weight), initialWeightUnitCode: String(data.get('weightUnit')) } : {}),
        ...(choices ? { breedIds, colorIds } : {}),
        brandIds, owners: animalOwners,
      });
      setSelected(created); setShowCreate(false); setSearchInput(''); setSearch(''); setPage(1);
      setRevision((value) => value + 1);
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }

  async function changeCatalogs(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const data = new FormData(event.currentTarget);
    setBusy(true); setError(null);
    try {
      setSelected(await updateAnimalCatalogs(accessToken, selected.id, {
        breedIds: data.getAll('breedIds').map(String),
        colorIds: data.getAll('colorIds').map(String),
        expectedVersion: selected.version,
      }));
    } catch (failure) {
      setError(message(failure));
      if (failure instanceof ApiRequestError && failure.code === 'ANIMAL_VERSION_CONFLICT') {
        try { setSelected(await getAnimal(accessToken, selected.id)); } catch { /* conserva el error original */ }
      }
    } finally { setBusy(false); }
  }

  async function addOwner(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const kind = String(data.get('kind'));
    setBusy(true); setError(null);
    try {
      await createOwner(accessToken, kind === 'USER'
        ? { kind: 'USER', userId: String(data.get('userId')) }
        : { kind: kind as 'EXTERNAL_PERSON' | 'ORGANIZATION', name: String(data.get('name')).trim() });
      setOwners(await listOwners(accessToken)); form.reset();
    } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  }
  async function changeBrandOwners(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      await updateBrandOwners(accessToken, id, new FormData(event.currentTarget).getAll('ownerIds').map(String));
      setBrands(await listBrands(accessToken));
    } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  }
  async function changeOwners(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return;
    const data = new FormData(event.currentTarget);
    let ownersInput: ReturnType<typeof ownerInput>;
    try { ownersInput = ownerInput(data); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Propietarios inválidos.'); return; }
    setBusy(true); setError(null);
    try { setSelected(await updateAnimalOwners(accessToken, selected.id,
      { owners: ownersInput, expectedVersion: selected.version })); }
    catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  }
  async function addBrand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get('name') || '').trim();
    const ownerIds = data.getAll('ownerIds').map(String);
    if (!ownerIds.length) { setError('Selecciona al menos un propietario para la marquilla.'); return; }
    setBusy(true); setError(null);
    try {
      await createBrand(accessToken, name, ownerIds);
      setBrands(await listBrands(accessToken));
      form.reset();
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }

  async function changeBrandState(brand: LivestockBrand) {
    setBusy(true); setError(null);
    try {
      await setBrandActive(accessToken, brand.id, !brand.active);
      setBrands(await listBrands(accessToken));
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }

  async function changeBrands(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const brandIds = new FormData(event.currentTarget).getAll('brandIds').map(String);
    setBusy(true); setError(null);
    try {
      setSelected(await updateAnimalBrands(accessToken, selected.id,
        { brandIds, expectedVersion: selected.version }));
      setRevision((value) => value + 1);
    } catch (failure) {
      setError(message(failure));
      if (failure instanceof ApiRequestError && failure.code === 'ANIMAL_VERSION_CONFLICT') {
        try { setSelected(await getAnimal(accessToken, selected.id)); } catch { /* conserva el error original */ }
      }
    } finally { setBusy(false); }
  }

  async function changeParents(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const data = new FormData(event.currentTarget);
    const parent = (role: 'mother' | 'father'): ParentSelection => {
      const mode = data.get(`${role}Mode`);
      if (mode === 'animal') return { animalId: String(data.get(`${role}AnimalId`)) };
      if (mode === 'reported') return { reportedName: String(data.get(`${role}ReportedName`)).trim() };
      return null;
    };
    setBusy(true); setError(null);
    try {
      setSelected(await updateAnimalParents(accessToken, selected.id,
        { mother: parent('mother'), father: parent('father'), expectedVersion: selected.version }));
    } catch (failure) {
      setError(message(failure));
      if (failure instanceof ApiRequestError && failure.code === 'ANIMAL_VERSION_CONFLICT') {
        try { setSelected(await getAnimal(accessToken, selected.id)); } catch { /* conserva el error original */ }
      }
    } finally { setBusy(false); }
  }

  async function changeDescription(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const description = String(new FormData(event.currentTarget).get('description') || '').trim() || null;
    setBusy(true); setError(null);
    try {
      setSelected(await updateAnimalDescription(accessToken, selected.id,
        { description, expectedVersion: selected.version }));
    } catch (failure) {
      setError(message(failure));
      if (failure instanceof ApiRequestError && failure.code === 'ANIMAL_VERSION_CONFLICT') {
        try { setSelected(await getAnimal(accessToken, selected.id)); } catch { /* conserva el error original */ }
      }
    } finally { setBusy(false); }
  }

  return <section className="section-block animal-panel">
    <div className="section-heading"><div><span className="eyebrow">Núcleo ganadero</span><h2>Animales</h2>
      <p className="muted">Registros de la propiedad activa.</p></div>
      {canCreate && <button className="primary-button compact" type="button" disabled={busy}
        onClick={() => {
          setShowCreate((value) => !value);
          if (canViewCatalogs) void loadAnimalChoices(accessToken).then(setChoices).catch(() => setChoices(null));
        }}>{showCreate ? 'Cerrar' : '+ Animal'}</button>}
    </div>
    {error && <div className="form-error admin-error" role="alert">{error}</div>}
    <div className="animal-brand-manager">
      <h3>Propietarios de la cuenta</h3>
      {canManageBrands && <>
        <form className="catalog-create" onSubmit={(event) => void addOwner(event)}>
          <label><span>Tipo</span><select name="kind" defaultValue="EXTERNAL_PERSON">
            <option value="EXTERNAL_PERSON">Persona externa</option>
            <option value="ORGANIZATION">Organización</option>
          </select></label>
          <label><span>Nombre</span><input name="name" required maxLength={160} /></label>
          <button className="secondary-button compact" disabled={busy}>Agregar propietario</button>
        </form>
        {accountUsers.length > 0 && <form className="catalog-create"
          onSubmit={(event) => void addOwner(event)}>
          <input type="hidden" name="kind" value="USER" />
          <label><span>Usuario de la cuenta</span><select name="userId">
            {accountUsers.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
          </select></label>
          <button className="secondary-button compact" disabled={busy}>Agregar usuario propietario</button>
        </form>}
      </>}
      <p className="muted">{owners.filter((owner) => owner.active).map((owner) => owner.name).join(', ')
        || 'Sin propietarios registrados.'}</p>
    </div>
    <div className="animal-brand-manager">
      <h3>Marquillas</h3>
      <p className="muted">Regístralas aquí y después elígelas en los animales. El arete individual se registra aparte.</p>
      {canManageBrands && <form className="catalog-create" onSubmit={(event) => void addBrand(event)}>
        <label><span>Nombre o código de la marquilla</span>
          <input name="name" required maxLength={160} disabled={busy} placeholder="Ej. M7L" /></label>
        {owners.filter((owner) => owner.active).map((owner) => <label key={owner.id}>
          <input type="checkbox" name="ownerIds" value={owner.id} /> {owner.name}
        </label>)}
        <button className="secondary-button compact" type="submit" disabled={busy || !owners.length}>
          Agregar marquilla</button>
      </form>}
      {brands === null ? <p className="muted">Cargando marquillas…</p>
        : brands.length === 0 ? <p className="muted">Todavía no hay marquillas registradas.</p>
          : <div className="animal-brand-list">{brands.map((brand) =>
            <div key={brand.id} className="animal-brand-row"><span>{brand.name}{brand.active ? '' : ' · Inactiva'}</span>
              {canManageBrands && <form className="animal-colors" onSubmit={(event) => void changeBrandOwners(event, brand.id)}>
                <strong>Propietarios de esta marquilla</strong>
                {owners.filter((owner) => owner.active).map((owner) => <label key={owner.id}>
                  <input type="checkbox" name="ownerIds" value={owner.id}
                    defaultChecked={brand.owner_ids?.includes(owner.id)} /> {owner.name}
                </label>)}
                <button className="secondary-button compact" disabled={busy}>Guardar propietarios</button>
              </form>}
              {canManageBrands && <button className="secondary-button compact" type="button"
                disabled={busy} onClick={() => void changeBrandState(brand)}>
                {brand.active ? 'Desactivar' : 'Activar'}</button>}</div>)}</div>}
    </div>
    {showCreate && <form className="animal-create" onSubmit={(event) => void create(event)}>
      <label><span>Nombre *</span><input name="name" maxLength={160} required disabled={busy} /></label>
      <label className="animal-full-width"><span>Descripción</span>
        <textarea name="description" maxLength={5000} rows={3} disabled={busy} /></label>
      <label><span>Sexo *</span><select name="sex" required disabled={busy} defaultValue="">
        <option value="" disabled>Selecciona</option><option value="FEMALE">Hembra</option>
        <option value="MALE">Macho</option></select></label>
      <label><span>Arete individual</span><input name="earTagCode" maxLength={80} disabled={busy} /></label>
      <label><span>Fecha de nacimiento</span><input type="date" name="birthDate" disabled={busy} /></label>
      <label><span>Fecha de ingreso</span><input type="date" name="entryDate" disabled={busy} />
        <small>Si queda vacía, se usa la fecha actual de la finca.</small></label>
      <label><span>Peso inicial</span><input type="number" name="initialWeight" min="0.001"
        max="999999999" step="0.001" disabled={busy} /></label>
      <label><span>Unidad de peso</span><select name="weightUnit" disabled={busy} defaultValue="KILOGRAM">
        <option value="KILOGRAM">kg</option><option value="POUND">lb</option>
</select></label>
      {choices && <CatalogFields choices={choices} />}
      <OwnerFields owners={owners} />
      {brands && <BrandFields brands={brands} />}
      <button className="primary-button compact" type="submit" disabled={busy || brands === null}>
        {busy ? 'Guardando…' : 'Registrar animal'}</button>
    </form>}
    <form className="animal-search" onSubmit={find} role="search">
      <label><span>Buscar por nombre, arete o marquilla</span><input value={searchInput} maxLength={80}
        onChange={(event) => setSearchInput(event.target.value)} /></label>
      <button className="secondary-button compact" type="submit">Buscar</button>
    </form>
    {!result && !error && <p className="muted">Cargando animales…</p>}
    {result && <>
      {result.items.length === 0 && <p className="muted">No hay animales con ese criterio en esta propiedad.</p>}
      <div className="animal-list">{result.items.map((entry) => <button type="button" key={entry.id}
        className="animal-row" onClick={() => void open(entry.id)} disabled={busy}>
        <span><strong>{entry.name}</strong><small>{[entry.earTagCode && `Arete: ${entry.earTagCode}`,
          entry.brands.length && `Marquillas: ${entry.brands.map((brand) => brand.name).join(', ')}`]
          .filter(Boolean).join(' · ') || 'Sin identificación registrada'}</small></span>
        <span>{entry.sex === 'FEMALE' ? 'Hembra' : 'Macho'}</span>
      </button>)}</div>
      {(page > 1 || result.hasMore) && <div className="animal-pages">
        <button className="secondary-button compact" type="button" disabled={page === 1}
          onClick={() => { setPage(page - 1); setSelected(null); }}>Anterior</button>
        <span>Página {page}</span>
        <button className="secondary-button compact" type="button" disabled={!result.hasMore}
          onClick={() => { setPage(page + 1); setSelected(null); }}>Siguiente</button>
      </div>}
    </>}
    {selected && <div className="animal-detail"><h3>{selected.name}</h3>
      <p className="animal-description">{selected.description || 'Sin descripción.'}</p>
      <dl><div><dt>Arete individual</dt><dd>{selected.earTagCode || 'No registrado'}</dd></div>
        <div><dt>Grupo</dt><dd>{selected.group?.name || 'Sin grupo'}</dd></div>
        <div><dt>Ubicación</dt><dd>{selected.location
          ? `${selected.location.kind === 'PASTURE' ? 'Potrero' : 'Corral'}: ${selected.location.name}`
          : 'Sin ubicación'}</dd></div>
        <div><dt>Propietarios</dt><dd>{selected.owners?.map((owner) => `${owner.name} (${owner.percent}%)`).join(', ') || 'No registrados'}</dd></div>
        <div><dt>Marquillas</dt><dd>{selected.brands.map((brand) => brand.name).join(', ') || 'No registradas'}</dd></div>
        <div><dt>Sexo</dt><dd>{selected.sex === 'FEMALE' ? 'Hembra' : 'Macho'}</dd></div>
        <div><dt>Nacimiento</dt><dd>{selected.birthDate || 'No registrado'}</dd></div>
        <div><dt>Ingreso</dt><dd>{selected.entryDate}</dd></div>
        <div><dt>Peso inicial</dt><dd>{selected.initialWeight === null ? 'No registrado'
          : `${selected.initialWeight} ${selected.initialWeightUnitCode === 'POUND' ? 'lb'
            : selected.initialWeightUnitCode === 'GRAM' ? 'g' : 'kg'}`}</dd></div>
        <div><dt>Razas</dt><dd>{selected.breeds?.map((breed) => breed.name).join(', ') || 'No registradas'}</dd></div>
        <div><dt>Colores</dt><dd>{selected.colors?.map((color) => color.name).join(', ') || 'No registrados'}</dd></div></dl>
      <dl className="animal-parent-summary"><div><dt>Madre</dt><dd>{selected.mother?.name || 'No registrada'}</dd></div>
        <div><dt>Padre</dt><dd>{selected.father?.name || 'No registrado'}</dd></div></dl>
      {canUpdate && <form className="animal-catalog-edit" key={`description:${selected.id}:${selected.version}`}
        onSubmit={(event) => void changeDescription(event)}>
        <h4>Descripción</h4>
        <label><span>Notas del animal</span><textarea name="description" maxLength={5000}
          rows={4} defaultValue={selected.description || ''} disabled={busy} /></label>
        <button className="primary-button compact" type="submit" disabled={busy}>
          {busy ? 'Guardando…' : 'Guardar descripción'}</button>
      </form>}
      {canUpdate && <form className="animal-catalog-edit" key={`owners:${selected.id}:${selected.version}`}
        onSubmit={(event) => void changeOwners(event)}>
        <h4>Propietarios y participación</h4>
        <OwnerFields owners={owners} selected={selected} />
        <button className="primary-button compact" disabled={busy}>Guardar propietarios</button>
      </form>}
      {canUpdate && choices && <form className="animal-catalog-edit" key={`${selected.id}:${selected.version}`}
        onSubmit={(event) => void changeCatalogs(event)}>
        <h4>Raza y colores</h4><CatalogFields choices={choices} selected={selected} />
        <button className="primary-button compact" type="submit" disabled={busy}>
          {busy ? 'Guardando…' : 'Guardar cambios'}</button>
      </form>}
      {canUpdate && brands && <form className="animal-catalog-edit" key={`brands:${selected.id}:${selected.version}`}
        onSubmit={(event) => void changeBrands(event)}>
        <h4>Marquillas</h4><BrandFields brands={brands} selected={selected} />
        <button className="primary-button compact" type="submit" disabled={busy}>
          {busy ? 'Guardando…' : 'Guardar marquillas'}</button>
      </form>}
      {canUpdate && <form className="animal-catalog-edit" key={`parents:${selected.id}:${selected.version}`}
        onSubmit={(event) => void changeParents(event)}>
        <h4>Parentesco</h4>
        <div className="animal-parent-grid">
          <ParentField accessToken={accessToken} child={selected} role="mother" />
          <ParentField accessToken={accessToken} child={selected} role="father" />
        </div>
        <button className="primary-button compact" type="submit" disabled={busy}>
          {busy ? 'Guardando…' : 'Guardar parentesco'}</button>
      </form>}
    </div>}
  </section>;
}

function message(error: unknown) {
  return error instanceof ApiRequestError ? error.message : 'No fue posible completar la operación.';
}
