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

export function MovementPanel({accessToken,propertyId,canManage,canCancel}:{
  accessToken:string;propertyId:string;canManage:boolean;canCancel:boolean;
}){
  const [records,setRecords]=useState<MovementRecord[]|null>(null);
  const [options,setOptions]=useState<MovementOptions|null>(null);
  const [reasons,setReasons]=useState<CatalogItem[]>([]);
  const [revision,setRevision]=useState(0);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [formOpen,setFormOpen]=useState(false);
  const [editing,setEditing]=useState<MovementRecord|null>(null);
  const [kind,setKind]=useState<MovementRecord['kind']>('UBICACION');
  const [mode,setMode]=useState<MovementRecord['selectionMode']>('GRUPO');
  const [sourceGroupId,setSourceGroupId]=useState('');
  const [destinationPropertyId,setDestinationPropertyId]=useState(propertyId);
  const [destinationGroupId,setDestinationGroupId]=useState('');
  const [destinationLocationId,setDestinationLocationId]=useState('');
  const [selected,setSelected]=useState<string[]>([]);

  useEffect(()=>{let active=true;
    void Promise.all([getMovements(accessToken),getMovementOptions(accessToken)])
      .then(([movements,choices])=>{if(active){setRecords(movements);setOptions(choices);}})
      .catch((failure)=>{if(active)setError(message(failure));});
    return ()=>{active=false;};
  },[accessToken,revision]);
  useEffect(()=>{let active=true;void listCatalogItems(accessToken,'MOVEMENT_REASONS')
    .then(items=>{if(active)setReasons(items);}).catch(()=>{});return()=>{active=false;};},[accessToken]);
  const source=options?.groups.find((group)=>group.id===sourceGroupId);
  const cross=kind==='PROPIEDAD' || (kind==='COMBINADO'&&destinationPropertyId!==propertyId);
  const groupAnimals=useMemo(()=>options?.animals.filter((animal)=>animal.groupId===sourceGroupId)??[],
    [options,sourceGroupId]);
  const destinations=options?.groups.filter((group)=>group.propertyId===destinationPropertyId
    && (kind==='UBICACION'?group.id===sourceGroupId:group.id!==sourceGroupId))??[];
  const locations=options?.locations.filter((location)=>location.propertyId===propertyId
    && location.id!==source?.locationId
    && !options.groups.some((group)=>group.locationId===location.id))??[];
  function reset(){setEditing(null);setFormOpen(false);setKind('UBICACION');setMode('GRUPO');
    setSourceGroupId('');setDestinationPropertyId(propertyId);setDestinationGroupId('');
    setDestinationLocationId('');setSelected([]);}
  function beginEdit(movement:MovementRecord){
    setEditing(movement);setFormOpen(true);setKind(movement.kind);setMode(movement.selectionMode);
    setSourceGroupId(movement.sourceGroupId);setDestinationPropertyId(movement.destinationPropertyId);
    setDestinationGroupId(movement.destinationGroupId);
    setDestinationLocationId(movement.destinationLocationId??'');
    setSelected(movement.animals.map((item)=>item.id));window.scrollTo({top:0,behavior:'smooth'});
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
  return <section className="section-block movements-panel">
    <div className="section-heading"><div><span className="eyebrow">Operaciones</span>
      <h2>Movimientos</h2><p className="muted">Borradores y traslados de la propiedad activa. El historial se conserva.</p></div>
      {canManage&&<button className="primary-button compact" type="button"
        onClick={()=>formOpen?reset():setFormOpen(true)}>{formOpen?'Cerrar':'+ Movimiento'}</button>}
    </div>
    {error&&<div role="alert" className="form-error admin-error">{error}</div>}
    {!records&&!error&&<p className="muted">Cargando movimientos…</p>}
    {canManage&&formOpen&&options&&<form className="movement-form" onSubmit={save}
      key={editing?.id??'new'}>
      <h3>{editing?'Editar borrador':'Nuevo movimiento'}</h3>
      <label><span>Tipo *</span><select value={kind} onChange={(event)=>{
        const next=event.target.value as MovementRecord['kind'];setKind(next);
        if(next==='UBICACION'){setMode('GRUPO');setDestinationPropertyId(propertyId);
          setDestinationGroupId(sourceGroupId);} else if(next==='GRUPO')setDestinationPropertyId(propertyId);
        else if(next==='PROPIEDAD')setDestinationPropertyId(
          options.properties.find((property)=>property.id!==propertyId)?.id??'');
        setDestinationLocationId('');}}>
        {Object.entries(kinds).filter(([value])=>value!=='COMBINADO'||editing?.kind==='COMBINADO')
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
        {!groupAnimals.length&&<p className="muted">El grupo de origen no tiene animales activos.</p>}
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
        || !sourceGroupId || !groupAnimals.length || mode==='MANUAL'&&!selected.length
        || kind!=='UBICACION'&&!destinationGroupId || kind==='UBICACION'&&!destinationLocationId
        || kind==='PROPIEDAD'&&!cross}>
        {busy?'Guardando…':editing?'Guardar borrador':'Crear borrador'}</button>
        {editing&&<button type="button" className="secondary-button compact" onClick={reset}>Cancelar edición</button>}
      </div>
    </form>}
    <div className="movement-list">
      <h3>Historial y borradores</h3>
      {records?.length===0&&<p className="muted">Todavía no hay movimientos en esta propiedad.</p>}
      {records?.map((movement)=><details key={movement.id} className="movement-card record-row">
        <summary>
        <div className="movement-card-top"><div><strong>{kinds[movement.kind]}</strong>
          <small>{movement.movementOn} · {movement.animals.length} {movement.animals.length===1?'animal':'animales'}</small></div>
          <span className={`movement-status status-${movement.status.toLowerCase()}`}>
            {movement.status==='BORRADOR'?'Borrador':movement.status==='COMPLETADO'?'Completado':'Cancelado'}</span></div>
        <p><b>{movement.sourcePropertyName}</b> · {movement.sourceGroupName}
          {movement.sourceLocationName?` (${movement.sourceLocationName})`:''} → <b>{movement.destinationPropertyName}</b> · {movement.destinationGroupName}
          {movement.destinationLocationName?` (${movement.destinationLocationName})`:''}</p></summary>
        <small>{movement.reason}</small>
        {movement.notes&&<p>{movement.notes}</p>}
        <div>{movement.animals.map((animal)=><span
          key={animal.id} className="movement-animal-name">{animal.name}</span>)}</div>
        {movement.status==='BORRADOR'&&movement.sourcePropertyId===propertyId&&
          <div className="movement-actions">
            {canManage&&<><button type="button" className="secondary-button compact" disabled={busy}
              onClick={()=>beginEdit(movement)}>Editar</button><button type="button" className="primary-button compact"
              disabled={busy} onClick={()=>void run(()=>applyMovement(accessToken,movement.id))}>Aplicar</button></>}
            {canCancel&&<button type="button" className="secondary-button compact" disabled={busy}
              onClick={()=>void run(()=>cancelMovement(accessToken,movement.id))}>Cancelar borrador</button>}
          </div>}
      </details>)}
    </div>
  </section>;
}
