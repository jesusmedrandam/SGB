import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {v2 as cloudinary} from 'cloudinary';
import sharp from 'sharp';
import type {PoolClient} from 'pg';
import {env} from '../../config.js';
import {conflict,forbidden,invalidRequest,ApiError} from '../../core/errors.js';
import {pool} from '../../database/pool.js';
import {inTransaction} from '../../database/transaction.js';
import type {AuthState,PropertyContext} from '../auth/auth.types.js';

// Only explicitly mapped records can receive attachments. Each lookup checks the active property.
const targets:Record<string,{table:string;property:string;module:string;permission:string;condition?:string}>={
  ANIMAL:{table:'animal',property:'property_id',module:'CORE',permission:'ANIMAL_VIEW',condition:"record_status <> 'PURGED'"},
  PROPERTY:{table:'property',property:'id',module:'CORE',permission:'MODULE_VIEW',condition:'deleted_at IS NULL'},
  REPRODUCTION_HEAT:{table:'reproduction_heat',property:'property_id',module:'REPRODUCTION',permission:'REPRODUCTION_VIEW'},
  REPRODUCTION_SERVICE:{table:'reproduction_service',property:'property_id',module:'REPRODUCTION',permission:'REPRODUCTION_VIEW'},
  REPRODUCTION_PREGNANCY:{table:'reproduction_pregnancy',property:'property_id',module:'REPRODUCTION',permission:'REPRODUCTION_VIEW'},
  REPRODUCTION_BIRTH:{table:'reproduction_birth',property:'property_id',module:'REPRODUCTION',permission:'REPRODUCTION_VIEW'},
  REPRODUCTION_LOSS:{table:'reproduction_loss',property:'property_id',module:'REPRODUCTION',permission:'REPRODUCTION_VIEW'},
  MILK_LACTATION:{table:'milk_lactation',property:'property_id',module:'PRODUCTION',permission:'PRODUCTION_VIEW'},
  MILK_PRODUCTION:{table:'milk_production',property:'property_id',module:'PRODUCTION',permission:'PRODUCTION_VIEW'},
  MILK_TANK_PRODUCTION:{table:'milk_tank_production',property:'property_id',module:'PRODUCTION',permission:'PRODUCTION_VIEW'},
  LIVESTOCK_MOVEMENT:{table:'livestock_movement',property:'source_property_id',module:'MOVEMENTS',permission:'MOVEMENT_VIEW'},
  HEALTH_CAMPAIGN:{table:'health_campaign',property:'property_id',module:'HEALTH',permission:'HEALTH_VIEW'},
  CLEANING:{table:'pasture_cleaning',property:'property_id',module:'PASTURE_CLEANING',permission:'CLEANING_VIEW'},
  LIVESTOCK_ACTIVITY:{table:'livestock_activity',property:'property_id',module:'TASKS',permission:'ACTIVITY_VIEW'},
};
function configured(){
  if(!env.CLOUDINARY_CLOUD_NAME||!env.CLOUDINARY_API_KEY||!env.CLOUDINARY_API_SECRET)
    throw new ApiError(503,'CLOUDINARY_NOT_CONFIGURED','Configura Cloudinary en el servidor para cargar multimedia.');
  cloudinary.config({cloud_name:env.CLOUDINARY_CLOUD_NAME,api_key:env.CLOUDINARY_API_KEY,
    api_secret:env.CLOUDINARY_API_SECRET,secure:true});
}
async function account(client:PoolClient,propertyId:string){
  const result=await client.query<{account_id:string}>(
    'SELECT account_id FROM property WHERE id=$1 AND deleted_at IS NULL AND status=$2',[propertyId,'ACTIVE']);
  if(!result.rows[0])throw invalidRequest('PROPERTY_UNAVAILABLE','La propiedad ya no está disponible.');
  return result.rows[0].account_id;
}
export async function validateTarget(client:PoolClient,context:PropertyContext,type:string,id:string){
  const target=targets[type];
  if(!target)throw invalidRequest('MEDIA_TARGET_INVALID','Tipo de registro multimedia no admitido.');
  if(target.module!=='CORE'&&!context.enabledModules.has(target.module))
    throw forbidden('MODULE_DISABLED','El módulo de este registro no está activo.');
  if(!context.permissions.has(target.permission))
    throw forbidden('PERMISSION_DENIED','Tu rol no tiene acceso a este registro.');
  const result=await client.query(`SELECT 1 FROM ${target.table} WHERE id=$1 AND ${target.property}=$2
    ${target.condition?`AND ${target.condition}`:''}`,[id,context.propertyId]);
  if(!result.rowCount)throw invalidRequest('MEDIA_TARGET_NOT_FOUND','El registro no pertenece a esta propiedad.');
}
function run(binary:string,args:string[],timeout=180000):Promise<string>{
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,args,{stdio:['ignore','pipe','pipe']});let stdout='';let stderr='';
    const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
    child.stdout.on('data',(part:Buffer)=>{stdout+=part.toString().slice(0,2000);});
    child.stderr.on('data',(part:Buffer)=>{stderr=(stderr+part.toString()).slice(-3000);});
    child.on('error',()=>{clearTimeout(timer);reject(new ApiError(503,'VIDEO_PROCESSOR_UNAVAILABLE','El procesador de video no está disponible.'));});
    child.on('close',(code)=>{clearTimeout(timer);code===0?resolve(stdout):reject(invalidRequest('INVALID_VIDEO',`No se pudo procesar el video: ${stderr.slice(-160)}`));});
  });
}
async function canonicalize(input:Buffer,kind:'IMAGE'|'VIDEO'){
  if(kind==='IMAGE'){
    try{
      const processor=sharp(input,{limitInputPixels:40000000,failOn:'error'}).rotate().resize({width:2560,height:2560,fit:'inside',withoutEnlargement:true});
      const data=await processor.webp({quality:82}).toBuffer();
      if(data.length>5*1024*1024)throw invalidRequest('IMAGE_TOO_LARGE','La imagen procesada supera 5 MiB.');
      const meta=await sharp(data).metadata();
      return {data,mime:'image/webp',width:meta.width!,height:meta.height!,durationMs:null};
    }catch(error){if(error instanceof ApiError)throw error;throw invalidRequest('INVALID_IMAGE','La imagen está dañada o no es compatible.');}
  }
  const dir=await mkdtemp(join(tmpdir(),'sgb-media-'));
  try{
    const source=join(dir,'entrada');const output=join(dir,'salida.mp4');
    await writeFile(source,input,{mode:0o600});
    const probe=JSON.parse(await run('ffprobe',['-v','error','-show_entries','format=duration','-of','json',source],20000)) as {format?:{duration?:string}};
    const duration=Number(probe.format?.duration);
    if(!Number.isFinite(duration)||duration<=0||duration>300)
      throw invalidRequest('INVALID_VIDEO','El video debe durar como máximo 5 minutos.');
    await run('ffmpeg',['-nostdin','-v','error','-i',source,'-map','0:v:0','-map','0:a:0?','-map_metadata','-1',
      '-map_chapters','-1','-vf','scale=1280:720:force_original_aspect_ratio=decrease',
      '-c:v','libx264','-preset','fast','-crf','28','-c:a','aac','-b:a','96k',
      '-t','300','-fs',String(95*1024*1024),'-movflags','+faststart',output]);
    const data=await readFile(output);
    if(!data.length||data.length>95*1024*1024)throw invalidRequest('VIDEO_TOO_LARGE','El video procesado supera 95 MiB.');
    return {data,mime:'video/mp4',width:null,height:null,durationMs:Math.round(duration*1000)};
  }finally{await rm(dir,{recursive:true,force:true});}
}
function upload(data:Buffer,key:string,kind:'IMAGE'|'VIDEO'){
  configured();
  return new Promise<{public_id:string;bytes:number;secure_url:string}>((resolve,reject)=>{
    const stream=cloudinary.uploader.upload_stream({public_id:key,resource_type:kind==='VIDEO'?'video':'image',
      overwrite:false,unique_filename:false},(error,result)=>{
      if(error||!result)reject(new ApiError(502,'CLOUDINARY_UPLOAD_FAILED','Cloudinary rechazó el archivo.'));
      else resolve(result);
    });
    stream.on('error',()=>reject(new ApiError(502,'CLOUDINARY_UPLOAD_FAILED','No se pudo enviar el archivo.')));
    stream.end(data);
  });
}
function url(publicId:string,kind:string){configured();return cloudinary.url(publicId,{secure:true,
  resource_type:kind==='VIDEO'?'video':'image',type:'upload'});}
export async function listMedia(context:PropertyContext,type?:string,id?:string){
  if(type&&id)await inTransaction(client=>validateTarget(client,context,type,id));
  const visible=Object.entries(targets).filter(([,target])=>context.permissions.has(target.permission)
    && (target.module==='CORE'||context.enabledModules.has(target.module))).map(([code])=>code);
  if(!visible.length)return [];
  const rows=await pool.query<{id:string;storage_object_id:string;entity_type:string;entity_id:string;
    relation_code:string;description:string|null;captured_on:string|null;
    entity_name:string|null;tags:Array<{id:string;name:string}>;
    kind:string;byte_size:string;created_at:string;provider_asset_id:string}>(`
    SELECT ma.id,ma.storage_object_id,ma.entity_type,ma.entity_id,ma.relation_code,
      ma.description,ma.captured_on::text,animal.name AS entity_name,
      COALESCE((SELECT json_agg(json_build_object('id',tag.id,'name',tag.name) ORDER BY tag.name)
        FROM media_attachment_tag mat JOIN governed_catalog_item tag ON tag.id=mat.tag_id
        WHERE mat.attachment_id=ma.id),'[]'::json) AS tags,
      so.kind,so.byte_size,ma.created_at,so.provider_asset_id FROM media_attachment ma
    JOIN storage_object so ON so.id=ma.storage_object_id AND so.status='AVAILABLE'
    LEFT JOIN animal ON animal.id=ma.entity_id AND ma.entity_type='ANIMAL'
    WHERE ma.property_id=$1 AND ma.deleted_at IS NULL AND ma.entity_type=ANY($4::varchar[])
      AND ($2::varchar IS NULL OR ma.entity_type=$2) AND ($3::uuid IS NULL OR ma.entity_id=$3)
    ORDER BY COALESCE(ma.captured_on,ma.created_at::date) DESC,ma.created_at DESC LIMIT 500`,
    [context.propertyId,type??null,id??null,visible]);
  return rows.rows.map(({provider_asset_id,...row})=>({...row,byteSize:Number(row.byte_size),
    url:url(provider_asset_id,row.kind),
    thumbnailUrl:row.kind==='IMAGE'?cloudinary.url(provider_asset_id,{secure:true,
      width:512,height:512,crop:'limit',quality:'auto',fetch_format:'auto'}):null}));
}
export async function usage(context:PropertyContext){
  const result=await pool.query(`SELECT c.stored_bytes,c.reserved_bytes,q.limit_value
    FROM property p JOIN account_media_storage_commitment c ON c.account_id=p.account_id
    JOIN effective_account_quota q ON q.account_id=p.account_id AND q.quota_code='MEDIA_STORAGE_BYTES'
    WHERE p.id=$1`,[context.propertyId]);
  const row=result.rows[0];return {storedBytes:Number(row.stored_bytes),reservedBytes:Number(row.reserved_bytes),limitBytes:Number(row.limit_value)};
}
export async function addMedia(auth:AuthState,context:PropertyContext,type:string,id:string,
  relation:string,kind:'IMAGE'|'VIDEO',input:Buffer,options:{extraAnimalIds?:string[];
  description?:string|null;capturedOn?:string|null;tagIds?:string[]}={}){
  const ids=[id,...(options.extraAnimalIds??[])];
  if(new Set(ids).size!==ids.length||ids.length>100||ids.length>1&&type!=='ANIMAL')
    throw invalidRequest('MEDIA_ANIMALS_INVALID','Selecciona animales distintos de la misma propiedad.');
  if((relation==='PROFILE'||relation==='COVER')&&(kind!=='IMAGE'||type!=='ANIMAL'||ids.length!==1))
    throw invalidRequest('MEDIA_ROLE_INVALID','La foto de perfil o portada corresponde a un solo animal.');
  if(type==='CLEANING'&&(kind!=='IMAGE'||relation!=='GENERAL'))
    throw invalidRequest('CLEANING_MEDIA_INVALID','Las limpiezas admiten únicamente fotos.');
  if(!input.length||input.length>(kind==='IMAGE'?20:120)*1024*1024)
    throw invalidRequest('MEDIA_SIZE_INVALID','El archivo supera el límite de entrada.');
  const canonical=await canonicalize(input,kind);
  const digest=createHash('sha256').update(canonical.data).digest('hex');
  const reservationId=randomUUID();let accountId='';let reused:string|null=null;
  await inTransaction(async client=>{
    for(const targetId of ids)await validateTarget(client,context,type,targetId);
    accountId=await account(client,context.propertyId);
    if(options.tagIds?.length){
      const tags=await client.query(`SELECT id FROM governed_catalog_item
        WHERE id=ANY($1::uuid[]) AND catalog_code='MEDIA_TAGS' AND active AND deleted_at IS NULL
        AND (system_defined OR account_id=$2)`,[options.tagIds,accountId]);
      if(tags.rowCount!==options.tagIds.length)throw invalidRequest('MEDIA_TAG_INVALID','Selecciona etiquetas disponibles de esta cuenta.');
    }
    await client.query('SELECT id FROM administrative_account WHERE id=$1 FOR UPDATE',[accountId]);
    const existing=await client.query<{id:string}>(`SELECT id FROM storage_object WHERE account_id=$1 AND sha256=$2
      AND byte_size=$3 AND status IN ('AVAILABLE','TRASHED')`,[accountId,digest,canonical.data.length]);
    if(existing.rows[0]){reused=existing.rows[0].id;return;}
    const q=await client.query<{committed_bytes:string;limit_value:string}>(`SELECT c.committed_bytes,q.limit_value
      FROM account_media_storage_commitment c JOIN effective_account_quota q
      ON q.account_id=c.account_id AND q.quota_code='MEDIA_STORAGE_BYTES' WHERE c.account_id=$1`,[accountId]);
    const quota=q.rows[0];
    if(!quota)throw invalidRequest('QUOTA_UNAVAILABLE','No se encontró la cuota de la cuenta.');
    if(BigInt(quota.committed_bytes)+BigInt(canonical.data.length)>BigInt(quota.limit_value))
      throw new ApiError(413,'QUOTA_EXCEEDED','La cuenta superó su cuota multimedia.');
    await client.query(`INSERT INTO media_quota_reservation(id,account_id,property_id,idempotency_key,
      reserved_bytes,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '30 minutes')`,
    [reservationId,accountId,context.propertyId,randomUUID(),canonical.data.length,auth.userId]);
  });
  const key=`sgb/${accountId}/${randomUUID()}`;
  let uploaded=false;
  try{
    if(!reused){await upload(canonical.data,key,kind);uploaded=true;}
    const result=await inTransaction(async client=>{
      for(const targetId of ids)await validateTarget(client,context,type,targetId);
      await client.query('SELECT id FROM administrative_account WHERE id=$1 FOR UPDATE',[accountId]);
      if(type==='CLEANING'){
        const count=await client.query<{count:string}>(`SELECT count(*)::text AS count FROM media_attachment
          WHERE entity_type='CLEANING' AND entity_id=$1 AND property_id=$2 AND deleted_at IS NULL`,
          [id,context.propertyId]);
        const duplicate=await client.query(`SELECT 1 FROM media_attachment WHERE entity_type='CLEANING'
          AND entity_id=$1 AND property_id=$2 AND storage_object_id=$3 AND deleted_at IS NULL`,
          [id,context.propertyId,reused]);
        if(Number(count.rows[0]!.count)>=3&&!duplicate.rowCount)
          throw invalidRequest('CLEANING_PHOTO_LIMIT','Cada limpieza admite hasta tres fotos.');
      }
      let objectId:string;
      if(reused){objectId=reused;
        const existing=await client.query<{status:string}>(`SELECT status FROM storage_object
          WHERE id=$1 AND account_id=$2 FOR UPDATE`,[objectId,accountId]);
        if(!['AVAILABLE','TRASHED'].includes(existing.rows[0]?.status??''))
          throw conflict('MEDIA_OBJECT_CHANGED','El archivo cambió mientras se procesaba. Reintenta.');
        await client.query(`UPDATE storage_object SET status='AVAILABLE',trashed_at=NULL,purge_after=NULL
          WHERE id=$1 AND status='TRASHED'`,[objectId]);
      }
      else{
        const object=await client.query<{id:string}>(`INSERT INTO storage_object(account_id,origin_property_id,
          provider,provider_asset_id,storage_key,sha256,kind,mime_type,byte_size,width,height,
          duration_ms,status,created_by) VALUES($1,$2,'CLOUDINARY',$3,$3,$4,$5,$6,$7,$8,$9,$10,'AVAILABLE',$11)
          RETURNING id`,[accountId,context.propertyId,key,digest,kind,canonical.mime,canonical.data.length,
          canonical.width,canonical.height,canonical.durationMs,auth.userId]);
        objectId=object.rows[0]!.id;
        await client.query(`UPDATE media_quota_reservation SET status='CONSUMED',storage_object_id=$2,
          completed_at=now() WHERE id=$1`,[reservationId,objectId]);
      }
      const attachmentIds:string[]=[];
      for(const targetId of ids){
        const attached=await client.query<{id:string}>(`INSERT INTO media_attachment(account_id,storage_object_id,
          property_id,entity_type,entity_id,relation_code,created_by,description,captured_on)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (storage_object_id,entity_type,entity_id,relation_code) WHERE deleted_at IS NULL
          DO UPDATE SET description=EXCLUDED.description,captured_on=EXCLUDED.captured_on RETURNING id`,
          [accountId,objectId,context.propertyId,type,targetId,relation,auth.userId,
            options.description??null,options.capturedOn??null]);
        const attachmentId=attached.rows[0]!.id;
        await client.query('DELETE FROM media_attachment_tag WHERE attachment_id=$1',[attachmentId]);
        for(const tagId of options.tagIds??[])await client.query(`INSERT INTO media_attachment_tag(
          attachment_id,tag_id) VALUES($1,$2)`,[attachmentId,tagId]);
        attachmentIds.push(attachmentId);
      }
      return attachmentIds;
    });
    return {id:result[0],attachmentIds:result};
  }catch(error){
    if(uploaded){try{await cloudinary.uploader.destroy(key,{resource_type:kind==='VIDEO'?'video':'image'});}catch{console.error('Cloudinary cleanup pending:',key);}}
    throw error;
  }finally{
    if(!reused)await pool.query(`UPDATE media_quota_reservation SET status='RELEASED',completed_at=now()
      WHERE id=$1 AND status='RESERVED'`,[reservationId]);
  }
}
async function deleteReferences(context:PropertyContext,objectId:string,attachmentId?:string){
  const pending=await inTransaction(async client=>{
    const accountId=await account(client,context.propertyId);
    await client.query('SELECT id FROM administrative_account WHERE id=$1 FOR UPDATE',[accountId]);
    const object=await client.query(`SELECT id FROM storage_object WHERE id=$1 AND account_id=$2
      AND status='AVAILABLE' FOR UPDATE`,[objectId,accountId]);
    if(!object.rowCount)throw invalidRequest('MEDIA_NOT_FOUND','El archivo no está disponible.');
    const refs=await client.query<{id:string;entity_type:string;entity_id:string}>(`
      SELECT id,entity_type,entity_id FROM media_attachment WHERE storage_object_id=$1
        AND property_id=$2 AND deleted_at IS NULL AND ($3::uuid IS NULL OR id=$3) FOR UPDATE`,
      [objectId,context.propertyId,attachmentId??null]);
    if(!refs.rows.length)throw invalidRequest('MEDIA_NOT_FOUND','El archivo no está en esta propiedad.');
    for(const ref of refs.rows)await validateTarget(client,context,ref.entity_type,ref.entity_id);
    await client.query(`UPDATE media_attachment SET deleted_at=now() WHERE id=ANY($1::uuid[])`,
      [refs.rows.map(ref=>ref.id)]);
    const remaining=await client.query(`SELECT 1 FROM media_attachment WHERE storage_object_id=$1
      AND deleted_at IS NULL LIMIT 1`,[objectId]);
    if(remaining.rowCount)return false;
    await client.query(`UPDATE storage_object SET status='TRASHED',trashed_at=now(),
      purge_after=now()-interval '1 second' WHERE id=$1`,[objectId]);
    await client.query(`UPDATE storage_object SET status='DELETE_PENDING' WHERE id=$1`,[objectId]);
    await client.query(`UPDATE storage_deletion_job SET locked_at=now(),locked_by=$2
      WHERE storage_object_id=$1`,[objectId,`${process.pid}`]);
    return true;
  });
  return pending?await processDeletion(objectId):true;
}
export async function processDeletion(objectId:string){
  const object=(await pool.query<{provider_asset_id:string;kind:string}>(`
    SELECT provider_asset_id,kind FROM storage_object WHERE id=$1 AND status='DELETE_PENDING'`,
    [objectId])).rows[0];
  if(!object)return true;
  try{
    configured();
    const result=await cloudinary.uploader.destroy(object.provider_asset_id,{
      resource_type:object.kind==='VIDEO'?'video':'image',invalidate:true});
    if(result.result!=='ok'&&result.result!=='not found')throw new Error(result.result);
    await inTransaction(async client=>{
      await client.query(`UPDATE storage_deletion_job SET status='COMPLETED',completed_at=now(),
        attempts=attempts+1,last_error=NULL,locked_at=NULL,locked_by=NULL
        WHERE storage_object_id=$1`,[objectId]);
      await client.query(`UPDATE storage_object SET status='PURGED',purged_at=now()
        WHERE id=$1 AND status='DELETE_PENDING'`,[objectId]);
    });
    return true;
  }catch(error){
    await pool.query(`UPDATE storage_deletion_job SET status='RETRY',attempts=attempts+1,
      next_attempt_at=now()+interval '1 hour',last_error=$2,locked_at=NULL,locked_by=NULL
      WHERE storage_object_id=$1`,
      [objectId,error instanceof Error?error.message.slice(0,500):'Error de Cloudinary']);
    return false;
  }
}
export async function processPendingDeletions(){
  // Claim jobs with a lease so two API instances cannot delete the same object concurrently.
  const due=await pool.query<{storage_object_id:string}>(`UPDATE storage_deletion_job job
    SET locked_at=now(),locked_by=$1
    WHERE job.id IN (SELECT id FROM storage_deletion_job
      WHERE status IN ('PENDING','RETRY') AND next_attempt_at<=now()
      AND (locked_at IS NULL OR locked_at<now()-interval '10 minutes')
      ORDER BY next_attempt_at LIMIT 20 FOR UPDATE SKIP LOCKED)
    RETURNING storage_object_id`,[`${process.pid}`]);
  for(const item of due.rows)await processDeletion(item.storage_object_id);
}
export async function removeMedia(context:PropertyContext,id:string){
  const row=(await pool.query<{storage_object_id:string}>(`SELECT storage_object_id
    FROM media_attachment WHERE id=$1 AND property_id=$2 AND deleted_at IS NULL`,
    [id,context.propertyId])).rows[0];
  if(!row)throw invalidRequest('MEDIA_NOT_FOUND','El archivo no está disponible.');
  return deleteReferences(context,row.storage_object_id,id);
}
export async function removeMediaObject(context:PropertyContext,id:string){
  return deleteReferences(context,id);
}
