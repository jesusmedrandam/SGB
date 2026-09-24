import {type FormEvent,useEffect,useMemo,useState} from 'react';
import {ApiRequestError,applyMovement,cancelMovement,createMovement,getMovementOptions,
  getMovements,listCatalogItems,updateMovement,type CatalogItem,type MovementInput,type MovementOptions,type MovementRecord} from './api';

const kinds:Record<MovementRecord['kind'],string>={
  UBICACION:'Cambiar potrero o corral',GRUPO:'Cambiar grupo',
  PROPIEDAD:'Trasladar a otra propiedad',COMBINADO:'Traslado combinado anterior',
};
const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const message=(error:unknown)=>error instanceof ApiRequestError ? error.message
  : error instanceof Error ? error.message : 'No se pudo gestionar el movimiento.';
function routeSide(record:MovementRecord,side:'source'|'destination'){
  const group=side==='source'?record.sourceGroupName:record.destinationGroupName;
  const location=side==='source'?record.sourceLocationName:record.destinationLocationName;
  const property=side==='source'?record.sourcePropertyName:record.destinationPropertyName;
  if(record.kind==='UBICACION')return location||group;
  const groupAndLocation=group+(location?` (${location})`:'');
  return record.kind==='GRUPO'?groupAndLocation:`${property} · ${groupAndLocation}`;
}

export function MovementPanel({accessToken,propertyId,canManage,canCancel,canChangeLocation,initialAnimalId}:{
  accessToken:string;propertyId:string;canManage:boolean;canCancel:boolean;canChangeLocation:boolean;
  initialAnimalId?:string|undefined;
}){
  const [records,setRecords]=useState<MovementRecord[]|null>(null);
  const [options,setOptions]=useState<MovementOptions|null>(null);
  const [reasons,setReasons]=useState<CatalogItem[]>([]);
  const [revision,setRevision]=useState(0);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [formOpen,setFormOpen]=useState(false);
  const [editing,setEditing]=useState<MovementRecord|null>(null);
  const [viewingId,setViewingId]=useState<string|null>(null);
  const [search,setSearch]=useState('');
  const [order,setOrder]=useState<'NEWEST'|'OLDEST'|'AZ'|'ZA'>('NEWEST');
  const [kind,setKind]=useState<MovementRecord['kind']>(canChangeLocation?'UBICACION':'GRUPO');
  const [mode,setMode]=useState<MovementRecord['selectionMode']>('GRUPO');
  const [sourceGroupId,setSourceGroupId]=useState('');
  const [destinationPropertyId,setDestinationPropertyId]=useState(propertyId);
  const [destinationGroupId,setDestinationGroupId]=useState('');
  const [destinationLocationId,setDestinationLocationId]=useState('');
  const [selected,setSelected]=useState<string[]>([]);
  const [prefilledAnimalId,setPrefilledAnimalId]=useState<string|null>(null);
  useEffect(()=>{if(!initialAnimalId||initialAnimalId===prefilledAnimalId||!options||!canManage)return;
    const animal=options.animals.find(item=>item.id===initialAnimalId);
    if(animal?.groupId){setKind('GRUPO');setSourceGroupId(animal.groupId);setMode('MANUAL');setSelected([animal.id]);
      setDestinationGroupId('');setDestinationLocationId('');setFormOpen(true);setPrefilledAnimalId(animal.id);}
  },[initialAnimalId,prefilledAnimalId,options?.animals,canManage]);

  useEffect(()=>{let active=true;
    void getMovements(accessToken).then(movements=>{if(active){setRecords(movements);setError(null);}})
      .catch((failure)=>{if(active)setError(message(failure));});
    return ()=>{active=false;};
  },[accessToken,revision]);
  useEffect(()=>{if(!canManage)return;let active=true;
    void getMovementOptions(accessToken).then(choices=>{if(active)setOptions(choices);})
      .catch(failure=>{if(active)setError(message(failure));});
    return()=>{active=false;};},[accessToken,revision,canManage]);
  useEffect(()=>{if(!canManage)return;let active=true;void listCatalogItems(accessToken,'MOVEMENT_REASONS')
    .then(items=>{if(active)setReasons(items);}).catch(()=>{});return()=>{active=false;};},[accessToken,canManage]);
  const source=options?.groups.find((group)=>group.id===sourceGroupId);
  const cross=kind==='PROPIEDAD' || (kind==='COMBINADO'&&destinationPropertyId!==propertyId);
  const groupAnimals=useMemo(()=>options?.animals.filter((animal)=>animal.groupId===sourceGroupId)??[],
    [options,sourceGroupId]);
  const destinations=options?.groups.filter((group)=>group.propertyId===destinationPropertyId
    && (kind==='UBICACION'?group.id===sourceGroupId:group.id!==sourceGroupId))??[];
  const locations=options?.locations.filter((location)=>location.propertyId===propertyId
    && location.id!==source?.locationId
    && !options.groups.some((group)=>group.locationId===location.id))??[];
  const visible=useMemo(()=>{
    const term=search.trim().toLocaleLowerCase();
    const rows=(records??[]).filter(item=>[item.reason,item.sourceGroupName,item.destinationGroupName,
      item.sourceLocationName,item.destinationLocationName,item.sourcePropertyName,
      item.destinationPropertyName,...item.animals.map(animal=>animal.name)].join(' ')
      .toLocaleLowerCase().includes(term));
    return rows.sort((a,b)=>order==='AZ'||order==='ZA'
      ? (order==='AZ'?1:-1)*a.reason.localeCompare(b.reason,'es')
      : (order==='NEWEST'?-1:1)*a.movementOn.localeCompare(b.movementOn));
  },[records,search,order]);
  const viewing=records?.find(item=>item.id===viewingId);
  useEffect(()=>{if(!formOpen&&!viewing)return;
    const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!busy){
      if(formOpen)reset();else setViewingId(null);
    }};
    window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);
  },[formOpen,viewing,busy]);
  function reset(){setEditing(null);setFormOpen(false);setKind(canChangeLocation?'UBICACION':'GRUPO');setMode('GRUPO');
    setSourceGroupId('');setDestinationPropertyId(propertyId);setDestinationGroupId('');
    setDestinationLocationId('');setSelected([]);}
  function beginEdit(movement:MovementRecord){
    setViewingId(null);setEditing(movement);setFormOpen(true);setKind(movement.kind);setMode(movement.selectionMode);
    setSourceGroupId(movement.sourceGroupId);setDestinationPropertyId(movement.destinationPropertyId);
    setDestinationGroupId(movement.destinationGroupId);
    setDestinationLocationId(movement.destinationLocationId??'');
    setSelected(movement.animals.map((item)=>item.id));
  }
  async function run(operation:()=>Promise<unknown>,onSuccess?:()=>void){
    setBusy(true);setError(null);
    try{await operation();onSuccess?.();setRevision((value)=>value+1);}
    catch(failure){setError(message(failure));window.scrollTo({top:0,behavior:'smooth'});}
    finally{setBusy(false);}
  }
  function save(event:FormEvent<HTMLFormElement>){event.preventDefault();const data=new FormData(event.currentTarget);
    const input:MovementInput={kind,selectionMode:mode,sourceGroupId,
      destinationPropertyId:kind==='PROPIEDAD'||kind==='COMBINADO'?destinationPropertyId:propertyId,
      destinationGroupId:kind==='UBICACION'?sourceGroupId:destinationGroupId,
      destinationLocationId:kind==='UBICACION'?destinationLocationId:null,
      movementOn:String(data.get('movementOn')),reason:String(data.get('reason')).trim(),
      notes:String(data.get('notes')).trim()||null,
      animalIds:mode==='GRUPO'?groupAnimals.map((animal)=>animal.id):selected,
      ...(editing?{expectedVersion:editing.version}:{})};
    void run(()=>editing?updateMovement(accessToken,editing.id,input):createMovement(accessToken,input),reset);
  }
  return <section className="movements-panel">
    <div className="movement-toolbar"><label className="movement-search"><span className="sr-only">Buscar movimiento</span>
      <span aria-hidden="true">⌕</span><input type="search" placeholder="Buscar movimiento…"
        value={search} onChange={event=>setSearch(event.target.value)}/></label>
      <span className="movement-count" title="Movimientos encontrados">{visible.length}</span>
      <button type="button" className="movement-sort" aria-label="Cambiar orden" title={order==='NEWEST'?'Más recientes':order==='OLDEST'?'Más antiguos':order==='AZ'?'Motivo A–Z':'Motivo Z–A'}
        onClick={()=>setOrder(value=>value==='NEWEST'?'OLDEST':value==='OLDEST'?'AZ':value==='AZ'?'ZA':'NEWEST')}>↕</button>
      {canManage&&<button className="movement-add primary-button compact" type="button"
        onClick={()=>{reset();setFormOpen(true);}}>+ Movimiento</button>}
    </div>
    {error&&<div role="alert" className="form-error admin-error">{error}</div>}
    {!records&&!error&&<p className="muted">Cargando movimientos…</p>}
    {canManage&&formOpen&&options&&<div className="movement-overlay" role="presentation"
      onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)reset();}}>
      <div className="movement-dialog" role="dialog" aria-modal="true" aria-label={editing?'Editar borrador':'Nuevo movimiento'}>
      <div className="movement-dialog-heading"><h2>{editing?'Editar borrador':'Nuevo movimiento'}</h2>
        <button type="button" onClick={reset} disabled={busy} aria-label="Cerrar formulario">×</button></div>
      {error&&<div role="alert" className="form-error movement-dialog-error">{error}</div>}
      <form className="movement-form" onSubmit={save}
      key={editing?.id??'new'}>
      <label><span>Tipo *</span><select value={kind} onChange={(event)=>{
        const next=event.target.value as MovementRecord['kind'];setKind(next);
        if(next==='UBICACION'){setMode('GRUPO');setDestinationPropertyId(propertyId);
          setDestinationGroupId(sourceGroupId);} else if(next==='GRUPO')setDestinationPropertyId(propertyId);
        else if(next==='PROPIEDAD')setDestinationPropertyId(
          options.properties.find((property)=>property.id!==propertyId)?.id??'');
        setDestinationLocationId('');}}>
        {Object.entries(kinds).filter(([value])=>
          (value!=='UBICACION'||canChangeLocation)&&(value!=='COMBINADO'||editing?.kind==='COMBINADO'))
          .map(([value,label])=><option key={value} value={value}>{label}</option>)}
      </select></label>
      <label><span>Grupo de origen *</span><select value={sourceGroupId} required onChange={(event)=>{
        const id=event.target.value;setSourceGroupId(id);setSelected([]);
        setDestinationGroupId(kind==='UBICACION'?id:'');setDestinationLocationId('');}}>
        <option value="">Selecciona el grupo primero</option>
        {options.groups.filter((group)=>group.propertyId===propertyId).map((group)=><option
          key={group.id} value={group.id}>{group.name}{group.locationName?` · ${group.locationName}`:''}</option>)}
      </select></label>
      {(kind==='PROPIEDAD'||kind==='COMBINADO')&&<label><span>Propiedad de destino *</span>
        <select value={destinationPropertyId} required onChange={(event)=>{
          setDestinationPropertyId(event.target.value);setDestinationGroupId('');}}>
          {options.properties.filter((property)=>kind!=='PROPIEDAD'||property.id!==propertyId)
            .map((property)=><option key={property.id} value={property.id}>{property.name}</option>)}
        </select><small>Solo aparecen propiedades de la misma cuenta donde puedes gestionar movimientos.</small>
      </label>}
      {kind==='UBICACION'?<label><span>Potrero o corral de destino *</span>
        <select value={destinationLocationId} required onChange={(event)=>setDestinationLocationId(event.target.value)}>
          <option value="">Elige una ubicación diferente</option>
          {locations.map((location)=><option key={location.id} value={location.id}>
            {location.name} · {location.kind==='PASTURE'?'Potrero':'Corral'}</option>)}
        </select><small>La rotación mueve todos los animales del grupo.</small></label>
        :<label><span>Grupo de destino *</span>
          <select value={destinationGroupId} required onChange={(event)=>setDestinationGroupId(event.target.value)}>
            <option value="">Selecciona el grupo de destino</option>
            {destinations.map((group)=><option key={group.id} value={group.id}>
              {group.name}{group.locationName?` · ${group.locationName}`:''}</option>)}
          </select><small>La ubicación se toma del grupo de destino.</small></label>}
      {kind!=='UBICACION'&&<label><span>Selección</span><select value={mode}
        onChange={(event)=>setMode(event.target.value as MovementRecord['selectionMode'])}>
          <option value="GRUPO">Grupo completo</option><option value="MANUAL">Animales seleccionados</option>
        </select></label>}
      <label><span>Fecha *</span><input type="date" name="movementOn" required max={today()}
        defaultValue={editing?.movementOn??today()}/></label>
      <label className="movement-wide"><span>Motivo *</span><input name="reason" list="movement-reasons" required
        minLength={2} maxLength={300} defaultValue={editing?.reason??''}
        placeholder="Selecciona o escribe un motivo"/>
        <datalist id="movement-reasons">{reasons.filter(item=>item.active).map(item=><option
          key={item.id} value={item.name}/>)}</datalist></label>
      <label className="movement-wide"><span>Observaciones</span>
        <textarea name="notes" maxLength={5000} defaultValue={editing?.notes??''}/></label>
      {sourceGroupId&&<div className="movement-selection movement-wide">
        <strong>{mode==='GRUPO'?`Grupo completo · ${groupAnimals.length} animales`:'Selecciona los animales del grupo'}</strong>
        {!groupAnimals.length&&<p className="muted">El grupo no tiene animales activos. Puedes asignar su primera ubicación.</p>}
        {mode==='MANUAL'&&<><button type="button" className="secondary-button compact"
          onClick={()=>setSelected(selected.length===groupAnimals.length?[]:groupAnimals.map((animal)=>animal.id))}>
          {selected.length===groupAnimals.length?'Quitar selección':'Seleccionar todos'}</button>
          <div className="movement-animal-grid">{groupAnimals.map((animal)=><label key={animal.id}>
            <input type="checkbox" checked={selected.includes(animal.id)} onChange={(event)=>setSelected(
              event.target.checked?[...selected,animal.id]:selected.filter((id)=>id!==animal.id))}/>
            <span>{animal.name}{animal.earTagCode?` · ${animal.earTagCode}`:''}</span></label>)}</div>
        </>}
      </div>}
      <div className="movement-actions movement-wide"><button className="primary-button compact" disabled={busy
        || !sourceGroupId || kind!=='UBICACION'&&!groupAnimals.length || mode==='MANUAL'&&!selected.length
        || kind!=='UBICACION'&&!destinationGroupId || kind==='UBICACION'&&!destinationLocationId
        || kind==='PROPIEDAD'&&!cross}>
        {busy?'Guardando…':editing?'Guardar borrador':'Crear borrador'}</button>
        {editing&&<button type="button" className="secondary-button compact" onClick={reset}>Cancelar edición</button>}
      </div>
      </form></div></div>}
    {records&&<div className="movement-record-list">
      <div className="movement-list-head" aria-hidden="true"><span>Movimiento</span><span>Fecha</span>
        <span>Origen y destino</span><span>Estado</span><span/></div>
      {visible.map(movement=><button type="button" className="movement-list-row" key={movement.id}
        onClick={()=>setViewingId(movement.id)}>
        <span className="movement-list-title"><strong>{movement.reason||kinds[movement.kind]}</strong>
          <small>{movement.animals.length} {movement.animals.length===1?'animal':'animales'} · {kinds[movement.kind]}</small></span>
        <span>{movement.movementOn}</span>
        <span className="movement-list-route">↔ {routeSide(movement,'source')} → {routeSide(movement,'destination')}</span>
        <span><span className={`movement-status status-${movement.status.toLowerCase()}`}>
          {movement.status==='BORRADOR'?'Borrador':movement.status==='COMPLETADO'?'Completado':'Cancelado'}</span></span>
        <span className="movement-list-chevron" aria-hidden="true">›</span>
      </button>)}
      {!visible.length&&<div className="movement-list-empty">{records.length
        ?'No hay movimientos con esa búsqueda.':'Aún no hay movimientos en esta propiedad.'}</div>}
    </div>}
    {viewing&&<div className="movement-overlay" role="presentation"
      onMouseDown={event=>{if(event.target===event.currentTarget)setViewingId(null);}}>
      <div className="movement-dialog" role="dialog" aria-modal="true" aria-labelledby="movement-detail-title">
        <div className="movement-dialog-heading"><h2 id="movement-detail-title">Detalle del movimiento</h2>
          <button type="button" onClick={()=>setViewingId(null)} aria-label="Cerrar detalle">×</button></div>
        {error&&<div role="alert" className="form-error movement-dialog-error">{error}</div>}
        <div className="movement-detail">
          <div className="movement-detail-title"><span className="movement-detail-icon">↔</span>
            <div><h3>{viewing.reason||kinds[viewing.kind]}</h3><small>{viewing.movementOn} · {kinds[viewing.kind]}</small></div>
            <span className={`movement-status status-${viewing.status.toLowerCase()}`}>
              {viewing.status==='BORRADOR'?'Borrador':viewing.status==='COMPLETADO'?'Completado':'Cancelado'}</span></div>
          <div className="movement-detail-route"><div><small>Origen</small><strong>{viewing.sourcePropertyName}</strong>
            <span>{viewing.sourceGroupName}{viewing.sourceLocationName?` · ${viewing.sourceLocationName}`:''}</span></div>
            <div><small>Destino</small><strong>{viewing.destinationPropertyName}</strong>
              <span>{viewing.destinationGroupName}{viewing.destinationLocationName?` · ${viewing.destinationLocationName}`:''}</span></div></div>
          <details className="movement-detail-animals"><summary>Animales implicados ({viewing.animals.length})</summary>
            <div>{viewing.animals.map(animal=><span key={animal.id}>{animal.name}</span>)}</div></details>
          {viewing.notes&&<div className="movement-detail-notes"><strong>Observaciones</strong><p>{viewing.notes}</p></div>}
        </div>
        <div className="movement-dialog-actions"><button type="button" className="secondary-button compact"
          onClick={()=>setViewingId(null)}>Cerrar</button>
          {viewing.status==='BORRADOR'&&viewing.sourcePropertyId===propertyId&&<>
            {canCancel&&<button type="button" className="secondary-button compact" disabled={busy}
              onClick={()=>void run(()=>cancelMovement(accessToken,viewing.id))}>Cancelar movimiento</button>}
            {canManage&&(viewing.kind!=='UBICACION'||canChangeLocation)&&<><button type="button" className="secondary-button compact" disabled={busy}
              onClick={()=>beginEdit(viewing)}>Editar</button><button type="button" className="primary-button compact"
                disabled={busy} onClick={()=>void run(()=>applyMovement(accessToken,viewing.id))}>Aplicar</button></>}
          </>}
        </div>
      </div>
    </div>}
    {canManage&&<button type="button" className="movement-fab" aria-label="Nuevo movimiento"
      onClick={()=>{reset();setFormOpen(true);}}>＋</button>}
  </section>;
}
