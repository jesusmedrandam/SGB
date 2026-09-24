import {type FormEvent,useEffect,useState} from 'react';
import {ApiRequestError,applyActivity,cancelActivity,createActivity,getActivities,
  getActivityOptions,updateActivity,type ActivityInput,type ActivityOptions,
  type ActivityRecord} from './api';

const kinds={HERRAJE:'Herraje',DESCORNE:'Descorne',OTRA:'Otra actividad'};
const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const message=(error:unknown)=>error instanceof ApiRequestError?error.message:
  error instanceof Error?error.message:'No fue posible guardar la actividad.';
export function ActivityPanel({accessToken,canManage}:{accessToken:string;canManage:boolean}){
  const [records,setRecords]=useState<ActivityRecord[]|null>(null);
  const [options,setOptions]=useState<ActivityOptions|null>(null);
  const [revision,setRevision]=useState(0);
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [formOpen,setFormOpen]=useState(false);
  const [editing,setEditing]=useState<ActivityRecord|null>(null);
  const [kind,setKind]=useState<ActivityInput['kind']>('OTRA');
  const [brandId,setBrandId]=useState('');
  const [selected,setSelected]=useState<string[]>([]);
  useEffect(()=>{let active=true;void Promise.all([getActivities(accessToken),
    getActivityOptions(accessToken)]).then(([items,choices])=>{
    if(active){setRecords(items);setOptions(choices);}
  }).catch((failure)=>{if(active)setError(message(failure));});return ()=>{active=false;};
  },[accessToken,revision]);
  function reset(){setEditing(null);setFormOpen(false);setKind('OTRA');setBrandId('');setSelected([]);}
  function edit(item:ActivityRecord){setEditing(item);setFormOpen(true);setKind(item.kind);
    setBrandId(item.brandId??'');setSelected(item.animals.map((animal)=>animal.id));
    window.scrollTo({top:0,behavior:'smooth'});}
  async function run(action:()=>Promise<unknown>,done?:()=>void){setBusy(true);setError(null);
    try{await action();done?.();setRevision((value)=>value+1);}
    catch(failure){setError(message(failure));window.scrollTo({top:0,behavior:'smooth'});}
    finally{setBusy(false);}}
  function save(event:FormEvent<HTMLFormElement>){event.preventDefault();const data=new FormData(event.currentTarget);
    const input:ActivityInput={kind,title:String(data.get('title')).trim(),
      occurredOn:String(data.get('date')),description:String(data.get('description')).trim()||null,
      brandId:kind==='HERRAJE'?brandId:null,animalIds:selected,
      ...(editing?{expectedVersion:editing.version}:{})};
    void run(()=>editing?updateActivity(accessToken,editing.id,input)
      :createActivity(accessToken,input),reset);}
  return <section className="section-block activity-panel">
    <div className="section-heading"><div><span className="eyebrow">Operaciones</span>
      <h2>Actividades de animales</h2><p className="muted">Registra herrajes, descornes y otras labores.
        Los borradores se aplican una sola vez y se conserva su historial.</p></div>
      {canManage&&<button type="button" className="primary-button compact"
        onClick={()=>formOpen?reset():setFormOpen(true)}>{formOpen?'Cerrar':'+ Actividad'}</button>}
    </div>
    {error&&<div role="alert" className="form-error admin-error">{error}</div>}
    {canManage&&formOpen&&options&&<form className="movement-form" onSubmit={save}
      key={editing?.id??'new'}><h3>{editing?'Editar borrador':'Nueva actividad'}</h3>
      <label><span>Tipo *</span><select value={kind} onChange={(event)=>{
        setKind(event.target.value as ActivityInput['kind']);setBrandId('');}}>
        {Object.entries(kinds).map(([code,label])=><option key={code} value={code}>{label}</option>)}
      </select></label>
      {kind==='HERRAJE'&&<label><span>Marquilla aplicada *</span><select value={brandId}
        required onChange={(event)=>setBrandId(event.target.value)}><option value="">Selecciona</option>
        {options.brands.map((brand)=><option key={brand.id} value={brand.id}>{brand.name}</option>)}
      </select><small>Las marquillas se registran por separado en Animales.</small></label>}
      <label><span>Título *</span><input name="title" required maxLength={180} minLength={2}
        defaultValue={editing?.title??''} placeholder="Ej. Descorne de terneros"/></label>
      <label><span>Fecha *</span><input name="date" type="date" required max={today()}
        defaultValue={editing?.occurredOn??today()}/></label>
      <label className="movement-wide"><span>Descripción</span><textarea name="description"
        maxLength={5000} defaultValue={editing?.description??''}/></label>
      <div className="movement-selection movement-wide"><strong>Animales ({selected.length})</strong>
        <button type="button" className="secondary-button compact" onClick={()=>setSelected(
          selected.length===options.animals.length?[]:options.animals.map((animal)=>animal.id))}>
          {selected.length===options.animals.length?'Quitar selección':'Seleccionar todos'}</button>
        <div className="movement-animal-grid">{options.animals.map((animal)=><label key={animal.id}>
          <input type="checkbox" checked={selected.includes(animal.id)} onChange={(event)=>setSelected(
            event.target.checked?[...selected,animal.id]:selected.filter((id)=>id!==animal.id))}/>
          <span>{animal.name}{animal.earTagCode?` · ${animal.earTagCode}`:''}</span>
        </label>)}</div></div>
      <button className="primary-button compact" disabled={busy||!selected.length||selected.length>500
        ||kind==='HERRAJE'&&!brandId}>{editing?'Guardar borrador':'Crear borrador'}</button>
    </form>}
    <div className="movement-list"><h3>Actividades e historial</h3>
      {!records&&!error&&<p className="muted">Cargando actividades…</p>}
      {records?.length===0&&<p className="muted">Aún no hay actividades registradas.</p>}
      {records?.map((item)=><details className="movement-card record-row" key={item.id}>
        <summary>
        <div className="movement-card-top"><div><strong>{item.title}</strong>
          <small>{kinds[item.kind]} · {item.occurredOn} · {item.animals.length} animales</small></div>
          <span className={`movement-status status-${item.status.toLowerCase()}`}>
            {item.status==='BORRADOR'?'Borrador':item.status==='COMPLETADA'?'Completada':'Cancelada'}</span></div></summary>
        {item.brandName&&<p>Marquilla: {item.brandName}</p>}
        {item.description&&<p>{item.description}</p>}
        <div>{item.animals.map((animal)=><span
          key={animal.id} className="movement-animal-name">{animal.name}</span>)}</div>
        {canManage&&item.status==='BORRADOR'&&<div className="movement-actions">
          <button className="secondary-button compact" type="button" disabled={busy}
            onClick={()=>edit(item)}>Editar</button>
          <button className="primary-button compact" type="button" disabled={busy}
            onClick={()=>void run(()=>applyActivity(accessToken,item.id))}>Aplicar</button>
          <button className="secondary-button compact" type="button" disabled={busy}
            onClick={()=>void run(()=>cancelActivity(accessToken,item.id))}>Cancelar</button></div>}
      </details>)}</div>
  </section>;
}
