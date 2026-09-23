import { type FormEvent, useEffect, useState } from 'react';
import { ApiRequestError, createAnimal, getAnimal, getAnimals, type Animal, type AnimalList } from './api';

export function AnimalPanel({ accessToken, canCreate }: { accessToken: string; canCreate: boolean }) {
  const [result, setResult] = useState<AnimalList | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<Animal | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getAnimals(accessToken, page, search).then((list) => {
      if (active) { setResult(list); setError(null); }
    }).catch((failure) => { if (active) setError(message(failure)); });
    return () => { active = false; };
  }, [accessToken, page, search, revision]);

  function find(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1); setSearch(searchInput.trim()); setSelected(null);
  }

  async function open(id: string) {
    setBusy(true); setError(null);
    try { setSelected(await getAnimal(accessToken, id)); }
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
      });
      setSelected(created); setShowCreate(false); setSearchInput(''); setSearch(''); setPage(1);
      setRevision((value) => value + 1);
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }

  return <section className="section-block animal-panel">
    <div className="section-heading"><div><span className="eyebrow">Núcleo ganadero</span><h2>Animales</h2>
      <p className="muted">Registros de la propiedad activa.</p></div>
      {canCreate && <button className="primary-button compact" type="button" disabled={busy}
        onClick={() => setShowCreate((value) => !value)}>{showCreate ? 'Cerrar' : '+ Animal'}</button>}
    </div>
    {error && <div className="form-error admin-error" role="alert">{error}</div>}
    {showCreate && <form className="animal-create" onSubmit={(event) => void create(event)}>
      <label><span>Nombre *</span><input name="name" maxLength={160} required disabled={busy} /></label>
      <label><span>Sexo *</span><select name="sex" required disabled={busy} defaultValue="">
        <option value="" disabled>Selecciona</option><option value="FEMALE">Hembra</option>
        <option value="MALE">Macho</option></select></label>
      <label><span>Marquilla</span><input name="earTagCode" maxLength={80} disabled={busy} /></label>
      <label><span>Fecha de nacimiento</span><input type="date" name="birthDate" disabled={busy} /></label>
      <label><span>Fecha de ingreso</span><input type="date" name="entryDate" disabled={busy} />
        <small>Si queda vacía, se usa la fecha actual de la finca.</small></label>
      <label><span>Peso inicial</span><input type="number" name="initialWeight" min="0.001"
        max="999999999" step="0.001" disabled={busy} /></label>
      <label><span>Unidad de peso</span><select name="weightUnit" disabled={busy} defaultValue="KILOGRAM">
        <option value="KILOGRAM">kg</option><option value="POUND">lb</option>
        <option value="GRAM">g</option></select></label>
      <button className="primary-button compact" type="submit" disabled={busy}>
        {busy ? 'Guardando…' : 'Registrar animal'}</button>
    </form>}
    <form className="animal-search" onSubmit={find} role="search">
      <label><span>Buscar por nombre o marquilla</span><input value={searchInput} maxLength={80}
        onChange={(event) => setSearchInput(event.target.value)} /></label>
      <button className="secondary-button compact" type="submit">Buscar</button>
    </form>
    {!result && !error && <p className="muted">Cargando animales…</p>}
    {result && <>
      {result.items.length === 0 && <p className="muted">No hay animales con ese criterio en esta propiedad.</p>}
      <div className="animal-list">{result.items.map((entry) => <button type="button" key={entry.id}
        className="animal-row" onClick={() => void open(entry.id)} disabled={busy}>
        <span><strong>{entry.name}</strong><small>{entry.earTagCode || 'Sin marquilla'}</small></span>
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
      <dl><div><dt>Marquilla</dt><dd>{selected.earTagCode || 'No registrada'}</dd></div>
        <div><dt>Sexo</dt><dd>{selected.sex === 'FEMALE' ? 'Hembra' : 'Macho'}</dd></div>
        <div><dt>Nacimiento</dt><dd>{selected.birthDate || 'No registrado'}</dd></div>
        <div><dt>Ingreso</dt><dd>{selected.entryDate}</dd></div>
        <div><dt>Peso inicial</dt><dd>{selected.initialWeight === null ? 'No registrado'
          : `${selected.initialWeight} ${selected.initialWeightUnitCode === 'POUND' ? 'lb'
            : selected.initialWeightUnitCode === 'GRAM' ? 'g' : 'kg'}`}</dd></div></dl>
    </div>}
  </section>;
}

function message(error: unknown) {
  return error instanceof ApiRequestError ? error.message : 'No fue posible completar la operación.';
}
