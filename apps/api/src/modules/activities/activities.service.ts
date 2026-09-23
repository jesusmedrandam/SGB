import type {PoolClient} from 'pg';
import {ApiError,conflict,forbidden,invalidRequest} from '../../core/errors.js';
import {pool} from '../../database/pool.js';
import {inTransaction} from '../../database/transaction.js';
import type {AuthState,PropertyContext,RequestMetadata} from '../auth/auth.types.js';
import type {ActivityInput} from './activities.schemas.js';

async function access(client:PoolClient,auth:AuthState,context:PropertyContext,permission:string){
  const row=(await client.query<{account_id:string;today:string}>(
    `SELECT p.account_id,(now() AT TIME ZONE p.timezone)::date::text AS today
     FROM property p JOIN administrative_account aa ON aa.id=p.account_id AND aa.status='ACTIVE'
     JOIN property_membership pm ON pm.property_id=p.id AND pm.user_id=$2 AND pm.status='ACTIVE'
     JOIN membership_role mr ON mr.membership_id=pm.id AND mr.property_id=p.id
     JOIN property_role pr ON pr.id=mr.role_id AND pr.property_id=p.id AND pr.active
     JOIN role_permission rp ON rp.role_id=pr.id AND rp.permission_code=$4
     JOIN effective_property_module epm ON epm.property_id=p.id AND epm.module_code='TASKS' AND epm.enabled
     WHERE p.id=$1 AND pr.id=$3 AND p.status='ACTIVE' AND p.deleted_at IS NULL
     FOR SHARE OF p,pm,pr`,[context.propertyId,auth.userId,context.roleId,permission])).rows[0];
  if(!row)throw forbidden('ACTIVITY_DENIED','Las actividades o el rol activo no están habilitados.');
  return row;
}
async function audit(client:PoolClient,auth:AuthState,context:PropertyContext,
  metadata:RequestMetadata,action:string,id:string,before:unknown,after:unknown){
  await client.query(`INSERT INTO audit_event(actor_user_id,property_id,active_role_id,
    action,entity_type,entity_id,before_data,after_data,ip_address,user_agent)
    VALUES($1,$2,$3,$4,'LIVESTOCK_ACTIVITY',$5,$6::jsonb,$7::jsonb,$8,$9)`,
    [auth.userId,context.propertyId,context.roleId,action,id,
      before===null?null:JSON.stringify(before),JSON.stringify(after),metadata.ipAddress,metadata.userAgent]);
}
const fields=`ac.id,ac.kind,ac.title,ac.occurred_on::text AS "occurredOn",
  ac.description,ac.brand_id AS "brandId",b.name AS "brandName",
  ac.status,ac.version::int,ac.created_at AS "createdAt",
  ac.applied_at AS "appliedAt",ac.cancelled_at AS "cancelledAt",
  COALESCE((SELECT json_agg(json_build_object('id',a.id,'name',a.name,
    'earTagCode',a.ear_tag_code) ORDER BY lower(a.name),a.id)
    FROM livestock_activity_animal aa JOIN animal a ON a.id=aa.animal_id
    WHERE aa.activity_id=ac.id),'[]'::json) AS animals`;
const joins=`FROM livestock_activity ac LEFT JOIN livestock_brand b ON b.id=ac.brand_id`;
async function read(client:PoolClient,id:string){
  const row=(await client.query(`SELECT ${fields} ${joins} WHERE ac.id=$1`,[id])).rows[0];
  if(!row)throw new ApiError(404,'ACTIVITY_NOT_FOUND','Actividad no encontrada.');
  return row;
}
export async function listActivities(context:PropertyContext){
  return (await pool.query(`SELECT ${fields} ${joins} WHERE ac.property_id=$1
    ORDER BY ac.occurred_on DESC,ac.created_at DESC LIMIT 250`,[context.propertyId])).rows;
}
export async function listActivityOptions(context:PropertyContext){
  const [animals,brands]=await Promise.all([
    pool.query(`SELECT id,name,ear_tag_code AS "earTagCode" FROM animal WHERE property_id=$1
      AND record_status='CURRENT' AND availability_status_code='ACTIVE'
      ORDER BY lower(name),id LIMIT 5000`,[context.propertyId]),
    pool.query(`SELECT id,name FROM livestock_brand WHERE account_id=(SELECT account_id FROM property
      WHERE id=$1) AND active ORDER BY lower(name)`,[context.propertyId]),
  ]);
  return {animals:animals.rows,brands:brands.rows};
}
async function validate(client:PoolClient,context:PropertyContext,input:ActivityInput,
  accountId:string,today:string){
  if(input.occurredOn>today)throw invalidRequest('ACTIVITY_FUTURE_DATE',
    'La actividad realizada no puede tener fecha futura. Usa la agenda para programarla.');
  if((input.kind==='HERRAJE')!==Boolean(input.brandId))
    throw invalidRequest('ACTIVITY_BRAND_REQUIRED','El herraje requiere una marquilla activa.');
  if(input.brandId){
    const brand=await client.query(`SELECT 1 FROM livestock_brand WHERE id=$1
      AND account_id=$2 AND active FOR SHARE`,[input.brandId,accountId]);
    if(!brand.rowCount)throw invalidRequest('ACTIVITY_BRAND_INVALID',
      'La marquilla no está activa en esta cuenta.');
  }
  if(!input.animalIds.length||input.animalIds.length>500
    ||new Set(input.animalIds).size!==input.animalIds.length)
    throw invalidRequest('ACTIVITY_SELECTION_INVALID','Selecciona entre uno y 500 animales distintos.');
  const animals=await client.query<{id:string}>(`SELECT id FROM animal WHERE id=ANY($1::uuid[])
    AND property_id=$2 AND account_id=$3 AND record_status='CURRENT'
    AND availability_status_code='ACTIVE' ORDER BY id FOR UPDATE`,
    [input.animalIds,context.propertyId,accountId]);
  if(animals.rows.length!==input.animalIds.length)throw conflict('ACTIVITY_SELECTION_CHANGED',
    'Un animal salió de la propiedad o dejó de estar activo. Actualiza la selección.');
}
async function details(client:PoolClient,id:string,animalIds:string[]){
  await client.query('DELETE FROM livestock_activity_animal WHERE activity_id=$1',[id]);
  for(const animalId of animalIds)await client.query(`INSERT INTO livestock_activity_animal
    (activity_id,animal_id) VALUES($1,$2)`,[id,animalId]);
}
export async function createActivity(auth:AuthState,context:PropertyContext,input:ActivityInput,
  metadata:RequestMetadata){
  return inTransaction(async(client)=>{
    const {account_id,today}=await access(client,auth,context,'ACTIVITY_MANAGE');
    await validate(client,context,input,account_id,today);
    const row=(await client.query<{id:string}>(`INSERT INTO livestock_activity(account_id,property_id,
      kind,title,occurred_on,description,brand_id,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`,
      [account_id,context.propertyId,input.kind,input.title,input.occurredOn,
        input.description??null,input.brandId??null,auth.userId])).rows[0]!;
    await details(client,row.id,input.animalIds);
    const after=await read(client,row.id);
    await audit(client,auth,context,metadata,'ACTIVITY_DRAFT_CREATED',row.id,null,after);
    return after;
  });
}
async function draft(client:PoolClient,context:PropertyContext,id:string){
  const row=(await client.query<{status:string;version:number}>(`SELECT status,version::int
    FROM livestock_activity WHERE id=$1 AND property_id=$2 FOR UPDATE`,
    [id,context.propertyId])).rows[0];
  if(!row)throw new ApiError(404,'ACTIVITY_NOT_FOUND','Actividad no encontrada en esta propiedad.');
  if(row.status!=='BORRADOR')throw conflict('ACTIVITY_FINAL','La actividad ya fue aplicada o cancelada.');
  return row;
}
export async function updateActivity(auth:AuthState,context:PropertyContext,id:string,
  input:ActivityInput,metadata:RequestMetadata){
  return inTransaction(async(client)=>{
    const {account_id,today}=await access(client,auth,context,'ACTIVITY_MANAGE');
    const current=await draft(client,context,id);
    if(input.expectedVersion&&input.expectedVersion!==current.version)
      throw conflict('ACTIVITY_VERSION_CONFLICT','El borrador cambió. Actualiza la pantalla.');
    await validate(client,context,input,account_id,today);
    const before=await read(client,id);
    await client.query(`UPDATE livestock_activity SET kind=$2,title=$3,occurred_on=$4,
      description=$5,brand_id=$6,updated_by=$7 WHERE id=$1`,
      [id,input.kind,input.title,input.occurredOn,input.description??null,
        input.brandId??null,auth.userId]);
    await details(client,id,input.animalIds);
    const after=await read(client,id);
    await audit(client,auth,context,metadata,'ACTIVITY_DRAFT_UPDATED',id,before,after);
    return after;
  });
}
export async function applyActivity(auth:AuthState,context:PropertyContext,id:string,
  metadata:RequestMetadata){
  return inTransaction(async(client)=>{
    const {account_id,today}=await access(client,auth,context,'ACTIVITY_MANAGE');
    await draft(client,context,id);
    const before=await read(client,id);
    const animals=(before.animals as Array<{id:string}>).map((item)=>item.id);
    const input:ActivityInput={kind:before.kind,title:before.title,occurredOn:before.occurredOn,
      description:before.description,brandId:before.brandId,animalIds:animals};
    await validate(client,context,input,account_id,today);
    if(input.kind==='HERRAJE')for(const animalId of animals){
      await client.query(`INSERT INTO animal_brand_assignment(animal_id,property_id,brand_id,assigned_by)
        SELECT $1,$2,$3,$4 WHERE NOT EXISTS(SELECT 1 FROM animal_brand_assignment
          WHERE animal_id=$1 AND brand_id=$3 AND ended_at IS NULL)`,
        [animalId,context.propertyId,input.brandId,auth.userId]);
      await client.query('UPDATE animal SET updated_by=$2 WHERE id=$1',[animalId,auth.userId]);
    }
    await client.query(`UPDATE livestock_activity SET status='COMPLETADA',applied_at=now(),
      updated_by=$2 WHERE id=$1`,[id,auth.userId]);
    const after=await read(client,id);
    await audit(client,auth,context,metadata,'ACTIVITY_APPLIED',id,before,after);
    return after;
  });
}
export async function cancelActivity(auth:AuthState,context:PropertyContext,id:string,
  metadata:RequestMetadata){
  return inTransaction(async(client)=>{
    await access(client,auth,context,'ACTIVITY_MANAGE');
    await draft(client,context,id);
    const before=await read(client,id);
    await client.query(`UPDATE livestock_activity SET status='CANCELADA',cancelled_at=now(),
      updated_by=$2 WHERE id=$1`,[id,auth.userId]);
    const after=await read(client,id);
    await audit(client,auth,context,metadata,'ACTIVITY_CANCELLED',id,before,after);
    return after;
  });
}
