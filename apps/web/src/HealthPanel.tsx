import {type FormEvent,useEffect,useState} from 'react';
import {ApiRequestError,applyHealthCampaign,cancelHealthCampaign,createHealthCampaign,
  createHealthMedicine,getHealthCampaigns,getHealthMedicines,getHealthOptions,
  updateHealthCampaign,type HealthCampaign,type HealthCampaignInput,
  type HealthMedicine,type HealthOptions} from './api';

const kinds={VACUNA:'Vacuna',DESPARASITACION:'Desparasitación',
  ENFERMEDAD:'Enfermedad',OTRO:'Otro tratamiento'};
const routes={ORAL:'Oral',INTRAMUSCULAR:'Intramuscular',SUBCUTANEA:'Subcutánea',
  INTRAVENOSA:'Intravenosa',TOPICA:'Tópica',OTRA:'Otra'};
const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const message=(error:unknown)=>error instanceof ApiRequestError?error.message:
  error instanceof Error?error.message:'No se pudo guardar el registro sanitario.';

export function HealthPanel({accessToken,canManage}:{accessToken:string;canManage:boolean}){
  const [medicines,setMedicines]=useState<HealthMedicine[]>([]);
  const [options,setOptions]=useState<HealthOptions|null>(null);
  const [campaigns,setCampaigns]=useState<HealthCampaign[]|null>(null);
  const [revision,setRevision]=useState(0);
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [showMedicine,setShowMedicine]=useState(false);
  const [showCampaign,setShowCampaign]=useState(false);
  const [editing,setEditing]=useState<HealthCampaign|null>(null);
  const [medicineId,setMedicineId]=useState('');
  const [mode,setMode]=useState<HealthCampaignInput['selectionMode']>('MANUAL');
  const [groupId,setGroupId]=useState('');
  const [selected,setSelected]=useState<string[]>([]);
  const [doses,setDoses]=useState<Record<string,string>>({});

  useEffect(()=>{let active=true;
    void Promise.all([getHealthMedicines(accessToken),getHealthOptions(accessToken),
      getHealthCampaigns(accessToken)]).then(([items,choices,records])=>{
      if(active){setMedicines(items);setOptions(choices);setCampaigns(records);}
    }).catch((failure)=>{if(active)setError(message(failure));});
    return ()=>{active=false;};
  },[accessToken,revision]);
  const medicine=medicines.find((item)=>item.id===medicineId);
  const candidates=options?.animals.filter((animal)=>mode!=='GRUPO'||animal.groupId===groupId)??[];
  const selectedIds=mode==='MANUAL'?selected:candidates.map((animal)=>animal.id);
  function reset(){setEditing(null);setShowCampaign(false);setMedicineId('');setMode('MANUAL');
    setGroupId('');setSelected([]);setDoses({});}
  function edit(record:HealthCampaign){setEditing(record);setShowCampaign(true);
    setMedicineId(record.medicineId);setMode(record.selectionMode);setGroupId(record.groupId??'');
    setSelected(record.animals.filter((animal)=>animal.selected).map((animal)=>animal.animalId));
    setDoses(Object.fromEntries(record.animals.map((animal)=>[animal.animalId,String(animal.dose)])));
    window.scrollTo({top:0,behavior:'smooth'});
  }
  async function run(operation:()=>Promise<unknown>,done?:()=>void){setBusy(true);setError(null);
    try{await operation();done?.();setRevision((value)=>value+1);}
    catch(failure){setError(message(failure));window.scrollTo({top:0,behavior:'smooth'});}
    finally{setBusy(false);}
  }
  function saveMedicine(event:FormEvent<HTMLFormElement>){event.preventDefault();
    const data=new FormData(event.currentTarget);
    void run(()=>createHealthMedicine(accessToken,{
      name:String(data.get('name')).trim(),kind:String(data.get('kind')) as HealthMedicine['kind'],
      activeIngredient:String(data.get('ingredient')).trim()||null,
      defaultUnitCode:String(data.get('unit')),suggestedDose:String(data.get('suggestion')).trim()||null,
      indications:String(data.get('indications')).trim()||null,
      withdrawalMilkDays:Number(data.get('milkDays')),
      withdrawalMeatDays:Number(data.get('meatDays')),
    }),()=>setShowMedicine(false));
  }
  function saveCampaign(event:FormEvent<HTMLFormElement>){event.preventDefault();
    const data=new FormData(event.currentTarget);
    if(!medicine)return;
    const ids=mode==='MANUAL'?selected:candidates.map((animal)=>animal.id);
    const input:HealthCampaignInput={medicineId,selectionMode:mode,groupId:mode==='GRUPO'?groupId:null,
      administrationRoute:String(data.get('route')) as HealthCampaignInput['administrationRoute'],
      appliedOn:String(data.get('date')),responsible:String(data.get('responsible')).trim()||null,
      notes:String(data.get('notes')).trim()||null,
      animals:ids.map((id)=>({animalId:id,selected:true,
        dose:Number(doses[id]??data.get('defaultDose')),unitCode:medicine.defaultUnitCode})),
      ...(editing?{expectedVersion:editing.version}:{})};
    void run(()=>editing?updateHealthCampaign(accessToken,editing.id,input)
      :createHealthCampaign(accessToken,input),reset);
  }
  return <section className="section-block health-panel">
    <div className="section-heading"><div><span className="eyebrow">Operaciones</span>
      <h2>Sanidad y tratamientos</h2>
      <p className="muted">Registra vacunas, desparasitaciones y tratamientos por animal o por jornada.</p></div>
      {canManage&&<div className="movement-actions"><button className="secondary-button compact" type="button"
        onClick={()=>setShowMedicine((value)=>!value)}>+ Medicamento</button>
        <button className="primary-button compact" type="button" onClick={()=>showCampaign?reset():setShowCampaign(true)}>
          {showCampaign?'Cerrar':'+ Jornada'}</button></div>}
    </div>
    {error&&<div role="alert" className="form-error admin-error">{error}</div>}
    {canManage&&showMedicine&&<form className="movement-form" onSubmit={saveMedicine}>
      <h3>Nuevo medicamento</h3>
      <label><span>Nombre comercial *</span><input name="name" required minLength={2} maxLength={160}/></label>
      <label><span>Tipo *</span><select name="kind">{Object.entries(kinds).map(([code,label])=>
        <option key={code} value={code}>{label}</option>)}</select></label>
      <label><span>Unidad de dosis *</span><select name="unit">{options?.units.map((unit)=>
        <option key={unit.code} value={unit.code}>{unit.name} ({unit.symbol})</option>)}</select></label>
      <label><span>Principio activo</span><textarea name="ingredient" maxLength={2000}/></label>
      <label><span>Dosis sugerida</span><input name="suggestion" maxLength={300} placeholder="Ej. 1 ml por 50 kg"/></label>
      <label><span>Indicaciones</span><textarea name="indications" maxLength={2000}/></label>
      <label><span>Retiro de leche (días)</span><input name="milkDays" type="number" min={0}
        max={10000} defaultValue={0} required/></label>
      <label><span>Retiro de carne (días)</span><input name="meatDays" type="number" min={0}
        max={10000} defaultValue={0} required/></label>
      <button className="primary-button compact" disabled={busy}>Guardar medicamento</button>
    </form>}
    {canManage&&showCampaign&&options&&<form className="movement-form" onSubmit={saveCampaign}
      key={editing?.id??'new'}>
      <h3>{editing?'Editar borrador':'Nueva jornada sanitaria'}</h3>
      <label><span>Medicamento *</span><select required value={medicineId}
        onChange={(event)=>setMedicineId(event.target.value)}><option value="">Selecciona</option>
        {medicines.filter((item)=>item.active).map((item)=><option key={item.id} value={item.id}>
          {item.name} · {kinds[item.kind]}</option>)}</select></label>
      <label><span>Vía *</span><select name="route" defaultValue={editing?.administrationRoute??'INTRAMUSCULAR'}>
        {Object.entries(routes).map(([code,label])=><option key={code} value={code}>{label}</option>)}</select></label>
      <label><span>Selección</span><select value={mode} onChange={(event)=>{
        setMode(event.target.value as HealthCampaignInput['selectionMode']);setSelected([]);setGroupId('');}}>
        <option value="MANUAL">Animales seleccionados</option><option value="GRUPO">Grupo completo</option>
        <option value="TODOS">Toda la propiedad</option></select></label>
      {mode==='GRUPO'&&<label><span>Grupo *</span><select required value={groupId}
        onChange={(event)=>setGroupId(event.target.value)}><option value="">Selecciona</option>
        {options.groups.map((group)=><option key={group.id} value={group.id}>{group.name}</option>)}</select></label>}
      <label><span>Fecha *</span><input name="date" type="date" required max={today()}
        defaultValue={editing?.appliedOn??today()}/></label>
      <label><span>Dosis general * ({medicine?.defaultUnitCode??'unidad'})</span>
        <input name="defaultDose" type="number" min="0.001" max="1000000" step="any" required
          defaultValue={editing?.animals[0]?.dose??1}/></label>
      <label><span>Responsable</span><input name="responsible" maxLength={200}
        defaultValue={editing?.responsible??''}/></label>
      <label><span>Observaciones</span><textarea name="notes" maxLength={5000}
        defaultValue={editing?.notes??''}/></label>
      <div className="movement-selection movement-wide"><strong>{mode==='MANUAL'?'Elige animales':
        `${candidates.length} animales candidatos`}</strong>
        {mode==='MANUAL'&&<button type="button" className="secondary-button compact"
          onClick={()=>setSelected(selected.length===candidates.length?[]:candidates.map((item)=>item.id))}>
          {selected.length===candidates.length?'Quitar selección':'Seleccionar todos'}</button>}
        <div className="movement-animal-grid">{candidates.map((animal)=><div key={animal.id}
          className="health-animal-row"><label>{mode==='MANUAL'&&<input type="checkbox"
            checked={selected.includes(animal.id)} onChange={(event)=>setSelected(event.target.checked
              ?[...selected,animal.id]:selected.filter((id)=>id!==animal.id))}/>}
            {animal.name}{animal.earTagCode?` · ${animal.earTagCode}`:''}</label>
            {selectedIds.includes(animal.id)&&<input type="number" min="0.001" max="1000000"
              step="any" aria-label={`Dosis de ${animal.name}`} placeholder="Dosis individual"
              value={doses[animal.id]??''} onChange={(event)=>setDoses({...doses,
                [animal.id]:event.target.value})}/>}</div>)}</div>
      </div>
      <button className="primary-button compact" disabled={busy||!medicineId||!selectedIds.length
        ||selectedIds.length>500||mode==='GRUPO'&&!groupId}>
        {editing?'Guardar borrador':'Crear borrador'}</button>
    </form>}
    <div className="movement-list"><h3>Jornadas e historial</h3>
      {!campaigns&&!error&&<p className="muted">Cargando registros…</p>}
      {campaigns?.length===0&&<p className="muted">Aún no hay tratamientos registrados.</p>}
      {campaigns?.map((record)=><article className="movement-card" key={record.id}>
        <div className="movement-card-top"><div><strong>{record.medicineName}</strong>
          <small>{kinds[record.kind]} · {record.appliedOn} · {record.animals.filter((item)=>item.selected).length} animales</small></div>
          <span className={`movement-status status-${record.status.toLowerCase()}`}>
            {record.status==='BORRADOR'?'Borrador':record.status==='COMPLETADO'?'Completado':'Cancelado'}</span></div>
        <p>{routes[record.administrationRoute]}{record.groupName?` · ${record.groupName}`:''}</p>
        <details><summary>Ver animales y dosis</summary>{record.animals.map((animal)=><span
          className="movement-animal-name" key={animal.animalId}>
          {animal.name} · {animal.dose} {animal.unitCode}</span>)}</details>
        {canManage&&record.status==='BORRADOR'&&<div className="movement-actions">
          <button className="secondary-button compact" type="button" disabled={busy}
            onClick={()=>edit(record)}>Editar</button>
          <button className="primary-button compact" type="button" disabled={busy}
            onClick={()=>void run(()=>applyHealthCampaign(accessToken,record.id))}>Aplicar</button>
          <button className="secondary-button compact" type="button" disabled={busy}
            onClick={()=>void run(()=>cancelHealthCampaign(accessToken,record.id))}>Cancelar</button></div>}
      </article>)}</div>
  </section>;
}
