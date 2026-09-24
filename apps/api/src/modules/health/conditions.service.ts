import type {PoolClient} from 'pg';
import {ApiError,conflict,invalidRequest} from '../../core/errors.js';
import {pool} from '../../database/pool.js';
import {inTransaction} from '../../database/transaction.js';
import type {AuthState,PropertyContext,RequestMetadata} from '../auth/auth.types.js';
import type {ConditionInput} from './health.schemas.js';
import {healthAccess,healthAudit} from './health.service.js';

const fields=`c.id,c.animal_id AS "animalId",a.name AS "animalName",c.kind,
  c.detected_on::text AS "detectedOn",c.description,c.status,
  c.resolved_on::text AS "resolvedOn",c.version::int,c.created_at AS "createdAt",
  (SELECT count(*)::int FROM health_campaign_animal d JOIN health_campaign h ON h.id=d.campaign_id
    WHERE d.condition_id=c.id AND d.selected AND h.status='COMPLETADO') AS "treatmentCount"`;
async function read(client:PoolClient,id:string){
  const row=(await client.query(`SELECT ${fields} FROM health_condition c
    JOIN animal a ON a.id=c.animal_id WHERE c.id=$1`,[id])).rows[0];
  if(!row)throw new ApiError(404,'HEALTH_CONDITION_NOT_FOUND','Condición no encontrada.');
  return row;
}
export async function listConditions(context:PropertyContext){
  return (await pool.query(`SELECT ${fields} FROM health_condition c
    JOIN animal a ON a.id=c.animal_id WHERE c.property_id=$1
    ORDER BY CASE c.status WHEN 'POR_RESOLVER' THEN 0 WHEN 'EN_TRATAMIENTO' THEN 1 ELSE 2 END,
      c.detected_on DESC,c.created_at DESC LIMIT 500`,[context.propertyId])).rows;
}
async function eligible(client:PoolClient,propertyId:string,accountId:string,animalId:string){
  const row=await client.query(`SELECT 1 FROM animal WHERE id=$1 AND property_id=$2 AND account_id=$3
    AND record_status='CURRENT' AND availability_status_code='ACTIVE' FOR UPDATE`,
    [animalId,propertyId,accountId]);
  if(!row.rowCount)throw invalidRequest('HEALTH_ANIMAL_INVALID','El animal no está activo en esta propiedad.');
}
async function conditionKind(client:PoolClient,accountId:string,name:string){
  const found=await client.query(`SELECT 1 FROM governed_catalog_item WHERE
    catalog_code='HEALTH_CONDITION_TYPES' AND name=$1 AND active AND deleted_at IS NULL
    AND (system_defined OR account_id=$2)`,[name,accountId]);
  if(!found.rowCount)throw invalidRequest('HEALTH_CONDITION_TYPE_INVALID',
    'Registra el tipo de problema en Catálogos antes de seleccionarlo.');
}
export async function createCondition(auth:AuthState,context:PropertyContext,input:ConditionInput,
  metadata:RequestMetadata){
  return inTransaction(async(client)=>{
    const {account_id,today}=await healthAccess(client,auth,context,'HEALTH_MANAGE');
    if(input.detectedOn>today)throw invalidRequest('HEALTH_FUTURE_DATE','La detección no puede ser futura.');
    await eligible(client,context.propertyId,account_id,input.animalId);
    await conditionKind(client,account_id,input.kind);
    const result=await client.query<{id:string}>(`INSERT INTO health_condition(account_id,property_id,
      animal_id,kind,detected_on,description,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id`,
      [account_id,context.propertyId,input.animalId,input.kind??null,input.detectedOn,
        input.description,auth.userId]);
    const after=await read(client,result.rows[0]!.id);
    await healthAudit(client,auth,context,metadata,'HEALTH_CONDITION_CREATED',
      'HEALTH_EVENT',result.rows[0]!.id,null,after);
    return after;
  });
}
async function lock(client:PoolClient,context:PropertyContext,id:string){
  const row=(await client.query<{animal_id:string;status:string;version:number;detected_on:string;kind:string|null}>(
    `SELECT animal_id,status,version::int,detected_on::text,kind FROM health_condition
      WHERE id=$1 AND property_id=$2 FOR UPDATE`,[id,context.propertyId])).rows[0];
  if(!row)throw new ApiError(404,'HEALTH_CONDITION_NOT_FOUND','Condición no encontrada en esta propiedad.');
  if(row.status==='RESUELTA')throw conflict('HEALTH_CONDITION_RESOLVED','La condición ya está resuelta.');
  return row;
}
export async function updateCondition(auth:AuthState,context:PropertyContext,id:string,
  input:ConditionInput,metadata:RequestMetadata){
  return inTransaction(async(client)=>{
    const {account_id,today}=await healthAccess(client,auth,context,'HEALTH_MANAGE');
    const current=await lock(client,context,id);
    if(current.animal_id!==input.animalId)throw invalidRequest('HEALTH_ANIMAL_IMMUTABLE',
      'No se puede cambiar el animal de una condición registrada.');
    if(input.expectedVersion && current.version!==input.expectedVersion)
      throw conflict('HEALTH_VERSION_CONFLICT','La condición cambió. Actualiza la pantalla.');
    if(input.detectedOn>today)throw invalidRequest('HEALTH_FUTURE_DATE','La detección no puede ser futura.');
    await eligible(client,context.propertyId,account_id,input.animalId);
    if(input.kind!==current.kind)await conditionKind(client,account_id,input.kind);
    const before=await read(client,id);
    await client.query(`UPDATE health_condition SET kind=$2,detected_on=$3,description=$4,updated_by=$5
      WHERE id=$1`,[id,input.kind??null,input.detectedOn,input.description,auth.userId]);
    const after=await read(client,id);
    await healthAudit(client,auth,context,metadata,'HEALTH_CONDITION_UPDATED',
      'HEALTH_EVENT',id,before,after);
    return after;
  });
}
export async function resolveCondition(auth:AuthState,context:PropertyContext,id:string,
  input:{resolvedOn:string;expectedVersion?:number|undefined},metadata:RequestMetadata){
  return inTransaction(async(client)=>{
    const {account_id,today}=await healthAccess(client,auth,context,'HEALTH_MANAGE');
    const current=await lock(client,context,id);
    if(input.expectedVersion && current.version!==input.expectedVersion)
      throw conflict('HEALTH_VERSION_CONFLICT','La condición cambió. Actualiza la pantalla.');
    if(input.resolvedOn<current.detected_on || input.resolvedOn>today)
      throw invalidRequest('HEALTH_RESOLUTION_DATE','La fecha debe estar entre la detección y hoy.');
    await eligible(client,context.propertyId,account_id,current.animal_id);
    const before=await read(client,id);
    await client.query(`UPDATE health_condition SET status='RESUELTA',resolved_on=$2,updated_by=$3
      WHERE id=$1`,[id,input.resolvedOn,auth.userId]);
    const after=await read(client,id);
    await healthAudit(client,auth,context,metadata,'HEALTH_CONDITION_RESOLVED',
      'HEALTH_EVENT',id,before,after);
    return after;
  });
}
