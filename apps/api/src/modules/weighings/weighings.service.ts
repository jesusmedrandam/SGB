import type {PoolClient} from 'pg';
import {ApiError,conflict,forbidden,invalidRequest} from '../../core/errors.js';
import {pool} from '../../database/pool.js';
import {inTransaction} from '../../database/transaction.js';
import type {AuthState,PropertyContext,RequestMetadata} from '../auth/auth.types.js';
import type {WeighingInput} from './weighings.schemas.js';

const columns=`w.id,w.animal_id AS "animalId",a.name AS "animalName",
  a.ear_tag_code AS "earTagCode",w.weighed_on::text AS "weighedOn",
  w.weight::float8 AS weight,w.unit_code AS "unitCode",
  round((w.weight * CASE WHEN w.unit_code='POUND' THEN 0.45359237 ELSE 1 END),3)::float8
    AS "weightKg",w.method,w.notes,w.version::int,
  w.voided_at AS "voidedAt",w.created_at AS "createdAt"`;
const from=`FROM animal_weighing w JOIN animal a ON a.id=w.animal_id`;
type WeighingRow={id:string;animalId:string;weighedOn:string;weight:number;
  unitCode:string;method:string|null;notes:string|null;version:number;voidedAt:Date|null};

async function access(client:PoolClient,auth:AuthState,context:PropertyContext){
  const row=(await client.query<{account_id:string;today:string}>(
    `SELECT p.account_id,(now() AT TIME ZONE p.timezone)::date::text AS today
     FROM property p JOIN administrative_account aa ON aa.id=p.account_id AND aa.status='ACTIVE'
     JOIN property_membership pm ON pm.property_id=p.id AND pm.user_id=$2 AND pm.status='ACTIVE'
     JOIN membership_role mr ON mr.membership_id=pm.id AND mr.property_id=p.id
     JOIN property_role pr ON pr.id=mr.role_id AND pr.property_id=p.id AND pr.active
     JOIN role_permission rp ON rp.role_id=pr.id AND rp.permission_code='WEIGHING_MANAGE'
     JOIN effective_property_module epm ON epm.property_id=p.id
       AND epm.module_code='WEIGHING' AND epm.enabled
     WHERE p.id=$1 AND pr.id=$3 AND p.status='ACTIVE' AND p.deleted_at IS NULL
     FOR SHARE OF p,pm,pr`,[context.propertyId,auth.userId,context.roleId])).rows[0];
  if(!row)throw forbidden('WEIGHING_DENIED','Los pesajes o el rol activo no están habilitados.');
  return row;
}
function checkDate(input:WeighingInput,today:string){
  if(input.weighedOn>today)throw invalidRequest('WEIGHING_FUTURE_DATE',
    'La fecha del pesaje no puede ser futura.');
}
async function read(client:PoolClient,id:string){
  const row=(await client.query(`SELECT ${columns} ${from} WHERE w.id=$1`,[id])).rows[0];
  if(!row)throw new ApiError(404,'WEIGHING_NOT_FOUND','Pesaje no encontrado.');
  return row;
}
async function audit(client:PoolClient,auth:AuthState,context:PropertyContext,
  metadata:RequestMetadata,action:string,id:string,before:unknown,after:unknown){
  await client.query(`INSERT INTO audit_event(actor_user_id,property_id,active_role_id,
    action,entity_type,entity_id,before_data,after_data,ip_address,user_agent)
    VALUES($1,$2,$3,$4,'ANIMAL_WEIGHING',$5,$6::jsonb,$7::jsonb,$8,$9)`,
    [auth.userId,context.propertyId,context.roleId,action,id,
      before===null?null:JSON.stringify(before),JSON.stringify(after),metadata.ipAddress,metadata.userAgent]);
}
function translate(reason:unknown):never{
  const error=reason as {code?:string};
  if(error.code==='23503'||error.code==='23514')throw invalidRequest('WEIGHING_REFERENCE_INVALID',
    'El animal, la unidad o los datos del pesaje ya no son válidos.');
  throw reason;
}
export async function listWeighings(context:PropertyContext,animalId?:string){
  return (await pool.query(`SELECT ${columns} ${from} WHERE w.property_id=$1
    AND ($2::uuid IS NULL OR w.animal_id=$2)
    ORDER BY w.weighed_on DESC,w.created_at DESC,w.id DESC LIMIT 2000`,
    [context.propertyId,animalId??null])).rows;
}
export async function listWeighingOptions(context:PropertyContext){
  return (await pool.query(`SELECT a.id,a.name,a.ear_tag_code AS "earTagCode"
    FROM animal a WHERE a.property_id=$1 AND a.record_status='CURRENT'
      AND a.availability_status_code='ACTIVE'
    ORDER BY lower(a.name),a.id LIMIT 5000`,[context.propertyId])).rows;
}
export async function createWeighing(auth:AuthState,context:PropertyContext,input:WeighingInput,
  metadata:RequestMetadata){
  if(input.expectedVersion!==undefined)throw invalidRequest('WEIGHING_VERSION_UNEXPECTED',
    'No indiques una versión para un pesaje nuevo.');
  try{return await inTransaction(async client=>{
    const {account_id:accountId,today}=await access(client,auth,context);checkDate(input,today);
    const animal=(await client.query<{birth_date:string|null;entry_date:string}>(
      `SELECT birth_date::text,entry_date::text FROM animal WHERE id=$1
        AND account_id=$2 AND property_id=$3 AND record_status='CURRENT'
        AND availability_status_code='ACTIVE' FOR SHARE`,
      [input.animalId,accountId,context.propertyId])).rows[0];
    if(!animal)throw invalidRequest('WEIGHING_ANIMAL_UNAVAILABLE',
      'El animal debe estar activo en la propiedad seleccionada.');
    if(animal.birth_date&&input.weighedOn<animal.birth_date)
      throw invalidRequest('WEIGHING_BEFORE_BIRTH','El pesaje no puede ser anterior al nacimiento.');
    const result=await client.query<{id:string}>(`INSERT INTO animal_weighing
      (account_id,property_id,animal_id,weighed_on,weight,unit_code,method,notes,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
      [accountId,context.propertyId,input.animalId,input.weighedOn,input.weight,input.unitCode,
        input.method,input.notes,auth.userId]);
    const after=await read(client,result.rows[0]!.id);
    await audit(client,auth,context,metadata,'WEIGHING_CREATED',after.id,null,after);
    return after;
  });}catch(reason){translate(reason);}
}
async function locked(client:PoolClient,context:PropertyContext,id:string){
  const current=(await client.query<WeighingRow>(`SELECT id,animal_id AS "animalId",
    weighed_on::text AS "weighedOn",weight::float8 AS weight,unit_code AS "unitCode",
    method,notes,version::int,voided_at AS "voidedAt" FROM animal_weighing
    WHERE id=$1 AND property_id=$2 FOR UPDATE`,[id,context.propertyId])).rows[0];
  if(!current)throw new ApiError(404,'WEIGHING_NOT_FOUND','Pesaje no encontrado en esta propiedad.');
  if(current.voidedAt)throw conflict('WEIGHING_VOIDED','Un pesaje anulado no se puede modificar.');
  return current;
}
export async function updateWeighing(auth:AuthState,context:PropertyContext,id:string,
  input:WeighingInput,metadata:RequestMetadata){
  if(input.expectedVersion===undefined)throw invalidRequest('WEIGHING_VERSION_REQUIRED',
    'Actualiza la lista de pesajes antes de corregir el registro.');
  try{return await inTransaction(async client=>{
    const {today}=await access(client,auth,context);checkDate(input,today);
    const previous=await locked(client,context,id);
    if(previous.version!==input.expectedVersion)throw conflict('WEIGHING_STALE',
      'El pesaje cambió. Actualiza la lista y vuelve a intentarlo.');
    if(previous.animalId!==input.animalId)throw invalidRequest('WEIGHING_ANIMAL_IMMUTABLE',
      'No se puede transferir un pesaje a otro animal. Anula el registro y crea uno nuevo.');
    const before=await read(client,id);
    const birth=(await client.query<{birth_date:string|null}>(`SELECT birth_date::text
      FROM animal WHERE id=$1`,[input.animalId])).rows[0];
    if(birth?.birth_date&&input.weighedOn<birth.birth_date)
      throw invalidRequest('WEIGHING_BEFORE_BIRTH','El pesaje no puede ser anterior al nacimiento.');
    await client.query(`UPDATE animal_weighing SET weighed_on=$2,weight=$3,unit_code=$4,
      method=$5,notes=$6,updated_by=$7 WHERE id=$1`,
    [id,input.weighedOn,input.weight,input.unitCode,input.method,input.notes,auth.userId]);
    const after=await read(client,id);
    await audit(client,auth,context,metadata,'WEIGHING_UPDATED',id,before,after);
    return after;
  });}catch(reason){translate(reason);}
}
export async function voidWeighing(auth:AuthState,context:PropertyContext,id:string,
  expectedVersion:number,metadata:RequestMetadata){
  try{return await inTransaction(async client=>{
    await access(client,auth,context);
    const previous=await locked(client,context,id);
    if(previous.version!==expectedVersion)throw conflict('WEIGHING_STALE',
      'El pesaje cambió. Actualiza la lista y vuelve a intentarlo.');
    const before=await read(client,id);
    await client.query(`UPDATE animal_weighing SET voided_at=now(),voided_by=$2,
      updated_by=$2 WHERE id=$1`,[id,auth.userId]);
    const after=await read(client,id);
    await audit(client,auth,context,metadata,'WEIGHING_VOIDED',id,before,after);
    return after;
  });}catch(reason){translate(reason);}
}
