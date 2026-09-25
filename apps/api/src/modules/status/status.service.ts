import {ApiError,conflict,invalidRequest} from '../../core/errors.js';
import {pool} from '../../database/pool.js';
import {inTransaction} from '../../database/transaction.js';
import type {AuthState,PropertyContext} from '../auth/auth.types.js';

type Action='REPORT_MISSING'|'MARK_FOUND'|'RECORD_DEATH'|'RECORD_EXIT';
type Input={animalId:string;action:Action;reason?:string|null|undefined;occurredAt:string;
  expectedVersion:number;exitReasonCode?:string|undefined};
const target:Record<Action,string>={REPORT_MISSING:'MISSING',MARK_FOUND:'ACTIVE',
  RECORD_DEATH:'DEAD',RECORD_EXIT:'EXITED'};
const fields=`e.id,e.animal_id AS "animalId",a.name AS "animalName",
  a.ear_tag_code AS "earTagCode",e.from_status AS "fromStatus",
  e.to_status AS "toStatus",e.action_code AS action,e.reason,
  e.exit_reason_code AS "exitReasonCode",e.occurred_at AS "occurredAt",
  e.created_at AS "createdAt",u.display_name AS "registeredBy"`;
const tables=`FROM animal_status_event e JOIN animal a ON a.id=e.animal_id
  JOIN app_user u ON u.id=e.created_by`;

export async function listAnimalStatusEvents(context:PropertyContext,animalId?:string){
  return (await pool.query(`SELECT ${fields} ${tables} WHERE e.property_id=$1
    AND ($2::uuid IS NULL OR e.animal_id=$2)
    ORDER BY e.occurred_at DESC,e.created_at DESC,e.id DESC LIMIT 2000`,
    [context.propertyId,animalId??null])).rows;
}
export async function listStatusOptions(context:PropertyContext){
  return (await pool.query(`SELECT id,name,ear_tag_code AS "earTagCode",
    availability_status_code AS status,version::int FROM animal
    WHERE property_id=$1 AND record_status='CURRENT'
      AND availability_status_code IN ('ACTIVE','MISSING','INACTIVE')
    ORDER BY lower(name),id LIMIT 5000`,[context.propertyId])).rows;
}

export async function recordAnimalStatus(auth:AuthState,context:PropertyContext,input:Input){
  if(input.action==='RECORD_EXIT'&&!input.exitReasonCode)
    throw invalidRequest('EXIT_REASON_REQUIRED','Selecciona el motivo de salida.');
  if(input.action!=='RECORD_EXIT'&&input.exitReasonCode)
    throw invalidRequest('EXIT_REASON_UNEXPECTED','El motivo de salida solo aplica a una salida.');
  const reason=input.reason?.trim()||null;
  if(input.action!=='MARK_FOUND'&&!reason)
    throw invalidRequest('STATUS_REASON_REQUIRED','Escribe el motivo o la causa del cambio.');
  try{return await inTransaction(async client=>{
    // Scope the animal before calling the database transition, which holds the row lock,
    // checks the active membership/role and version, and writes an immutable audit event.
    const animal=(await client.query<{id:string}>(`SELECT id FROM animal
      WHERE id=$1 AND property_id=$2 AND record_status='CURRENT'`,
      [input.animalId,context.propertyId])).rows[0];
    if(!animal)throw new ApiError(404,'ANIMAL_NOT_FOUND','Animal no encontrado en esta propiedad.');
    await client.query(`SELECT change_animal_status($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [input.animalId,auth.userId,context.roleId,target[input.action],input.action,reason,
        input.exitReasonCode??null,input.occurredAt,null,input.expectedVersion]);
    const event=(await client.query(`SELECT ${fields} ${tables} WHERE e.property_id=$1
      AND e.animal_id=$2 ORDER BY e.created_at DESC,e.id DESC LIMIT 1`,
      [context.propertyId,input.animalId])).rows[0];
    return event;
  });}catch(error){
    const code=(error as {code?:string}).code;
    if(code==='40001')throw conflict('ANIMAL_VERSION_CONFLICT',
      'El animal cambió. Actualiza el listado antes de registrar la baja.');
    if(code==='23514'||code==='22007')throw invalidRequest('ANIMAL_STATUS_INVALID',
      error instanceof Error?error.message:'No se pudo registrar el cambio de estado.');
    if(code==='42501')throw new ApiError(403,'ANIMAL_STATUS_DENIED',
      'El rol activo no permite cambiar el estado del animal.');
    throw error;
  }
}
