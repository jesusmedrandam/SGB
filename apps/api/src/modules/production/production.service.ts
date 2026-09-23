import type { PoolClient } from 'pg';
import { ApiError, conflict, forbidden, invalidRequest } from '../../core/errors.js';
import { pool } from '../../database/pool.js';
import { inTransaction } from '../../database/transaction.js';
import type { AuthState, PropertyContext, RequestMetadata } from '../auth/auth.types.js';
import type { LactationInput, MilkInput, TankInput } from './production.schemas.js';

// Adapted from lafortuna/src/modules/records/records.routes.ts to account-scoped
// births and milking; data is retained for future media attachments.
async function access(client: PoolClient, auth: AuthState, context: PropertyContext, permission: string) {
  const result = await client.query<{ account_id: string; today: string; max_days: number }>(
    `SELECT p.account_id, to_char((now() AT TIME ZONE p.timezone)::date,'YYYY-MM-DD') AS today,
      COALESCE(rs.max_milking_days,305) AS max_days
     FROM property p JOIN administrative_account aa ON aa.id=p.account_id AND aa.status='ACTIVE'
     JOIN property_membership pm ON pm.property_id=p.id AND pm.user_id=$2 AND pm.status='ACTIVE'
     JOIN membership_role mr ON mr.membership_id=pm.id AND mr.property_id=p.id
     JOIN property_role pr ON pr.id=mr.role_id AND pr.property_id=p.id AND pr.active
     JOIN role_permission rp ON rp.role_id=pr.id AND rp.permission_code=$4
     JOIN effective_property_module epm ON epm.property_id=p.id
       AND epm.module_code='PRODUCTION' AND epm.enabled
     LEFT JOIN reproduction_setting rs ON rs.property_id=p.id
     WHERE p.id=$1 AND pr.id=$3 AND p.status='ACTIVE' AND p.deleted_at IS NULL
     FOR SHARE OF p,pm,pr`,
    [context.propertyId, auth.userId, context.roleId, permission]);
  if (!result.rows[0]) throw forbidden('PRODUCTION_DENIED',
    'La producción no está habilitada o el rol activo no tiene acceso.');
  return result.rows[0];
}

async function audit(client: PoolClient, auth: AuthState, context: PropertyContext,
  metadata: RequestMetadata, action: string, entityType: string, id: string, before: unknown, after: unknown) {
  await client.query(`INSERT INTO audit_event(actor_user_id,property_id,active_role_id,
    action,entity_type,entity_id,before_data,after_data,ip_address,user_agent)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)`,
  [auth.userId, context.propertyId, context.roleId, action, entityType, id,
    before === null ? null : JSON.stringify(before), JSON.stringify(after),
    metadata.ipAddress, metadata.userAgent]);
}

function translate(error: unknown): never {
  const database = error as { code?: string };
  if (database.code === '23505') throw conflict('PRODUCTION_DUPLICATE',
    'Ya existe una lactancia o una producción con esta fecha y turno.');
  if (database.code === '23514' || database.code === '23503')
    throw invalidRequest('PRODUCTION_INVALID_REFERENCE',
      'El parto, la lactancia o el animal ya no permiten este registro.');
  throw error;
}

export async function listProduction(context: PropertyContext) {
  const [lactations, milk, tanks, births, cows] = await Promise.all([
    pool.query(`SELECT l.id,l.cow_id AS "cowId",a.name AS "cowName",l.birth_id AS "birthId",
      l.started_on::text AS "startedOn",l.ended_on::text AS "endedOn",
      l.in_milking AS "inMilking",l.notes
      FROM milk_lactation l JOIN animal a ON a.id=l.cow_id
      WHERE l.property_id=$1 ORDER BY l.started_on DESC,l.created_at DESC LIMIT 500`,[context.propertyId]),
    pool.query(`SELECT m.id,m.cow_id AS "cowId",a.name AS "cowName",m.lactation_id AS "lactationId",
      m.produced_on::text AS "producedOn",m.shift,m.liters::float8 AS liters,
      m.source,m.external_reference AS "externalReference",m.notes
      FROM milk_production m JOIN animal a ON a.id=m.cow_id
      WHERE m.property_id=$1 ORDER BY m.produced_on DESC,m.created_at DESC LIMIT 1000`,[context.propertyId]),
    pool.query(`SELECT id,produced_on::text AS "producedOn",shift,liters::float8 AS liters,
      source,external_reference AS "externalReference",notes FROM milk_tank_production
      WHERE property_id=$1 ORDER BY produced_on DESC,created_at DESC LIMIT 500`,[context.propertyId]),
    pool.query(`SELECT b.id,b.mother_id AS "cowId",a.name AS "cowName",
      b.occurred_on::text AS "occurredOn" FROM reproduction_birth b
      JOIN animal a ON a.id=b.mother_id WHERE b.property_id=$1
      AND NOT EXISTS(SELECT 1 FROM milk_lactation l WHERE l.birth_id=b.id)
      ORDER BY b.occurred_on DESC LIMIT 500`,[context.propertyId]),
    pool.query(`SELECT a.id,a.name,COALESCE(ms.enabled,false) AS "inMilking",
      (SELECT l.id FROM milk_lactation l WHERE l.cow_id=a.id AND l.ended_on IS NULL
       LIMIT 1) AS "lactationId"
      FROM animal a LEFT JOIN milk_animal_state ms ON ms.cow_id=a.id
      LEFT JOIN reproduction_setting rs ON rs.property_id=a.property_id
      WHERE a.property_id=$1 AND a.sex='FEMALE' AND a.record_status='CURRENT'
        AND a.availability_status_code='ACTIVE'
        AND EXISTS(SELECT 1 FROM reproduction_birth b WHERE b.mother_id=a.id
          AND b.occurred_on+COALESCE(rs.max_milking_days,305)
            >= (now() AT TIME ZONE (SELECT timezone FROM property WHERE id=$1))::date)
      ORDER BY lower(a.name),a.id LIMIT 2000`,[context.propertyId]),
  ]);
  return { lactations:lactations.rows,milk:milk.rows,tanks:tanks.rows,births:births.rows,
    cows:cows.rows };
}

async function upsertMilkingState(client:PoolClient,context:PropertyContext,accountId:string,
  cowId:string,enabled:boolean,userId:string) {
  await client.query(`INSERT INTO milk_animal_state(cow_id,property_id,account_id,enabled,updated_by)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(cow_id) DO UPDATE SET
      enabled=EXCLUDED.enabled,updated_by=EXCLUDED.updated_by,updated_at=now()`,
  [cowId,context.propertyId,accountId,enabled,userId]);
}

async function ensureRecentBirth(client:PoolClient,context:PropertyContext,cowId:string,
  date:string,maxDays:number) {
  const result=await client.query(`SELECT 1 FROM reproduction_birth WHERE mother_id=$1
    AND property_id=$2 AND $3::date BETWEEN occurred_on AND occurred_on+$4::int LIMIT 1`,
  [cowId,context.propertyId,date,maxDays]);
  if(!result.rowCount)throw invalidRequest('MILKING_PERIOD_EXPIRED',
    `La vaca requiere un parto dentro de los últimos ${maxDays} días.`);
}

export async function setCowMilking(auth:AuthState,context:PropertyContext,cowId:string,
  inMilking:boolean,metadata:RequestMetadata) {
  try{return await inTransaction(async(client)=>{
    const {account_id:accountId,today,max_days:maxDays}=await access(client,auth,context,'PRODUCTION_MANAGE');
    const cow=await client.query(`SELECT id FROM animal WHERE id=$1 AND account_id=$2 AND property_id=$3
      AND sex='FEMALE' AND record_status='CURRENT' AND availability_status_code='ACTIVE' FOR UPDATE`,
    [cowId,accountId,context.propertyId]);
    if(!cow.rowCount)throw invalidRequest('COW_UNAVAILABLE','La vaca debe estar activa en esta propiedad.');
    if(inMilking)await ensureRecentBirth(client,context,cowId,today,maxDays);
    const prior=await client.query<{enabled:boolean}>(
      `SELECT enabled FROM milk_animal_state WHERE cow_id=$1`,[cowId]);
    const lactation=await client.query(`SELECT id FROM milk_lactation WHERE cow_id=$1
      AND property_id=$2 AND ended_on IS NULL FOR UPDATE`,[cowId,context.propertyId]);
    if(lactation.rows[0])await client.query(`UPDATE milk_lactation SET in_milking=$2,updated_at=now()
      WHERE id=$1`,[lactation.rows[0].id,inMilking]);
    await upsertMilkingState(client,context,accountId,cowId,inMilking,auth.userId);
    await audit(client,auth,context,metadata,'COW_MILKING_CHANGED','ANIMAL',cowId,
      {inMilking:prior.rows[0]?.enabled??false},{inMilking});
    return {cowId,inMilking};
  });}catch(error){return translate(error);}
}

export async function createLactation(auth: AuthState, context: PropertyContext,
  input: LactationInput, metadata: RequestMetadata) {
  try { return await inTransaction(async (client) => {
    const { account_id: accountId, today, max_days: maxDays } = await access(client,auth,context,'PRODUCTION_MANAGE');
    const birth = await client.query<{ mother_id: string; started_on: string }>(
      `SELECT mother_id,occurred_on::text AS started_on FROM reproduction_birth
       WHERE id=$1 AND property_id=$2 AND account_id=$3`,[input.birthId,context.propertyId,accountId]);
    if (!birth.rows[0]) throw invalidRequest('BIRTH_UNAVAILABLE','Selecciona un parto de esta propiedad.');
    const { mother_id:cowId,started_on:startedOn } = birth.rows[0];
    await client.query(`SELECT id FROM animal WHERE id=$1 AND property_id=$2 FOR UPDATE`,[cowId,context.propertyId]);
    if (input.endedOn && (input.endedOn < startedOn || input.endedOn > today))
      throw invalidRequest('LACTATION_DATES_INVALID','La fecha de cierre debe estar entre el parto y hoy.');
    const limit = await client.query<{ limit_on: string }>(
      `SELECT ($1::date+$2::int)::text AS limit_on`,[startedOn,maxDays]);
    if ((input.endedOn ?? today) > limit.rows[0]!.limit_on)
      throw invalidRequest('MILKING_PERIOD_EXPIRED',
        `La lactancia no puede superar ${maxDays} días después del parto.`);
    const result = await client.query<{ id: string }>(
      `INSERT INTO milk_lactation(account_id,property_id,cow_id,birth_id,started_on,
        ended_on,in_milking,notes,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [accountId,context.propertyId,cowId,input.birthId,startedOn,input.endedOn ?? null,
        input.inMilking,input.notes ?? null,auth.userId]);
    const created={id:result.rows[0]!.id,cowId,birthId:input.birthId,startedOn,
      endedOn:input.endedOn ?? null,inMilking:input.inMilking,notes:input.notes ?? null};
    await upsertMilkingState(client,context,accountId,cowId,input.inMilking,auth.userId);
    await audit(client,auth,context,metadata,'MILK_LACTATION_CREATED','MILK_LACTATION',created.id,null,created);
    return created;
  }); } catch(error) { return translate(error); }
}

export async function finishLactation(auth: AuthState,context:PropertyContext,id:string,
  endedOn:string,metadata:RequestMetadata) {
  try { return await inTransaction(async(client)=>{
    const { account_id:accountId,today,max_days:maxDays }=await access(client,auth,context,'PRODUCTION_MANAGE');
    const lactation=await client.query<{cow_id:string;started_on:string}>(
      `SELECT cow_id,started_on::text FROM milk_lactation WHERE id=$1 AND property_id=$2
        AND ended_on IS NULL FOR UPDATE`,[id,context.propertyId]);
    const row=lactation.rows[0];
    if (!row) throw new ApiError(404,'LACTATION_NOT_FOUND','La lactancia activa no está disponible.');
    const latest=await client.query<{produced_on:string}>(
      `SELECT max(produced_on)::text AS produced_on FROM milk_production WHERE lactation_id=$1`,[id]);
    const upper=(await client.query<{limit_on:string}>(
      `SELECT ($1::date+$2::int)::text AS limit_on`,[row.started_on,maxDays])).rows[0]!.limit_on;
    if (endedOn < row.started_on || endedOn > today || endedOn > upper
      || (latest.rows[0]?.produced_on && endedOn < latest.rows[0].produced_on))
      throw invalidRequest('LACTATION_DATES_INVALID',
        'El cierre debe incluir los ordeños registrados y respetar el límite posparto.');
    await client.query(`UPDATE milk_lactation SET ended_on=$2,in_milking=false,updated_at=now()
      WHERE id=$1`,[id,endedOn]);
    await upsertMilkingState(client,context,accountId,row.cow_id,false,auth.userId);
    await audit(client,auth,context,metadata,'MILK_LACTATION_FINISHED','MILK_LACTATION',id,
      {id,endedOn:null},{id,endedOn,inMilking:false});
    return {id,endedOn,inMilking:false};
  }); } catch(error) {return translate(error);}
}

export async function setLactationMilking(auth:AuthState,context:PropertyContext,id:string,
  inMilking:boolean,metadata:RequestMetadata) {
  return inTransaction(async(client)=>{
    const {account_id:accountId,today,max_days:maxDays}=await access(client,auth,context,'PRODUCTION_MANAGE');
    const result=await client.query<{cow_id:string;started_on:string;in_milking:boolean}>(
      `SELECT cow_id,started_on::text,in_milking FROM milk_lactation WHERE id=$1
       AND property_id=$2 AND ended_on IS NULL FOR UPDATE`,[id,context.propertyId]);
    const row=result.rows[0];
    if(!row)throw new ApiError(404,'LACTATION_NOT_FOUND','La lactancia activa no está disponible.');
    const upper=(await client.query<{limit_on:string}>(
      `SELECT ($1::date+$2::int)::text AS limit_on`,[row.started_on,maxDays])).rows[0]!.limit_on;
    if(inMilking && today>upper)throw invalidRequest('MILKING_PERIOD_EXPIRED',
      `No se puede ordeñar después de ${maxDays} días desde el parto.`);
    await client.query(`UPDATE milk_lactation SET in_milking=$2,updated_at=now() WHERE id=$1`,[id,inMilking]);
    await upsertMilkingState(client,context,accountId,row.cow_id,inMilking,auth.userId);
    await audit(client,auth,context,metadata,'MILK_LACTATION_MILKING_CHANGED','MILK_LACTATION',id,
      {inMilking:row.in_milking},{inMilking});
    return {id,inMilking};
  });
}

export async function recordMilk(auth:AuthState,context:PropertyContext,input:MilkInput,
  metadata:RequestMetadata) {
  try {return await inTransaction(async(client)=>{
    const {account_id:accountId,today,max_days:maxDays}=await access(client,auth,context,'PRODUCTION_MANAGE');
    if(input.producedOn>today)throw invalidRequest('FUTURE_PRODUCTION_DATE','La fecha no puede ser futura.');
    const selected=input.lactationId ? await client.query<{cow_id:string}>(
      `SELECT cow_id FROM milk_lactation WHERE id=$1 AND account_id=$2 AND property_id=$3`,
      [input.lactationId,accountId,context.propertyId]) : null;
    if(input.lactationId && !selected?.rows[0])
      throw invalidRequest('MILKING_UNAVAILABLE','La lactancia no está disponible.');
    const cowId=input.cowId ?? selected?.rows[0]?.cow_id;
    if(!cowId || (selected?.rows[0] && selected.rows[0].cow_id!==cowId))
      throw invalidRequest('COW_UNAVAILABLE','La vaca y la lactancia deben coincidir.');
    const animal=await client.query(`SELECT 1 FROM animal WHERE id=$1 AND account_id=$2 AND property_id=$3
      AND sex='FEMALE' AND record_status='CURRENT' AND availability_status_code='ACTIVE' FOR UPDATE`,
    [cowId,accountId,context.propertyId]);
    if(!animal.rowCount)throw invalidRequest('COW_UNAVAILABLE','La vaca debe estar activa en esta propiedad.');
    const state=await client.query<{enabled:boolean}>(
      `SELECT enabled FROM milk_animal_state WHERE cow_id=$1 AND account_id=$2 AND property_id=$3`,
      [cowId,accountId,context.propertyId]);
    if(!state.rows[0]?.enabled)
      throw invalidRequest('MILKING_UNAVAILABLE','La vaca debe estar en ordeño.');
    await ensureRecentBirth(client,context,cowId,input.producedOn,maxDays);
    const open=await client.query<{id:string;started_on:string;in_milking:boolean}>(
      `SELECT id,started_on::text,in_milking FROM milk_lactation WHERE cow_id=$1
       AND account_id=$2 AND property_id=$3 AND ended_on IS NULL FOR UPDATE`,
      [cowId,accountId,context.propertyId]);
    const row=open.rows[0];
    if(input.lactationId && input.lactationId!==row?.id || row && !row.in_milking)
      throw invalidRequest('MILKING_UNAVAILABLE','Selecciona una lactancia abierta y en ordeño.');
    if(row && input.producedOn<row.started_on)
      throw invalidRequest('MILKING_PERIOD_EXPIRED','El ordeño debe ser posterior al parto de la lactancia.');
    const lactationId=row?.id??null;
    const result=await client.query<{id:string}>(
      `INSERT INTO milk_production(account_id,property_id,cow_id,lactation_id,
        produced_on,shift,liters,source,external_reference,notes,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [accountId,context.propertyId,cowId,lactationId,input.producedOn,
        input.shift,input.liters,input.source,input.externalReference ?? null,input.notes ?? null,auth.userId]);
    const created={id:result.rows[0]!.id,...input,cowId,lactationId};
    await audit(client,auth,context,metadata,'MILK_PRODUCTION_RECORDED','MILK_PRODUCTION',created.id,null,created);
    return created;
  });}catch(error){return translate(error);}
}

export async function recordTank(auth:AuthState,context:PropertyContext,input:TankInput,
  metadata:RequestMetadata) {
  try{return await inTransaction(async(client)=>{
    const {account_id:accountId,today}=await access(client,auth,context,'PRODUCTION_MANAGE');
    if(input.producedOn>today)throw invalidRequest('FUTURE_PRODUCTION_DATE','La fecha no puede ser futura.');
    const result=await client.query<{id:string}>(
      `INSERT INTO milk_tank_production(account_id,property_id,produced_on,
        shift,liters,source,external_reference,notes,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [accountId,context.propertyId,input.producedOn,input.shift,input.liters,
        input.source,input.externalReference ?? null,input.notes ?? null,auth.userId]);
    const created={id:result.rows[0]!.id,...input};
    await audit(client,auth,context,metadata,'MILK_TANK_RECORDED','MILK_TANK_PRODUCTION',created.id,null,created);
    return created;
  });}catch(error){return translate(error);}
}
