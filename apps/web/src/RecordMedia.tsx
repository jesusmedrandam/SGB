import {useEffect,useState} from 'react';
import {ApiRequestError,deleteMedia,getMedia,uploadMedia,type MediaItem} from './api';

export function RecordMedia({accessToken,entityType,entityId,canManage}:{accessToken:string;
  entityType:string;entityId:string;canManage:boolean}){
  const [photos,setPhotos]=useState<MediaItem[]>([]);
  const [file,setFile]=useState<File|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [revision,setRevision]=useState(0);
  useEffect(()=>{let active=true;void getMedia(accessToken,entityType,entityId)
    .then(rows=>{if(active)setPhotos(rows);})
    .catch(failure=>{if(active)setError(failure instanceof Error?failure.message:'No se pudieron cargar las fotos.');});
    return()=>{active=false;};},[accessToken,entityType,entityId,revision]);
  async function execute(action:()=>Promise<unknown>){setBusy(true);setError(null);
    try{await action();setFile(null);setRevision(current=>current+1);}
    catch(failure){setError(failure instanceof ApiRequestError?failure.message:'No se pudo guardar la foto.');}
    finally{setBusy(false);}}
  return <section className="record-photos" aria-label="Fotos de la limpieza">
    <h4>Fotos de la limpieza <small>{photos.length}/3</small></h4>
    {error&&<p className="form-error" role="alert">{error}</p>}
    {photos.length>0&&<div className="record-photo-grid">{photos.map(photo=><div key={photo.id}>
      <a href={photo.url} target="_blank" rel="noreferrer"><img src={photo.thumbnailUrl??photo.url}
        alt="Foto de la limpieza" loading="lazy"/></a>
      {canManage&&<button type="button" className="secondary-button compact" disabled={busy}
        onClick={()=>{if(window.confirm('¿Eliminar esta foto?'))void execute(()=>deleteMedia(accessToken,photo.id));}}>
        Eliminar</button>}</div>)}</div>}
    {canManage&&photos.length<3&&<div className="record-photo-add">
      <input type="file" accept="image/jpeg,image/png,image/webp,image/heic" aria-label="Foto de la limpieza"
        onChange={event=>setFile(event.target.files?.[0]??null)}/>
      <button type="button" className="secondary-button compact" disabled={!file||busy}
        onClick={()=>{if(file)void execute(()=>uploadMedia(accessToken,{file,entityType,entityId}));}}>
        {busy?'Procesando…':'Agregar foto'}</button></div>}
    {!photos.length&&!canManage&&<p className="muted">No hay fotos de esta limpieza.</p>}
  </section>;
}
