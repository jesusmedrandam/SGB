import {useEffect,useMemo,useState,type FormEvent} from 'react';
import {ApiRequestError,deleteMediaObject,getAnimals,getMedia,getMediaUsage,
  listCatalogItems,uploadMedia,type Animal,type CatalogItem,type MediaItem,type MediaUsage} from './api';
const message=(error:unknown)=>error instanceof ApiRequestError?error.message:'No se pudo completar la operación.';
const size=(bytes:number)=>`${(bytes/1048576).toFixed(1)} MiB`;
export function MediaPanel({accessToken,permissions}:{accessToken:string;permissions:string[]}){
  const [items,setItems]=useState<MediaItem[]>([]);
  const [usage,setUsage]=useState<MediaUsage|null>(null);
  const [tags,setTags]=useState<CatalogItem[]>([]);
  const [animals,setAnimals]=useState<Animal[]>([]);
  const [search,setSearch]=useState('');
  const [animalError,setAnimalError]=useState<string|null>(null);
  const [chosen,setChosen]=useState<Array<{id:string;name:string}>>([]);
  const [selectedTags,setSelectedTags]=useState<string[]>([]);
  const [file,setFile]=useState<File|null>(null);
  const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
  const [revision,setRevision]=useState(0);
  const [detail,setDetail]=useState<string|null>(null);
  useEffect(()=>{let active=true;void Promise.all([getMedia(accessToken),getMediaUsage(accessToken)])
    .then(([media,quota])=>{if(active){setItems(media);setUsage(quota);}})
    .catch(e=>{if(active)setError(message(e));});return()=>{active=false;};},[accessToken,revision]);
  useEffect(()=>{if(!permissions.includes('CATALOG_VIEW'))return;let active=true;
    void listCatalogItems(accessToken,'MEDIA_TAGS').then(data=>{if(active)setTags(data);})
      .catch(e=>{if(active)setError(message(e));});return()=>{active=false;};},[accessToken,permissions.join(',')]);
  useEffect(()=>{if(!permissions.includes('ANIMAL_VIEW'))return;let active=true;
    const timer=setTimeout(()=>{void getAnimals(accessToken,1,search.trim()).then(page=>{
      if(active){setAnimals(page.items);setAnimalError(null);}
    }).catch(e=>{if(active)setAnimalError(message(e));});},220);
    return()=>{active=false;clearTimeout(timer);};},[accessToken,search,revision,permissions.join(',')]);
  const gallery=useMemo(()=>{
    const grouped=new Map<string,MediaItem[]>();
    for(const item of items){const row=grouped.get(item.storage_object_id)??[];
      row.push(item);grouped.set(item.storage_object_id,row);}
    return [...grouped.entries()].map(([id,attachments])=>({id,attachments,main:attachments[0]!}));
  },[items]);
  function choose(animal:Animal){setChosen(prev=>prev.some(item=>item.id===animal.id)
    ?prev.filter(item=>item.id!==animal.id):[...prev,{id:animal.id,name:animal.name}]);}
  async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();if(!file||!chosen.length)return;
    const form=event.currentTarget;const data=new FormData(form);setBusy(true);setError(null);
    try{await uploadMedia(accessToken,{file,animalIds:chosen.map(item=>item.id),tagIds:selectedTags,
      description:String(data.get('description')||'').trim(),capturedOn:String(data.get('capturedOn')||'')});
      setFile(null);setChosen([]);setSelectedTags([]);form.reset();setRevision(n=>n+1);
    }catch(e){setError(message(e));}finally{setBusy(false);}}
  async function remove(id:string){if(!window.confirm('¿Eliminar esta foto o video y sus relaciones?'))return;
    setBusy(true);setError(null);try{const result=await deleteMediaObject(accessToken,id);
      if(!result.deletedFromProvider)setError('La relación se quitó. Cloudinary no confirmó la eliminación; queda pendiente para reintento.');
      setDetail(null);setRevision(n=>n+1);
    }catch(e){setError(message(e));}finally{setBusy(false);}}
  return <section className="section-block media-panel">
    <div className="section-heading"><div><span className="eyebrow">Galería</span><h2>Multimedia</h2>
      <p className="muted">Cada foto o video puede pertenecer a varios animales de esta propiedad.</p></div>
      {usage&&<small>Espacio de la cuenta: {size(usage.storedBytes)} / {size(usage.limitBytes)}</small>}</div>
    {error&&<div className="form-error" role="alert">{error}</div>}
    {permissions.includes('MEDIA_MANAGE')&&<details className="media-upload-panel">
      <summary>+ Agregar foto o video</summary><form onSubmit={submit} className="movement-form">
        <label className="movement-wide"><span>Archivo *</span><input type="file" required
          accept="image/jpeg,image/png,image/webp,image/heic,video/*"
          onChange={event=>setFile(event.target.files?.[0]??null)}/></label>
        <div className="movement-wide"><label><span>Buscar animales *</span><input value={search}
          placeholder="Escribe nombre, arete o marquilla" onChange={event=>setSearch(event.target.value)}/></label>
          {animalError&&<small role="alert" className="form-error">{animalError}</small>}
          <div className="media-animal-results">{animals.map(animal=><label key={animal.id}>
            <input type="checkbox" checked={chosen.some(item=>item.id===animal.id)}
              onChange={()=>choose(animal)}/><span>{animal.name}{animal.earTagCode?` · ${animal.earTagCode}`:''}</span>
          </label>)}{!animalError&&animals.length===0&&<small>No hay animales con esa búsqueda en la propiedad activa.</small>}</div>
          {chosen.length>0&&<div className="media-chosen"><strong>Seleccionados:</strong> {chosen.map(item=><button
            key={item.id} type="button" onClick={()=>setChosen(chosen.filter(a=>a.id!==item.id))}>
            {item.name} ×</button>)}</div>}</div>
        <label><span>Fecha de toma</span><input type="date" name="capturedOn"/></label>
        <label className="movement-wide"><span>Descripción</span><textarea name="description" maxLength={2000}/></label>
        <fieldset className="media-tags movement-wide"><legend>Etiquetas</legend>
          {tags.filter(tag=>tag.active).map(tag=><label key={tag.id}><input type="checkbox"
            checked={selectedTags.includes(tag.id)} onChange={event=>setSelectedTags(event.target.checked
              ?[...selectedTags,tag.id]:selectedTags.filter(id=>id!==tag.id))}/>{tag.name}</label>)}
          {!tags.length&&<small>Agrega etiquetas en Catálogos si las necesitas.</small>}</fieldset>
        <button className="primary-button compact" type="submit" disabled={busy||!file||!chosen.length}>
          {busy?'Procesando archivo…':'Guardar en la galería'}</button>
        <small className="movement-wide">El servidor comprime el archivo y elimina metadatos de ubicación y cámara.</small>
      </form></details>}
    {gallery.length===0?<p className="muted">Aún no hay fotos ni videos en esta propiedad.</p>:
      <div className="media-grid">{gallery.map(({id,main,attachments})=><article
        className="media-card" key={id}>
        <button className="media-open" type="button" onClick={()=>setDetail(detail===id?null:id)}>
          {main.kind==='IMAGE'?<img src={main.thumbnailUrl??main.url} loading="lazy" alt={main.description||'Foto de animales'}/>:
            <video src={main.url} preload="metadata" muted/>}
          <span className="media-kind">{main.kind==='VIDEO'?'▶ Video':'▣ Foto'}</span>
          <span className="media-date">{main.captured_on??new Date(main.created_at).toLocaleDateString()}</span>
        </button>
        <div><strong>{attachments.filter(item=>item.entity_type==='ANIMAL').map(item=>item.entity_name)
          .filter(Boolean).join(', ')||'Registro de la propiedad'}</strong>
          <small>{size(main.byteSize)}{main.description?` · ${main.description}`:''}</small></div>
        {detail===id&&<div className="media-detail">
          {main.kind==='IMAGE'?<a href={main.url} target="_blank" rel="noreferrer">Abrir imagen completa ↗</a>:
            <video src={main.url} controls preload="metadata"/>}
          {main.description&&<p>{main.description}</p>}
          {main.tags.length>0&&<p>Etiquetas: {main.tags.map(tag=>tag.name).join(', ')}</p>}
          {permissions.includes('MEDIA_MANAGE')&&<button type="button" className="secondary-button compact"
            disabled={busy} onClick={()=>void remove(id)}>Eliminar archivo</button>}
        </div>}
      </article>)}</div>}
  </section>;
}
