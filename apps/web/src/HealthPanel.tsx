import {type FormEvent,useEffect,useMemo,useState} from 'react';
import {ApiRequestError,applyHealthCampaign,cancelHealthCampaign,createHealthCampaign,
  createHealthMedicine,createHealthCondition,updateHealthCondition,resolveHealthCondition,
  getHealthConditions,getHealthCampaigns,getHealthMedicines,getHealthOptions,listCatalogItems,
  updateHealthCampaign,type HealthCampaign,type HealthCampaignInput,
  type HealthMedicine,type HealthOptions,type HealthCondition,type CatalogItem} from './api';

const kinds={VACUNA:'Vacuna',DESPARASITACION:'Desparasitación',
  ENFERMEDAD:'Enfermedad',OTRO:'Otro tratamiento'};
const routes={ORAL:'Oral',INTRAMUSCULAR:'Intramuscular',SUBCUTANEA:'Subcutánea',
  INTRAVENOSA:'Intravenosa',TOPICA:'Tópica',OTRA:'Otra'};
const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const message=(error:unknown)=>error instanceof ApiRequestError?error.message:
  error instanceof Error?error.message:'No se pudo guardar el registro sanitario.';
type HealthTab='conditions'|'treatments'|'campaigns';

export function HealthPanel({accessToken,canManage,initialAnimalId}:{accessToken:string;canManage:boolean;
  initialAnimalId?:string|undefined}){
  const [medicines,setMedicines]=useState<HealthMedicine[]>([]);
  const [options,setOptions]=useState<HealthOptions|null>(null);
  const [campaigns,setCampaigns]=useState<HealthCampaign[]|null>(null);
  const [conditions,setConditions]=useState<HealthCondition[]>([]);
  const [conditionTypes,setConditionTypes]=useState<CatalogItem[]>([]);
  const [treatmentTypes,setTreatmentTypes]=useState<CatalogItem[]>([]);
  const [revision,setRevision]=useState(0);
  const [error,setError]=useState<string|null>(null);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [tab,setTab]=useState<HealthTab>('conditions');
  const [search,setSearch]=useState('');
  const [order,setOrder]=useState<'NEWEST'|'OLDEST'|'AZ'|'ZA'>('NEWEST');
  const [selectedConditionId,setSelectedConditionId]=useState<string|null>(null);
  const [selectedCampaignId,setSelectedCampaignId]=useState<string|null>(null);
  const [selectedTreatment,setSelectedTreatment]=useState<{campaignId:string;animalId:string}|null>(null);
  const [showMedicine,setShowMedicine]=useState(false);
  const [showCondition,setShowCondition]=useState(false);
  const [editingCondition,setEditingCondition]=useState<HealthCondition|null>(null);
  const [showCampaign,setShowCampaign]=useState(false);
  const [editing,setEditing]=useState<HealthCampaign|null>(null);
  const [medicineId,setMedicineId]=useState('');
  const [mode,setMode]=useState<HealthCampaignInput['selectionMode']>('MANUAL');
  const [groupId,setGroupId]=useState('');
  const [selected,setSelected]=useState<string[]>([]);
  const [doses,setDoses]=useState<Record<string,string>>({});
  const [conditionIds,setConditionIds]=useState<Record<string,string>>({});
  const [prefilledAnimalId,setPrefilledAnimalId]=useState<string|null>(null);
  useEffect(()=>{if(!initialAnimalId||initialAnimalId===prefilledAnimalId||
    !options?.animals.some(item=>item.id===initialAnimalId)||!canManage)return;
    setTab('conditions');setShowCondition(true);setPrefilledAnimalId(initialAnimalId);
  },[initialAnimalId,prefilledAnimalId,options?.animals,canManage]);

  useEffect(()=>{let active=true;
    void Promise.allSettled([getHealthMedicines(accessToken),getHealthOptions(accessToken),
      getHealthCampaigns(accessToken),getHealthConditions(accessToken)]).then(([items,choices,records,events])=>{
      if(!active)return;
      if(items.status==='fulfilled')setMedicines(items.value);
      if(choices.status==='fulfilled')setOptions(choices.value);
      if(records.status==='fulfilled')setCampaigns(records.value);
      if(events.status==='fulfilled')setConditions(events.value);
      setLoading(false);
      const failure=[items,choices,records,events].find(result=>result.status==='rejected');
      if(failure?.status==='rejected')setError(message(failure.reason));
    });
    return ()=>{active=false;};
  },[accessToken,revision]);
  useEffect(()=>{let active=true;void Promise.all([
    listCatalogItems(accessToken,'HEALTH_CONDITION_TYPES'),
    listCatalogItems(accessToken,'TREATMENT_TYPES')]).then(([conditions,treatments])=>{
    if(active){setConditionTypes(conditions);setTreatmentTypes(treatments);}
  }).catch(failure=>{if(active)setError(message(failure));});return()=>{active=false;};},[accessToken]);
  const medicine=medicines.find((item)=>item.id===medicineId);
  const individualTreatment=tab==='treatments'&&!editing;
  const candidates=options?.animals.filter((animal)=>mode!=='GRUPO'||animal.groupId===groupId)??[];
  const selectedIds=mode==='MANUAL'?selected:candidates.map((animal)=>animal.id);
  const relatedTreatments=useMemo(()=>(campaigns??[]).filter(record=>record.status==='COMPLETADO')
    .flatMap(record=>record.animals.filter(animal=>animal.selected).map(animal=>({record,animal}))),[campaigns]);
  const visible=useMemo(()=>{
    const term=search.trim().toLocaleLowerCase();
    const sorted=<T,>(rows:T[],date:(item:T)=>string,name:(item:T)=>string)=>rows.sort((a,b)=>
      order==='AZ'||order==='ZA'?(order==='AZ'?1:-1)*name(a).localeCompare(name(b),'es'):
        (order==='NEWEST'?-1:1)*date(a).localeCompare(date(b)));
    return {
      conditions:sorted(conditions.filter(item=>[item.animalName,item.kind,item.description,item.status]
        .join(' ').toLocaleLowerCase().includes(term)),item=>item.detectedOn,item=>item.animalName),
      treatments:sorted(relatedTreatments.filter(({record,animal})=>[animal.name,record.medicineName,
        record.responsible,record.groupName,record.kind].join(' ').toLocaleLowerCase().includes(term)),
        item=>item.record.appliedOn,item=>item.animal.name),
      campaigns:sorted((campaigns??[]).filter(item=>[item.medicineName,item.responsible,item.groupName,
        item.kind,...item.animals.map(animal=>animal.name)].join(' ').toLocaleLowerCase().includes(term)),
        item=>item.appliedOn,item=>item.medicineName),
    };
  },[campaigns,conditions,relatedTreatments,search,order]);
  const selectedCondition=conditions.find(item=>item.id===selectedConditionId);
  const selectedCampaign=campaigns?.find(item=>item.id===selectedCampaignId);
  const treatmentRecord=campaigns?.find(item=>item.id===selectedTreatment?.campaignId);
  const treatmentAnimal=treatmentRecord?.animals.find(item=>item.animalId===selectedTreatment?.animalId);
  const dialogOpen=showMedicine||showCondition||showCampaign||Boolean(selectedCondition||selectedCampaign||treatmentAnimal);
  useEffect(()=>{if(!dialogOpen)return;
    const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!busy)closeDialogs();};
    window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);
  },[dialogOpen,busy]);
  function closeDialogs(){setShowMedicine(false);setShowCondition(false);setShowCampaign(false);
    setEditingCondition(null);setSelectedConditionId(null);setSelectedCampaignId(null);
    setSelectedTreatment(null);setEditing(null);}
  function openNew(){closeDialogs();reset();if(tab==='conditions')setShowCondition(true);
    else setShowCampaign(true);}
  function reset(){setEditing(null);setShowCampaign(false);setMedicineId('');setMode('MANUAL');
    setGroupId('');setSelected([]);setDoses({});setConditionIds({});}
  function edit(record:HealthCampaign){closeDialogs();setEditing(record);setShowCampaign(true);
    setMedicineId(record.medicineId);setMode(record.selectionMode);setGroupId(record.groupId??'');
    setSelected(record.animals.filter((animal)=>animal.selected).map((animal)=>animal.animalId));
    setDoses(Object.fromEntries(record.animals.map((animal)=>[animal.animalId,String(animal.dose)])));
    setConditionIds(Object.fromEntries(record.animals.map((animal)=>[animal.animalId,
      animal.conditionId??''])));
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
      treatmentCatalogItemId:String(data.get('treatmentCatalogItemId')||'')||null,
      defaultUnitCode:String(data.get('unit')),suggestedDose:String(data.get('suggestion')).trim()||null,
      indications:String(data.get('indications')).trim()||null,
      withdrawalMilkDays:Number(data.get('milkDays')),
      withdrawalMeatDays:Number(data.get('meatDays')),
    }),()=>setShowMedicine(false));
  }
  function saveCondition(event:FormEvent<HTMLFormElement>){event.preventDefault();
    const data=new FormData(event.currentTarget);
    const input={animalId:editingCondition?.animalId??String(data.get('animalId')),
      kind:String(data.get('kind')).trim(),
      detectedOn:String(data.get('date')),description:String(data.get('description')).trim(),
      ...(editingCondition?{expectedVersion:editingCondition.version}:{})};
    void run(()=>editingCondition?updateHealthCondition(accessToken,editingCondition.id,input)
      :createHealthCondition(accessToken,input),()=>{setShowCondition(false);setEditingCondition(null);});
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
        dose:Number(doses[id]??data.get('defaultDose')),unitCode:medicine.defaultUnitCode,
        conditionId:conditionIds[id]||null})),
      ...(editing?{expectedVersion:editing.version}:{})};
    if(individualTreatment){
      void run(async()=>{
        const draft=await createHealthCampaign(accessToken,input);
        try{await applyHealthCampaign(accessToken,draft.id);}
        catch(failure){reset();setRevision(value=>value+1);setTab('campaigns');
          throw new Error(`El tratamiento quedó como borrador: ${message(failure)}`);}
      },reset);
    }else void run(()=>editing?updateHealthCampaign(accessToken,editing.id,input)
      :createHealthCampaign(accessToken,input),reset);
  }
  return <section className="health-panel">
    <div className="health-toolbar"><label className="health-search"><span className="sr-only">Buscar en sanidad</span>
      <span aria-hidden="true">⌕</span><input type="search" value={search}
        placeholder="Buscar en sanidad…" onChange={event=>setSearch(event.target.value)}/></label>
      <span className="health-count" title="Registros encontrados">{visible[tab].length}</span>
      <button type="button" className="health-sort" aria-label="Cambiar orden"
        title={order==='NEWEST'?'Más recientes':order==='OLDEST'?'Más antiguos':order==='AZ'?'Nombre A–Z':'Nombre Z–A'}
        onClick={()=>setOrder(value=>value==='NEWEST'?'OLDEST':value==='OLDEST'?'AZ':value==='AZ'?'ZA':'NEWEST')}>↕</button>
      {canManage&&<><button className="secondary-button compact health-medicine-button" type="button"
        aria-label="Nuevo medicamento" title="Nuevo medicamento"
        onClick={()=>{closeDialogs();setShowMedicine(true);}}>+ Medicamento</button>
        <button className="primary-button compact health-add" type="button" onClick={openNew}>
          + {tab==='conditions'?'Condición':tab==='treatments'?'Tratamiento':'Jornada'}</button></>}
    </div>
    <div className="health-tabs" aria-label="Vistas de sanidad">
      <button type="button" className={tab==='conditions'?'active':''} aria-pressed={tab==='conditions'}
        onClick={()=>setTab('conditions')}>Condiciones de salud</button>
      <button type="button" className={tab==='treatments'?'active':''} aria-pressed={tab==='treatments'}
        onClick={()=>setTab('treatments')}>Tratamientos</button>
      <button type="button" className={tab==='campaigns'?'active':''} aria-pressed={tab==='campaigns'}
        onClick={()=>setTab('campaigns')}>Jornadas colectivas</button>
    </div>
    {error&&<div role="alert" className="form-error admin-error">{error}</div>}
    {canManage&&showCondition&&options&&<div className="health-overlay" role="presentation"
      onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)closeDialogs();}}>
      <div className="health-dialog" role="dialog" aria-modal="true" aria-label={editingCondition?'Editar condición':'Nueva condición de salud'}>
      <div className="health-dialog-heading"><h2>{editingCondition?'Editar condición':'Nueva condición de salud'}</h2>
        <button type="button" aria-label="Cerrar formulario" disabled={busy} onClick={closeDialogs}>×</button></div>
      {error&&<div className="form-error health-dialog-error" role="alert">{error}</div>}
      <form className="movement-form" onSubmit={saveCondition}
      key={editingCondition?.id??'condition-new'}>
      <label><span>Animal *</span><select name="animalId" required
        defaultValue={editingCondition?.animalId??initialAnimalId??''} disabled={Boolean(editingCondition)}>
        <option value="">Selecciona</option>{options.animals.map((animal)=><option
          key={animal.id} value={animal.id}>{animal.name}</option>)}</select></label>
      <label><span>Tipo de problema *</span><select name="kind" required
        defaultValue={editingCondition?.kind??''}><option value="">Selecciona</option>
        {editingCondition?.kind&&!conditionTypes.some(item=>item.name===editingCondition.kind)&&
          <option value={editingCondition.kind}>{editingCondition.kind} (anterior)</option>}
        {conditionTypes.filter(item=>item.active).map(item=><option key={item.id}
          value={item.name}>{item.name}</option>)}</select>
        <small>Puedes agregar tipos para todas tus propiedades desde Catálogos.</small></label>
      <label><span>Fecha de detección *</span><input name="date" type="date" required
        max={today()} defaultValue={editingCondition?.detectedOn??today()}/></label>
      <label className="movement-wide"><span>Descripción *</span><textarea name="description"
        required minLength={2} maxLength={2000} defaultValue={editingCondition?.description??''}/></label>
      <button className="primary-button compact" disabled={busy}>Guardar condición</button>
      </form></div></div>}
    {canManage&&showMedicine&&<div className="health-overlay" role="presentation"
      onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)closeDialogs();}}>
      <div className="health-dialog" role="dialog" aria-modal="true" aria-label="Nuevo medicamento">
      <div className="health-dialog-heading"><h2>Nuevo medicamento</h2>
        <button type="button" aria-label="Cerrar formulario" disabled={busy} onClick={closeDialogs}>×</button></div>
      {error&&<div className="form-error health-dialog-error" role="alert">{error}</div>}
      <form className="movement-form" onSubmit={saveMedicine}>
      <label><span>Nombre comercial *</span><input name="name" required minLength={2} maxLength={160}/></label>
      <label><span>Tipo *</span><select name="kind">{Object.entries(kinds).map(([code,label])=>
        <option key={code} value={code}>{label}</option>)}</select></label>
      <label><span>Tipo de tratamiento</span><select name="treatmentCatalogItemId">
        <option value="">Sin clasificar</option>{treatmentTypes.filter(item=>item.active).map(item=>
          <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        <small>Ej. antibiótico, analgésico o vitaminización. El tipo anterior indica el uso del medicamento.</small></label>
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
      </form></div></div>}
    {canManage&&showCampaign&&options&&<div className="health-overlay" role="presentation"
      onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)reset();}}>
      <div className="health-dialog" role="dialog" aria-modal="true" aria-label={editing?'Editar borrador':tab==='treatments'?'Nuevo tratamiento':'Nueva jornada sanitaria'}>
      <div className="health-dialog-heading"><h2>{editing?'Editar borrador':tab==='treatments'?'Nuevo tratamiento':'Nueva jornada sanitaria'}</h2>
        <button type="button" aria-label="Cerrar formulario" disabled={busy} onClick={reset}>×</button></div>
      {error&&<div className="form-error health-dialog-error" role="alert">{error}</div>}
      <form className="movement-form" onSubmit={saveCampaign}
      key={editing?.id??'new'}>
      <label><span>Medicamento *</span><select required value={medicineId}
        onChange={(event)=>setMedicineId(event.target.value)}><option value="">Selecciona</option>
        {medicines.filter((item)=>item.active).map((item)=><option key={item.id} value={item.id}>
          {item.name} · {kinds[item.kind]}</option>)}</select></label>
      <label><span>Vía *</span><select name="route" defaultValue={editing?.administrationRoute??'INTRAMUSCULAR'}>
        {Object.entries(routes).map(([code,label])=><option key={code} value={code}>{label}</option>)}</select></label>
      {!individualTreatment&&<label><span>Selección</span><select value={mode} onChange={(event)=>{
        setMode(event.target.value as HealthCampaignInput['selectionMode']);setSelected([]);setGroupId('');}}>
        <option value="MANUAL">Animales seleccionados</option><option value="GRUPO">Grupo completo</option>
        <option value="TODOS">Toda la propiedad</option></select></label>}
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
      <div className="movement-selection movement-wide"><strong>{individualTreatment?'Elige un animal':mode==='MANUAL'?'Elige animales':
        `${candidates.length} animales candidatos`}</strong>
        {mode==='MANUAL'&&!individualTreatment&&<button type="button" className="secondary-button compact"
          onClick={()=>setSelected(selected.length===candidates.length?[]:candidates.map((item)=>item.id))}>
          {selected.length===candidates.length?'Quitar selección':'Seleccionar todos'}</button>}
        <div className="movement-animal-grid">{candidates.map((animal)=><div key={animal.id}
          className="health-animal-row"><label>{mode==='MANUAL'&&<input type="checkbox"
            checked={selected.includes(animal.id)} onChange={(event)=>setSelected(event.target.checked
              ?individualTreatment?[animal.id]:[...selected,animal.id]:selected.filter((id)=>id!==animal.id))}/>}
            {animal.name}{animal.earTagCode?` · ${animal.earTagCode}`:''}</label>
            {selectedIds.includes(animal.id)&&<input type="number" min="0.001" max="1000000"
              step="any" aria-label={`Dosis de ${animal.name}`} placeholder="Dosis individual"
              value={doses[animal.id]??''} onChange={(event)=>setDoses({...doses,
                [animal.id]:event.target.value})}/>}
            {selectedIds.includes(animal.id)&&conditions.some((item)=>item.animalId===animal.id
              &&item.status!=='RESUELTA')&&<select aria-label={`Condición de ${animal.name}`}
              value={conditionIds[animal.id]??''} onChange={(event)=>setConditionIds({...conditionIds,
                [animal.id]:event.target.value})}>
              <option value="">Sin condición vinculada</option>
              {conditions.filter((item)=>item.animalId===animal.id&&item.status!=='RESUELTA')
                .map((item)=><option key={item.id} value={item.id}>{item.kind??item.description}</option>)}
            </select>}</div>)}</div>
      </div>
      <button className="primary-button compact" disabled={busy||!medicineId||!selectedIds.length
        ||individualTreatment&&selectedIds.length!==1
        ||selectedIds.length>500||mode==='GRUPO'&&!groupId}>
        {busy?'Guardando…':individualTreatment?'Registrar tratamiento':editing?'Guardar borrador':'Crear borrador'}</button>
      </form></div></div>}
    {loading?<p className="muted">Cargando registros sanitarios…</p>:<div className="health-record-list">
      {tab==='conditions'&&visible.conditions.map(condition=><button type="button" className="health-record-row"
        key={condition.id} onClick={()=>setSelectedConditionId(condition.id)}>
        <span className="health-record-avatar" aria-hidden="true">{condition.animalName.slice(0,1).toUpperCase()}</span>
        <span className="health-record-primary"><strong>{condition.animalName}</strong>
          <small>{condition.treatmentCount} {condition.treatmentCount===1?'tratamiento':'tratamientos'}</small></span>
        <span className="health-record-main"><strong>{condition.kind||'Otro problema'}</strong>
          <small>{condition.detectedOn} · {condition.description}</small></span>
        <span className={`health-badge health-${condition.status.toLowerCase()}`}>
          {condition.status==='RESUELTA'?'Resuelta':condition.status==='EN_TRATAMIENTO'?'En tratamiento':'Por resolver'}</span>
        <span className="health-chevron" aria-hidden="true">›</span></button>)}
      {tab==='treatments'&&visible.treatments.map(({record,animal})=><button type="button"
        className="health-record-row" key={`${record.id}:${animal.animalId}`}
        onClick={()=>setSelectedTreatment({campaignId:record.id,animalId:animal.animalId})}>
        <span className="health-record-avatar" aria-hidden="true">{animal.name.slice(0,1).toUpperCase()}</span>
        <span className="health-record-primary"><strong>{animal.name}</strong><small>{record.appliedOn}</small></span>
        <span className="health-record-main"><strong>{kinds[record.kind]} · {record.medicineName}</strong>
          <small>{animal.dose} {animal.unitCode} · {routes[record.administrationRoute]}</small></span>
        <span className="health-record-extra">{record.responsible||'Sin responsable'}</span>
        <span className="health-chevron" aria-hidden="true">›</span></button>)}
      {tab==='campaigns'&&<><div className="health-list-head" aria-hidden="true"><span>Jornada</span>
        <span>Fecha</span><span>Medicamento</span><span>Animales</span><span>Estado</span><span/></div>
        {visible.campaigns.map(record=><button type="button" className="health-campaign-row" key={record.id}
          onClick={()=>setSelectedCampaignId(record.id)}>
          <span><strong>{kinds[record.kind]}</strong><small>{routes[record.administrationRoute]}</small></span>
          <span>{record.appliedOn}</span><span><strong>{record.medicineName}</strong>
            <small>{record.responsible||'Sin responsable'}</small></span>
          <span>{record.animals.filter(animal=>animal.selected).length} seleccionados</span>
          <span className={`movement-status status-${record.status.toLowerCase()}`}>
            {record.status==='BORRADOR'?'Borrador':record.status==='COMPLETADO'?'Completado':'Cancelado'}</span>
          <span className="health-chevron" aria-hidden="true">›</span></button>)}</>}
      {!visible[tab].length&&<div className="health-empty">{search?'No hay registros con esa búsqueda.':
        tab==='conditions'?'Sin problemas de salud registrados.':tab==='treatments'?
          'Todavía no hay tratamientos aplicados.':'Todavía no hay jornadas sanitarias.'}</div>}
    </div>}
    {selectedCondition&&<div className="health-overlay" role="presentation"
      onMouseDown={event=>{if(event.target===event.currentTarget)setSelectedConditionId(null);}}>
      <div className="health-dialog" role="dialog" aria-modal="true" aria-labelledby="condition-detail-title">
        <div className="health-dialog-heading"><h2 id="condition-detail-title">Detalle de la condición de salud</h2>
          <button type="button" aria-label="Cerrar detalle" onClick={()=>setSelectedConditionId(null)}>×</button></div>
        {error&&<div className="form-error health-dialog-error" role="alert">{error}</div>}
        <div className="health-detail"><div className="health-detail-title"><span className="health-record-avatar">{selectedCondition.animalName.slice(0,1).toUpperCase()}</span>
          <div><h3>{selectedCondition.animalName}</h3><small>{selectedCondition.kind||'Otro problema'}</small></div>
          <span className={`health-badge health-${selectedCondition.status.toLowerCase()}`}>
            {selectedCondition.status==='RESUELTA'?'Resuelta':selectedCondition.status==='EN_TRATAMIENTO'?'En tratamiento':'Por resolver'}</span></div>
          <div className="health-detail-grid"><div><small>Detección</small><strong>{selectedCondition.detectedOn}</strong></div>
            <div><small>Tratamientos relacionados</small><strong>{selectedCondition.treatmentCount}</strong></div>
            {selectedCondition.resolvedOn&&<div><small>Resuelta</small><strong>{selectedCondition.resolvedOn}</strong></div>}</div>
          <p>{selectedCondition.description}</p>
          {relatedTreatments.filter(({animal})=>animal.conditionId===selectedCondition.id).map(({record,animal})=><button
            type="button" className="health-related" key={`${record.id}:${animal.animalId}`}
            onClick={()=>{setSelectedConditionId(null);setSelectedTreatment({campaignId:record.id,animalId:animal.animalId});}}>
            {record.medicineName} · {record.appliedOn} <span>›</span></button>)}
        </div><div className="health-dialog-actions"><button type="button" className="secondary-button compact"
          onClick={()=>setSelectedConditionId(null)}>Cerrar</button>
          {canManage&&selectedCondition.status!=='RESUELTA'&&<>
            <button type="button" className="secondary-button compact" onClick={()=>{
              closeDialogs();setEditingCondition(selectedCondition);setShowCondition(true);}}>Editar</button>
            <button type="button" className="secondary-button compact" onClick={()=>{
              closeDialogs();reset();setTab('treatments');setSelected([selectedCondition.animalId]);
              setConditionIds({[selectedCondition.animalId]:selectedCondition.id});setShowCampaign(true);
            }}>Aplicar tratamiento</button>
            <button type="button" className="primary-button compact" disabled={busy}
              onClick={()=>void run(()=>resolveHealthCondition(accessToken,selectedCondition.id,
                {resolvedOn:today(),expectedVersion:selectedCondition.version}))}>Marcar resuelta</button>
          </>}</div></div></div>}
    {treatmentRecord&&treatmentAnimal&&<div className="health-overlay" role="presentation"
      onMouseDown={event=>{if(event.target===event.currentTarget)setSelectedTreatment(null);}}>
      <div className="health-dialog" role="dialog" aria-modal="true" aria-labelledby="treatment-detail-title">
        <div className="health-dialog-heading"><h2 id="treatment-detail-title">Detalle del tratamiento</h2>
          <button type="button" aria-label="Cerrar detalle" onClick={()=>setSelectedTreatment(null)}>×</button></div>
        <div className="health-detail"><div className="health-detail-title"><span className="health-record-avatar">
          {treatmentAnimal.name.slice(0,1).toUpperCase()}</span><div><h3>{treatmentAnimal.name}</h3>
          <small>{kinds[treatmentRecord.kind]} · {treatmentRecord.medicineName}</small></div></div>
          <div className="health-detail-grid"><div><small>Dosis aplicada</small><strong>{treatmentAnimal.dose} {treatmentAnimal.unitCode}</strong></div>
            <div><small>Vía</small><strong>{routes[treatmentRecord.administrationRoute]}</strong></div>
            <div><small>Fecha</small><strong>{treatmentRecord.appliedOn}</strong></div>
            <div><small>Responsable</small><strong>{treatmentRecord.responsible||'Sin registrar'}</strong></div></div>
          {treatmentRecord.notes&&<p>{treatmentRecord.notes}</p>}
        </div><div className="health-dialog-actions"><button type="button" className="secondary-button compact"
          onClick={()=>setSelectedTreatment(null)}>Cerrar</button>
          <button type="button" className="primary-button compact" onClick={()=>{
            setSelectedTreatment(null);setSelectedCampaignId(treatmentRecord.id);}}>Ver jornada</button>
        </div></div></div>}
    {selectedCampaign&&<div className="health-overlay" role="presentation"
      onMouseDown={event=>{if(event.target===event.currentTarget)setSelectedCampaignId(null);}}>
      <div className="health-dialog" role="dialog" aria-modal="true" aria-labelledby="campaign-detail-title">
        <div className="health-dialog-heading"><h2 id="campaign-detail-title">Detalle de la jornada</h2>
          <button type="button" aria-label="Cerrar detalle" onClick={()=>setSelectedCampaignId(null)}>×</button></div>
        {error&&<div className="form-error health-dialog-error" role="alert">{error}</div>}
        <div className="health-detail"><div className="health-detail-title"><span className="health-detail-icon">✚</span>
          <div><h3>{kinds[selectedCampaign.kind]} · {selectedCampaign.medicineName}</h3>
            <small>{selectedCampaign.appliedOn}</small></div>
          <span className={`movement-status status-${selectedCampaign.status.toLowerCase()}`}>
            {selectedCampaign.status==='BORRADOR'?'Borrador':selectedCampaign.status==='COMPLETADO'?'Completado':'Cancelado'}</span></div>
          <div className="health-detail-grid"><div><small>Vía</small><strong>{routes[selectedCampaign.administrationRoute]}</strong></div>
            <div><small>Responsable</small><strong>{selectedCampaign.responsible||'Sin registrar'}</strong></div>
            <div><small>Animales</small><strong>{selectedCampaign.animals.filter(animal=>animal.selected).length}</strong></div>
            {selectedCampaign.groupName&&<div><small>Grupo</small><strong>{selectedCampaign.groupName}</strong></div>}</div>
          <details className="health-related-animals"><summary>Animales seleccionados</summary><div>
            {selectedCampaign.animals.filter(animal=>animal.selected).map(animal=><span key={animal.animalId}>
              {animal.name} · {animal.dose} {animal.unitCode}</span>)}</div></details>
          {selectedCampaign.notes&&<p>{selectedCampaign.notes}</p>}
        </div><div className="health-dialog-actions"><button type="button" className="secondary-button compact"
          onClick={()=>setSelectedCampaignId(null)}>Cerrar</button>
          {canManage&&selectedCampaign.status==='BORRADOR'&&<>
            <button type="button" className="secondary-button compact" disabled={busy}
              onClick={()=>void run(()=>cancelHealthCampaign(accessToken,selectedCampaign.id))}>Cancelar jornada</button>
            <button type="button" className="secondary-button compact" onClick={()=>edit(selectedCampaign)}>Editar</button>
            <button type="button" className="primary-button compact" disabled={busy}
              onClick={()=>void run(()=>applyHealthCampaign(accessToken,selectedCampaign.id))}>Aplicar</button>
          </>}</div></div></div>}
    {canManage&&<button type="button" className="health-fab" aria-label={`Nuevo ${tab==='conditions'?'problema de salud':tab==='treatments'?'tratamiento':'jornada'}`}
      onClick={openNew}>＋</button>}
  </section>;
}
