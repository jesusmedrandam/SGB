import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {v2 as cloudinary} from 'cloudinary';
import sharp from 'sharp';
import type {PoolClient} from 'pg';
import {env} from '../../config.js';
import {forbidden,invalidRequest,ApiError} from '../../core/errors.js';
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
  const rows=await pool.query<{id:string;entity_type:string;entity_id:string;relation_code:string;
    kind:string;byte_size:string;created_at:string;provider_asset_id:string}>(`
    SELECT ma.id,ma.entity_type,ma.entity_id,ma.relation_code,so.kind,so.byte_size,
      ma.created_at,so.provider_asset_id FROM media_attachment ma
    JOIN storage_object so ON so.id=ma.storage_object_id AND so.status='AVAILABLE'
    WHERE ma.property_id=$1 AND ma.deleted_at IS NULL AND ma.entity_type=ANY($4::varchar[])
      AND ($2::varchar IS NULL OR ma.entity_type=$2) AND ($3::uuid IS NULL OR ma.entity_id=$3)
    ORDER BY ma.created_at DESC LIMIT 200`,[context.propertyId,type??null,id??null,visible]);
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
  relation:string,kind:'IMAGE'|'VIDEO',input:Buffer){
  if(!input.length||input.length>(kind==='IMAGE'?20:120)*1024*1024)
    throw invalidRequest('MEDIA_SIZE_INVALID','El archivo supera el límite de entrada.');
  const canonical=await canonicalize(input,kind);
  const digest=createHash('sha256').update(canonical.data).digest('hex');
  const reservationId=randomUUID();let accountId='';let reused:string|null=null;
  await inTransaction(async client=>{
    await validateTarget(client,context,type,id);
    accountId=await account(client,context.propertyId);
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
      await validateTarget(client,context,type,id);
      await client.query('SELECT id FROM administrative_account WHERE id=$1 FOR UPDATE',[accountId]);
      let objectId:string;
      if(reused){objectId=reused;
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
      const attached=await client.query<{id:string}>(`INSERT INTO media_attachment(account_id,storage_object_id,
        property_id,entity_type,entity_id,relation_code,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (storage_object_id,entity_type,entity_id,relation_code) WHERE deleted_at IS NULL
        DO UPDATE SET sort_order=media_attachment.sort_order RETURNING id`,
        [accountId,objectId,context.propertyId,type,id,relation,auth.userId]);
      return attached.rows[0]!.id;
    });
    return {id:result};
  }catch(error){
    if(uploaded){try{await cloudinary.uploader.destroy(key,{resource_type:kind==='VIDEO'?'video':'image'});}catch{console.error('Cloudinary cleanup pending:',key);}}
    throw error;
  }finally{
    if(!reused)await pool.query(`UPDATE media_quota_reservation SET status='RELEASED',completed_at=now()
      WHERE id=$1 AND status='RESERVED'`,[reservationId]);
  }
}
export async function removeMedia(context:PropertyContext,id:string){
  return inTransaction(async client=>{
    const found=await client.query<{storage_object_id:string;entity_type:string;entity_id:string}>(`
      SELECT ma.storage_object_id,ma.entity_type,ma.entity_id FROM media_attachment ma
      WHERE ma.id=$1 AND ma.property_id=$2 AND ma.deleted_at IS NULL FOR UPDATE`,[id,context.propertyId]);
    if(!found.rows[0])throw invalidRequest('MEDIA_NOT_FOUND','El archivo no está disponible.');
    await validateTarget(client,context,found.rows[0].entity_type,found.rows[0].entity_id);
    await client.query('UPDATE media_attachment SET deleted_at=now() WHERE id=$1',[id]);
    const objectId=found.rows[0].storage_object_id;
    const remaining=await client.query('SELECT 1 FROM media_attachment WHERE storage_object_id=$1 AND deleted_at IS NULL LIMIT 1',[objectId]);
    if(!remaining.rowCount)await client.query(`UPDATE storage_object SET status='TRASHED',trashed_at=now(),
      purge_after=now()+interval '30 days' WHERE id=$1 AND status='AVAILABLE'`,[objectId]);
  });
}
