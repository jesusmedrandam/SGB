import {useEffect,useState,type FormEvent} from 'react';
import {ApiRequestError,deleteMedia,getActivities,getAnimals,getCleanings,getHealthCampaigns,
  getMedia,getMediaUsage,getMovements,getReproduction,uploadMedia,
  type MediaItem,type MediaUsage} from './api';

type Target={type:string;id:string;label:string};
const labels:Record<string,string>={ANIMAL:'Animal',LIVESTOCK_MOVEMENT:'Movimiento',
  HEALTH_CAMPAIGN:'Jornada sanitaria',CLEANING:'Limpieza',LIVESTOCK_ACTIVITY:'Actividad',
  REPRODUCTION_HEAT:'Celo',REPRODUCTION_SERVICE:'Servicio',
  REPRODUCTION_PREGNANCY:'Preñez',REPRODUCTION_BIRTH:'Parto',REPRODUCTION_LOSS:'Pérdida'};
function message(error:unknown){return error instanceof ApiRequestError?error.message:'Ocurrió un error inesperado.';}
function size(bytes:number){return `${(bytes/1048576).toFixed(1)} MiB`;}
export function MediaPanel({accessToken,modules,permissions}:{accessToken:string;modules:string[];
  permissions:string[]}){
  const [items,setItems]=useState<MediaItem[]>([]);
  const [usage,setUsage]=useState<MediaUsage|null>(null);
  const [targets,setTargets]=useState<Target[]>([]);
  const [selected,setSelected]=useState('');const [file,setFile]=useState<File|null>(null);
  const [animalSearch,setAnimalSearch]=useState('');
  const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
  const [revision,setRevision]=useState(0);
  useEffect(()=>{let active=true;
    void Promise.all([getMedia(accessToken),getMediaUsage(accessToken)]).then(([media,quota])=>{
      if(active){setItems(media);setUsage(quota);}
    }).catch(e=>{if(active)setError(message(e));});return()=>{active=false;};
  },[accessToken,revision]);
  useEffect(()=>{let active=true;
    const jobs:Array<Promise<Target[]>>=[];
    if(permissions.includes('ANIMAL_VIEW'))jobs.push(getAnimals(accessToken,1,animalSearch).then(r=>
      r.items.map(a=>({type:'ANIMAL',id:a.id,label:`Animal · ${a.name}${a.earTagCode?` (${a.earTagCode})`:''}`}))));
    if(modules.includes('MOVEMENTS')&&permissions.includes('MOVEMENT_VIEW'))jobs.push(
      getMovements(accessToken).then(r=>r.map(m=>({type:'LIVESTOCK_MOVEMENT',id:m.id,
        label:`Movimiento · ${m.movementOn}`}))));
    if(modules.includes('HEALTH')&&permissions.includes('HEALTH_VIEW'))jobs.push(
      getHealthCampaigns(accessToken).then(r=>r.map(m=>({type:'HEALTH_CAMPAIGN',id:m.id,
        label:`Sanidad · ${m.medicineName} · ${m.appliedOn}`}))));
    if(modules.includes('PASTURE_CLEANING')&&permissions.includes('CLEANING_VIEW'))jobs.push(
      getCleanings(accessToken).then(r=>r.map(m=>({type:'CLEANING',id:m.id,
        label:`Limpieza · ${m.locationName} · ${m.startedOn}`}))));
    if(modules.includes('TASKS')&&permissions.includes('ACTIVITY_VIEW'))jobs.push(
      getActivities(accessToken).then(r=>r.map(m=>({type:'LIVESTOCK_ACTIVITY',id:m.id,
        label:`Actividad · ${m.title}`}))));
    if(modules.includes('REPRODUCTION')&&permissions.includes('REPRODUCTION_VIEW'))jobs.push(
      getReproduction(accessToken).then(r=>[
        ...r.heats.map(m=>({type:'REPRODUCTION_HEAT',id:m.id,label:`Celo · ${m.cowName}`})),
        ...r.services.map(m=>({type:'REPRODUCTION_SERVICE',id:m.id,label:`Servicio · ${m.cowName}`})),
        ...r.pregnancies.map(m=>({type:'REPRODUCTION_PREGNANCY',id:m.id,label:`Preñez · ${m.cowName}`})),
        ...r.births.map(m=>({type:'REPRODUCTION_BIRTH',id:m.id,label:`Parto · ${m.motherName}`})),
        ...r.losses.map(m=>({type:'REPRODUCTION_LOSS',id:m.id,label:`Pérdida · ${m.cowName}`})),
      ]));
    void Promise.allSettled(jobs).then(results=>{if(active)setTargets(results.flatMap(result=>
      result.status==='fulfilled'?result.value:[]));});return()=>{active=false;};
  },[accessToken,modules.join(','),permissions.join(','),animalSearch]);
  async function submit(event:FormEvent){event.preventDefault();if(!selected||!file)return;
    const [type,id]=selected.split(':');setBusy(true);setError(null);
    try{await uploadMedia(accessToken,type!,id!,file);setFile(null);setRevision(n=>n+1);}
    catch(e){setError(message(e));}finally{setBusy(false);}}
  async function remove(id:string){if(!window.confirm('¿Quitar este adjunto de la galería?'))return;
    setBusy(true);setError(null);try{await deleteMedia(accessToken,id);setRevision(n=>n+1);}
    catch(e){setError(message(e));}finally{setBusy(false);}}
  return <section className="section-block media-panel">
    <div className="section-heading"><div><span className="eyebrow">Archivos</span><h2>Multimedia</h2>
      <p className="muted">Fotos y videos vinculados a animales y registros de esta propiedad.</p></div>
      {usage&&<small>Cuenta: {size(usage.storedBytes)} de {size(usage.limitBytes)}</small>}</div>
    {error&&<div className="form-error" role="alert">{error}</div>}
    {permissions.includes('MEDIA_MANAGE')&&<form className="movement-form" onSubmit={submit}>
      {permissions.includes('ANIMAL_VIEW')&&<label><span>Buscar animal</span><input
        value={animalSearch} onChange={e=>setAnimalSearch(e.target.value)}
        placeholder="Nombre o número de marquilla"/></label>}
      <label><span>Asociar a</span><select required value={selected} onChange={e=>setSelected(e.target.value)}>
        <option value="">Selecciona un registro</option>{targets.map(target=><option
          key={`${target.type}:${target.id}`} value={`${target.type}:${target.id}`}>{target.label}</option>)}
      </select></label>
      <label><span>Imagen o video</span><input type="file" accept="image/*,video/*" required
        onChange={e=>setFile(e.target.files?.[0]??null)}/></label>
      <button className="primary-button compact" disabled={busy||!selected||!file} type="submit">
        {busy?'Procesando…':'Subir archivo'}</button>
      <small>Imágenes hasta 20 MiB de entrada; videos hasta 120 MiB y 5 minutos. Se eliminan los metadatos.</small>
    </form>}
    {items.length===0?<p className="muted">Todavía no hay archivos en esta propiedad.</p>:
      <div className="media-grid">{items.map(item=><article className="media-card" key={item.id}>
        {item.kind==='IMAGE'?<a href={item.url} target="_blank" rel="noreferrer">
          <img src={item.thumbnailUrl??item.url} loading="lazy" alt={`Adjunto de ${labels[item.entity_type]||item.entity_type}`}/></a>:
          <video src={item.url} controls preload="metadata"/>}
        <div><strong>{labels[item.entity_type]||item.entity_type}</strong>
          <small>{size(item.byteSize)} · {new Date(item.created_at).toLocaleDateString()}</small>
          {permissions.includes('MEDIA_MANAGE')&&<button type="button" disabled={busy}
            onClick={()=>void remove(item.id)}>Quitar</button>}</div>
      </article>)}</div>}
  </section>;
}
