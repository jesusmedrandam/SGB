import { type FormEvent, useEffect, useState } from 'react';
import {
  ApiRequestError, createAnimal, createBrand, getAnimal, getAnimals, listBrands,
  listCatalogItems, setBrandActive, updateAnimalBrands, updateAnimalCatalogs,
  type Animal, type AnimalList, type CatalogItem, type LivestockBrand,
} from './api';

interface AnimalChoices { BREEDS: CatalogItem[]; COLORS: CatalogItem[] }

async function loadAnimalChoices(accessToken: string): Promise<AnimalChoices> {
  const [breeds, colors] = await Promise.all([
    listCatalogItems(accessToken, 'BREEDS'), listCatalogItems(accessToken, 'COLORS'),
  ]);
  return { BREEDS: breeds, COLORS: colors };
}

function CatalogFields({ choices, selected }: { choices: AnimalChoices; selected?: Animal | null }) {
  const breed = selected?.breed;
  const colors = selected?.colors || [];
  const availableBreed = choices.BREEDS.filter((entry) => entry.active &&
    (!entry.speciesCode || entry.speciesCode === 'BOVINE'));
  const availableColors = choices.COLORS.filter((entry) => entry.active &&
    (!entry.speciesCode || entry.speciesCode === 'BOVINE'));
  if (breed && !availableBreed.some((entry) => entry.id === breed.id)) {
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
    <label><span>Raza</span><select name="breedId" defaultValue={breed?.id || ''}>
      <option value="">Sin raza registrada</option>
      {availableBreed.map((entry) => <option key={entry.id} value={entry.id}>
        {entry.name}{entry.active ? '' : ' (inactiva)'}
      </option>)}
    </select></label>
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

function BrandFields({ brands, selected }: { brands: LivestockBrand[]; selected?: Animal | null }) {
  const chosen = selected?.brands ?? [];
  const available = brands.filter((brand) => brand.active || chosen.some((entry) => entry.id === brand.id));
  return <fieldset className="animal-colors"><legend>Marquillas de la propiedad</legend>
    {available.length === 0 && <small>Registra primero una marquilla en la sección Marquillas.</small>}
    {available.map((brand) => <label key={brand.id}>
      <input type="checkbox" name="brandIds" value={brand.id}
        defaultChecked={chosen.some((entry) => entry.id === brand.id)} />
      <span>{brand.name}{brand.active ? '' : ' (inactiva)'}</span>
    </label>)}
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
    const breedId = optional('breedId');
    const colorIds = data.getAll('colorIds').map(String);
    const brandIds = data.getAll('brandIds').map(String);
    setBusy(true); setError(null);
    try {
      const created = await createAnimal(accessToken, {
        name: String(data.get('name') || '').trim(),
        sex: String(data.get('sex')) as Animal['sex'],
        speciesCode: 'BOVINE',
        ...(earTagCode ? { earTagCode } : {}),
        ...(birthDate ? { birthDate } : {}),
        ...(entryDate ? { entryDate } : {}),
        ...(weight ? { initialWeight: Number(weight), initialWeightUnitCode: String(data.get('weightUnit')) } : {}),
        ...(choices ? { breedId: breedId ?? null, colorIds } : {}),
        brandIds,
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
        breedId: String(data.get('breedId') || '') || null,
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

  async function addBrand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get('name') || '').trim();
    setBusy(true); setError(null);
    try {
      await createBrand(accessToken, name);
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
      <h3>Marquillas</h3>
      <p className="muted">Regístralas aquí y después elígelas en los animales. El arete individual se registra aparte.</p>
      {canManageBrands && <form className="catalog-create" onSubmit={(event) => void addBrand(event)}>
        <label><span>Nombre o código de la marquilla</span>
          <input name="name" required maxLength={160} disabled={busy} placeholder="Ej. M7L" /></label>
        <button className="secondary-button compact" type="submit" disabled={busy}>Agregar marquilla</button>
      </form>}
      {brands === null ? <p className="muted">Cargando marquillas…</p>
        : brands.length === 0 ? <p className="muted">Todavía no hay marquillas registradas.</p>
          : <div className="animal-brand-list">{brands.map((brand) =>
            <div key={brand.id} className="animal-brand-row"><span>{brand.name}{brand.active ? '' : ' · Inactiva'}</span>
              {canManageBrands && <button className="secondary-button compact" type="button"
                disabled={busy} onClick={() => void changeBrandState(brand)}>
                {brand.active ? 'Desactivar' : 'Activar'}</button>}</div>)}</div>}
    </div>
    {showCreate && <form className="animal-create" onSubmit={(event) => void create(event)}>
      <label><span>Nombre *</span><input name="name" maxLength={160} required disabled={busy} /></label>
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
        <option value="GRAM">g</option></select></label>
      {choices && <CatalogFields choices={choices} />}
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
      <dl><div><dt>Arete individual</dt><dd>{selected.earTagCode || 'No registrado'}</dd></div>
        <div><dt>Marquillas</dt><dd>{selected.brands.map((brand) => brand.name).join(', ') || 'No registradas'}</dd></div>
        <div><dt>Sexo</dt><dd>{selected.sex === 'FEMALE' ? 'Hembra' : 'Macho'}</dd></div>
        <div><dt>Nacimiento</dt><dd>{selected.birthDate || 'No registrado'}</dd></div>
        <div><dt>Ingreso</dt><dd>{selected.entryDate}</dd></div>
        <div><dt>Peso inicial</dt><dd>{selected.initialWeight === null ? 'No registrado'
          : `${selected.initialWeight} ${selected.initialWeightUnitCode === 'POUND' ? 'lb'
            : selected.initialWeightUnitCode === 'GRAM' ? 'g' : 'kg'}`}</dd></div>
        <div><dt>Raza</dt><dd>{selected.breed?.name || 'No registrada'}</dd></div>
        <div><dt>Colores</dt><dd>{selected.colors?.map((color) => color.name).join(', ') || 'No registrados'}</dd></div></dl>
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
    </div>}
  </section>;
}

function message(error: unknown) {
  return error instanceof ApiRequestError ? error.message : 'No fue posible completar la operación.';
}
