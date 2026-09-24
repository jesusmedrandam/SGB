import { type FormEvent, useEffect, useState } from 'react';
import {
  ApiRequestError, cancelHeat, cancelPregnancy, cancelService, createHeat, createPregnancy, createService,
  getReproduction, getReproductionCandidates, getReproductionSettings,
  recordBirth, recordLoss, updateReproductionSettings,
  type ReproductionCandidate, type ReproductionRecords, type ReproductionSettings,
} from './api';

function localDate() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}
const errorMessage = (error: unknown) => error instanceof ApiRequestError
  ? error.message : error instanceof Error ? error.message : 'No fue posible guardar el evento.';
const optional = (form: FormData, name: string) => String(form.get(name) || '').trim() || null;

export function ReproductionPanel({ accessToken, canManage, initialAnimalId }: {
  accessToken: string; canManage: boolean; initialAnimalId?:string|undefined;
}) {
  const [records, setRecords] = useState<ReproductionRecords | null>(null);
  const [candidates, setCandidates] = useState<ReproductionCandidate[]>([]);
  const [settings, setSettings] = useState<ReproductionSettings | null>(null);
  const [cowId, setCowId] = useState('');
  const [calfCount, setCalfCount] = useState(1);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeForm, setActiveForm] = useState<'HEAT'|'PREGNANCY'|'SERVICE'|'BIRTH'|'LOSS'|null>(null);
  const females = candidates.filter((animal) => animal.sex === 'FEMALE');
  const [prefilledAnimalId,setPrefilledAnimalId]=useState<string|null>(null);
  useEffect(()=>{if(!initialAnimalId||initialAnimalId===prefilledAnimalId||!canManage||
    !candidates.some(animal=>animal.id===initialAnimalId&&animal.sex==='FEMALE'))return;
    setCowId(initialAnimalId);setActiveForm('HEAT');setPrefilledAnimalId(initialAnimalId);
  },[initialAnimalId,prefilledAnimalId,candidates,canManage]);
  const males = candidates.filter((animal) => animal.sex === 'MALE');
  const confirmed = records?.pregnancies.filter((pregnancy) => pregnancy.status === 'CONFIRMED') ?? [];

  useEffect(() => {
    let active = true;
    void Promise.all([getReproduction(accessToken), getReproductionCandidates(accessToken),
      getReproductionSettings(accessToken)])
      .then(([next, animals, config]) => {
        if (active) { setRecords(next); setCandidates(animals); setSettings(config); }
      })
      .catch((failure) => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, [accessToken, revision]);

  async function run(operation: () => Promise<unknown>, form?: HTMLFormElement) {
    setBusy(true); setError(null);
    try { await operation(); form?.reset(); setRevision((value) => value + 1); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  function heat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void run(() => createHeat(accessToken, {
      cowId: String(data.get('cowId')), bullId: optional(data, 'bullId'),
      startsOn: String(data.get('startsOn')), endsOn: optional(data, 'endsOn'),
      isFalse: data.get('isFalse') === 'on', notes: optional(data, 'notes'),
    }), form);
  }

  function pregnancy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const days = optional(data, 'gestationDays');
    const serviceId = optional(data, 'serviceId');
    const service = records?.services.find((row) => row.id === serviceId);
    void run(() => createPregnancy(accessToken, {
      cowId: String(data.get('cowId')), heatId: service ? null : optional(data, 'heatId'), serviceId,
      fatherId: service ? null : optional(data, 'fatherId'),
      externalFather: service ? null : optional(data, 'externalFather'),
      conceptionMethod: service?.kind ?? String(data.get('conceptionMethod')),
      confirmationMethod: String(data.get('confirmationMethod')),
      confirmedOn: String(data.get('confirmedOn')),
      ...(days ? { gestationDays: Number(days) } : {}), notes: optional(data, 'notes'),
    }), form);
  }

  function reproductiveService(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void run(() => createService(accessToken, {
      cowId: String(data.get('cowId')), heatId: optional(data, 'heatId'),
      fatherId: optional(data, 'fatherId'), externalFather: optional(data, 'externalFather'),
      donorId: optional(data, 'donorId'), externalDonor: optional(data, 'externalDonor'),
      kind: String(data.get('kind')) as 'INSEMINATION' | 'EMBRYO_TRANSFER',
      occurredOn: String(data.get('occurredOn')), materialCode: optional(data, 'materialCode'),
      quality: optional(data, 'quality'), technician: optional(data, 'technician'),
      supplier: optional(data, 'supplier'), notes: optional(data, 'notes'),
    }), form);
  }

  function birth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const calves = Array.from({ length: calfCount }, (_, index) => ({
      name: String(data.get(`calfName:${index}`) || '').trim(),
      sex: String(data.get(`calfSex:${index}`)) as 'FEMALE' | 'MALE',
      ...(optional(data, `calfTag:${index}`) ? { earTagCode: optional(data, `calfTag:${index}`)! } : {}),
    }));
    void run(() => recordBirth(accessToken, {
      pregnancyId: String(data.get('pregnancyId')),
      occurredOn: String(data.get('occurredOn')), calves,
      stillbornCount: Number(data.get('stillbornCount') || 0), notes: optional(data, 'notes'),
    }), form);
  }

  function loss(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void run(() => recordLoss(accessToken, {
      pregnancyId: String(data.get('pregnancyId')),
      occurredOn: String(data.get('occurredOn')), notes: String(data.get('notes')).trim(),
    }), form);
  }

  function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const days = (key: string) => Number(data.get(key));
    const checked = (key: string) => data.get(key) === 'on';
    void run(() => updateReproductionSettings(accessToken, {
      daysAfterBirthHeat: days('daysAfterBirthHeat'),
      daysAfterBirthPregnancy: days('daysAfterBirthPregnancy'),
      daysAfterLossHeat: days('daysAfterLossHeat'),
      daysAfterLossPregnancy: days('daysAfterLossPregnancy'),
      minimumCowMonths: days('minimumCowMonths'), minimumBullMonths: days('minimumBullMonths'),
      allowSecondHeat: checked('allowSecondHeat'),
      allowFalseHeatInPregnancy: checked('allowFalseHeatInPregnancy'),
      useLastValidHeat: checked('useLastValidHeat'),
      maxMilkingDays: days('maxMilkingDays'),
    }));
  }

  return <section className="section-block reproduction-panel">
    <div className="section-heading"><div><span className="eyebrow">Núcleo ganadero</span>
      <h2>Reproducción</h2><p className="muted">Celos, preñeces, partos y pérdidas de la propiedad activa.</p>
    </div></div>
    {error && <div role="alert" className="form-error admin-error">{error}</div>}
    {!records && !error && <p className="muted">Cargando historial…</p>}
    {canManage && settings && <details className="reproduction-settings">
      <summary>Reglas de reproducción de esta propiedad</summary>
      <form className="group-new-form" onSubmit={saveSettings} key={revision}>
        <p className="muted">Los cambios rigen los próximos registros; el historial conserva sus datos.</p>
        {([
          ['daysAfterBirthHeat', 'Días tras parto para celo', 365],
          ['daysAfterBirthPregnancy', 'Días tras parto para preñez', 365],
          ['daysAfterLossHeat', 'Días tras pérdida para celo', 365],
          ['daysAfterLossPregnancy', 'Días tras pérdida para preñez', 365],
          ['minimumCowMonths', 'Edad mínima de la vaca (meses)', 120],
          ['minimumBullMonths', 'Edad mínima del toro (meses)', 120],
          ['maxMilkingDays', 'Máximo de días de ordeño tras parto', 730],
        ] as const).map(([key, label, max]) => <label key={key}><span>{label}</span>
          <input type="number" name={key} min="0" max={max} required defaultValue={settings[key]} />
        </label>)}
        {([
          ['allowSecondHeat', 'Permitir más de un celo en el ciclo'],
          ['allowFalseHeatInPregnancy', 'Permitir celos falsos durante la preñez'],
          ['useLastValidHeat', 'Usar el final del último celo válido para calcular el parto'],
        ] as const).map(([key, label]) => <label key={key}><span>{label}</span>
          <input type="checkbox" name={key} defaultChecked={settings[key]} />
        </label>)}
        <button className="primary-button compact" disabled={busy}>Guardar reglas</button>
      </form>
    </details>}
    {canManage && <div className="form-toolbar" aria-label="Registrar evento reproductivo">
      {([['HEAT','Celo'],['SERVICE','Servicio'],['PREGNANCY','Preñez'],
        ['BIRTH','Parto'],['LOSS','Pérdida']] as const).map(([id,label])=><button
          key={id} type="button" className={activeForm===id?'active':''}
          aria-pressed={activeForm===id} onClick={()=>setActiveForm(activeForm===id?null:id)}>
          {label}</button>)}
    </div>}
    {canManage && activeForm && <div className="reproduction-forms">
      <form className="group-new-form" onSubmit={heat} hidden={activeForm!=='HEAT'}>
        <h3>Registrar celo</h3>
        <label><span>Vaca *</span><select name="cowId" required defaultValue={initialAnimalId??''}>
          <option value="" disabled>Selecciona la vaca</option>
          {females.map((animal) => <option key={animal.id} value={animal.id}>{animal.name}</option>)}
        </select></label>
        <label><span>Toro registrado</span><select name="bullId" defaultValue="">
          <option value="">No registrado</option>
          {males.map((animal) => <option key={animal.id} value={animal.id}>{animal.name}</option>)}
        </select></label>
        <label><span>Inicio *</span><input type="date" name="startsOn" required defaultValue={localDate()} /></label>
        <label><span>Fin</span><input type="date" name="endsOn" /></label>
        <label><span>Celo aparente o falso</span><input type="checkbox" name="isFalse" /></label>
        <label><span>Observaciones</span><textarea name="notes" maxLength={500} /></label>
        <button className="primary-button compact" disabled={busy || !females.length}>Guardar celo</button>
      </form>

      <form className="group-new-form" onSubmit={pregnancy} hidden={activeForm!=='PREGNANCY'}>
        <h3>Confirmar preñez</h3>
        <label><span>Vaca *</span><select name="cowId" required value={cowId}
          onChange={(event) => setCowId(event.target.value)}>
          <option value="" disabled>Selecciona la vaca</option>
          {females.map((animal) => <option key={animal.id} value={animal.id}>{animal.name}</option>)}
        </select></label>
        <label><span>Celo relacionado</span><select name="heatId" defaultValue="" key={cowId}>
          <option value="">Sin celo registrado</option>
          {records?.heats.filter((entry) => entry.cowId === cowId && !entry.cancelled && !entry.isFalse)
            .map((entry) => <option key={entry.id} value={entry.id}>{entry.startsOn}</option>)}
        </select></label>
        <label><span>Servicio asistido relacionado</span><select name="serviceId" defaultValue="" key={`service:${cowId}`}>
          <option value="">Sin servicio asistido</option>
          {records?.services.filter((entry) => entry.cowId === cowId && !entry.cancelled && !entry.hasPregnancy)
            .map((entry) => <option key={entry.id} value={entry.id}>
              {entry.occurredOn} · {entry.kind === 'INSEMINATION' ? 'Inseminación' : 'Transferencia'}</option>)}
        </select><small>Si eliges un servicio, se toman su celo y padre.</small></label>
        <label><span>Padre registrado</span><select name="fatherId" defaultValue="">
          <option value="">No registrado</option>
          {males.map((animal) => <option key={animal.id} value={animal.id}>{animal.name}</option>)}
        </select></label>
        <label><span>Padre externo</span><input name="externalFather" maxLength={240} /></label>
        <label><span>Método de embarazo</span><select name="conceptionMethod" defaultValue="NATURAL">
          <option value="NATURAL">Monta natural</option>
          <option value="INSEMINATION">Inseminación</option>
          <option value="EMBRYO_TRANSFER">Transferencia de embriones</option>
          <option value="UNKNOWN">Desconocido</option>
        </select></label>
        <label><span>Método de confirmación</span><select name="confirmationMethod" defaultValue="PALPATION">
          <option value="PALPATION">Palpación</option><option value="ULTRASOUND">Ecografía</option>
          <option value="BLOOD_TEST">Análisis de sangre</option>
          <option value="OBSERVATION">Observación</option><option value="OTHER">Otro</option>
        </select></label>
        <label><span>Fecha de confirmación *</span><input type="date" name="confirmedOn"
          required defaultValue={localDate()} /></label>
        <label><span>Días de gestación</span><input type="number" name="gestationDays" min="0" max="400" />
          <small>Con un celo se calculan automáticamente; sin selección se usa el último celo válido según las reglas.</small></label>
        <label><span>Observaciones</span><textarea name="notes" maxLength={500} /></label>
        <button className="primary-button compact" disabled={busy || !females.length}>
          Confirmar preñez</button>
      </form>

      <form className="group-new-form" onSubmit={reproductiveService} hidden={activeForm!=='SERVICE'}>
        <h3>Inseminación o transferencia</h3>
        <label><span>Receptora *</span><select name="cowId" required defaultValue="">
          <option value="" disabled>Selecciona la vaca</option>
          {females.map((animal) => <option key={animal.id} value={animal.id}>{animal.name}</option>)}
        </select></label>
        <label><span>Tipo *</span><select name="kind" defaultValue="INSEMINATION">
          <option value="INSEMINATION">Inseminación artificial</option>
          <option value="EMBRYO_TRANSFER">Transferencia de embriones</option>
        </select></label>
        <label><span>Fecha *</span><input type="date" name="occurredOn" required defaultValue={localDate()} /></label>
        <label><span>Celo relacionado</span><select name="heatId" defaultValue="">
          <option value="">Sin celo registrado</option>
          {records?.heats.filter((entry) => !entry.cancelled && !entry.isFalse)
            .map((entry) => <option key={entry.id} value={entry.id}>{entry.cowName} · {entry.startsOn}</option>)}
        </select></label>
        <label><span>Padre registrado</span><select name="fatherId" defaultValue="">
          <option value="">Sin padre registrado</option>
          {males.map((animal) => <option key={animal.id} value={animal.id}>{animal.name}</option>)}
        </select></label>
        <label><span>Padre externo</span><input name="externalFather" maxLength={240} /></label>
        <label><span>Donante registrada (solo transferencia)</span><select name="donorId" defaultValue="">
          <option value="">Sin donante registrada</option>
          {females.map((animal) => <option key={animal.id} value={animal.id}>{animal.name}</option>)}
        </select></label>
        <label><span>Donante externa (solo transferencia)</span><input name="externalDonor" maxLength={240} /></label>
        <label><span>Código de material</span><input name="materialCode" maxLength={160} /></label>
        <label><span>Calidad</span><input name="quality" maxLength={120} /></label>
        <label><span>Técnico</span><input name="technician" maxLength={160} /></label>
        <label><span>Proveedor</span><input name="supplier" maxLength={160} /></label>
        <label><span>Observaciones</span><textarea name="notes" maxLength={2000} /></label>
        <button className="primary-button compact" disabled={busy || !females.length}>Guardar servicio</button>
      </form>

      <form className="group-new-form" onSubmit={birth} hidden={activeForm!=='BIRTH'}>
        <h3>Registrar parto</h3>
        <label><span>Preñez confirmada *</span><select name="pregnancyId" required defaultValue="">
          <option value="" disabled>Selecciona una preñez</option>
          {confirmed.map((item) => <option key={item.id} value={item.id}>
            {item.cowName} · {item.confirmedOn}</option>)}
        </select></label>
        <label><span>Fecha de parto *</span><input type="date" name="occurredOn"
          required defaultValue={localDate()} /></label>
        <label><span>Crías vivas</span><input type="number" min="0" max="8" value={calfCount}
          onChange={(event) => setCalfCount(Number(event.target.value))} /></label>
        {Array.from({ length: calfCount }, (_, index) => <div key={index} className="group-inline-form">
          <label><span>Nombre de la cría {index + 1} *</span>
            <input name={`calfName:${index}`} required maxLength={160} /></label>
          <label><span>Sexo *</span><select name={`calfSex:${index}`} defaultValue="FEMALE">
            <option value="FEMALE">Hembra</option><option value="MALE">Macho</option>
          </select></label>
          <label><span>Arete individual</span><input name={`calfTag:${index}`} maxLength={80} /></label>
        </div>)}
        <label><span>Crías nacidas muertas</span><input type="number" name="stillbornCount"
          defaultValue="0" min="0" max="8" required /></label>
        <label><span>Observaciones</span><textarea name="notes" maxLength={5000} /></label>
        <button className="primary-button compact" disabled={busy || !confirmed.length}>
          Registrar parto y crías</button>
      </form>

      <form className="group-new-form" onSubmit={loss} hidden={activeForm!=='LOSS'}>
        <h3>Registrar pérdida de preñez</h3>
        <label><span>Preñez confirmada *</span><select name="pregnancyId" required defaultValue="">
          <option value="" disabled>Selecciona una preñez</option>
          {confirmed.map((item) => <option key={item.id} value={item.id}>
            {item.cowName} · {item.confirmedOn}</option>)}
        </select></label>
        <label><span>Fecha *</span><input type="date" name="occurredOn"
          required defaultValue={localDate()} /></label>
        <label><span>Observaciones *</span><textarea name="notes" required maxLength={5000} /></label>
        <button className="secondary-button compact" disabled={busy || !confirmed.length}>
          Registrar pérdida</button>
      </form>
    </div>}

    {records && <div className="reproduction-records">
      <div><h3>Servicios asistidos</h3>
        {records.services.length === 0 && <p className="muted">Sin servicios registrados.</p>}
        {records.services.map((item) => <details key={item.id} className="group-location-item record-line">
          <summary><strong>{item.cowName} · {item.occurredOn}</strong></summary>
          <small>{item.kind === 'INSEMINATION' ? 'Inseminación' : 'Transferencia'}
            {item.cancelled ? ' · Cancelado' : ''}{item.hasPregnancy ? ' · Con preñez' : ''}</small>
          {canManage && !item.cancelled && !item.hasPregnancy &&
            <button className="secondary-button compact" disabled={busy}
              onClick={() => { if (window.confirm('¿Cancelar este servicio? Se conservará en el historial.'))
                void run(() => cancelService(accessToken, item.id)); }}>Cancelar servicio</button>}
        </details>)}</div>
      <div><h3>Preñeces y próximos partos</h3>
        {records.pregnancies.length === 0 && <p className="muted">Sin preñeces registradas.</p>}
        {records.pregnancies.map((item) => <details key={item.id} className="group-location-item record-line">
          <summary><strong>{item.cowName} · {item.status === 'CONFIRMED' ? 'Confirmada'
            : item.status === 'BORN' ? 'Parto registrado'
              : item.status === 'LOST' ? 'Pérdida' : 'Cancelada'}</strong></summary>
          <small>Confirmada {item.confirmedOn} · Parto estimado {item.expectedBirthOn || 'sin estimación'}</small>
          {canManage && item.status === 'CONFIRMED' && <button className="secondary-button compact"
            disabled={busy} onClick={() => {
              if (window.confirm('¿Cancelar esta preñez? Se conservará en el historial.'))
                void run(() => cancelPregnancy(accessToken, item.id));
            }}>Cancelar preñez</button>}
        </details>)}</div>
      <div><h3>Celos</h3>
        {records.heats.length === 0 && <p className="muted">Sin celos registrados.</p>}
        {records.heats.map((item) => <details key={item.id} className="group-location-item record-line">
          <summary><strong>{item.cowName} · {item.startsOn}</strong></summary>
          <small>{item.isFalse ? 'Celo falso' : 'Celo'}{item.cancelled ? ' · Cancelado' : ''}
            {item.endsOn ? ` · Fin: ${item.endsOn}` : ''}</small>
          {canManage && !item.cancelled && <button className="secondary-button compact" disabled={busy}
            onClick={() => { if (window.confirm('¿Cancelar este celo? Se conservará en el historial.'))
              void run(() => cancelHeat(accessToken, item.id)); }}>Cancelar celo</button>}
        </details>)}</div>
      <div><h3>Partos</h3>
        {records.births.length === 0 && <p className="muted">Sin partos registrados.</p>}
        {records.births.map((item) => <details key={item.id} className="group-location-item record-line">
          <summary><strong>{item.motherName} · {item.occurredOn}</strong></summary>
          <small>{item.liveCount} vivas · {item.stillbornCount} nacidas muertas
            {item.calves.length ? ` · ${item.calves.map((calf) => calf.name).join(', ')}` : ''}</small>
        </details>)}</div>
      <div><h3>Pérdidas</h3>
        {records.losses.length === 0 && <p className="muted">Sin pérdidas registradas.</p>}
        {records.losses.map((item) => <details key={item.id} className="group-location-item record-line">
          <summary><strong>{item.cowName} · {item.occurredOn}</strong></summary><small>{item.notes}</small>
        </details>)}</div>
    </div>}
  </section>;
}
