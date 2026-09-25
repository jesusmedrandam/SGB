import type {PoolClient} from 'pg';
import {ApiError,conflict,forbidden,invalidRequest} from '../../core/errors.js';
import {pool} from '../../database/pool.js';
import {inTransaction} from '../../database/transaction.js';
import type {AuthState,PropertyContext,RequestMetadata} from '../auth/auth.types.js';

type Scope='PROPERTY'|'PERSONAL';
type AccountInput={name:string;kind:'CASH'|'BANK'|'WALLET'|'CREDIT_CARD'|'OTHER';openingBalance:number};
type MovementInput={kind:'INCOME'|'EXPENSE'|'TRANSFER';sourceAccountId:string|null;
  destinationAccountId:string|null;amount:number;occurredOn:string;category:string|null;
  concept:string;notes:string|null};
const scopeId=(auth:AuthState,context:PropertyContext|undefined,scope:Scope)=>
  scope==='PERSONAL'?auth.userId:context!.propertyId;
const column=(scope:Scope)=>scope==='PERSONAL'?'user_id':'property_id';
export async function personalEnabled(auth:AuthState){
  const row=(await pool.query(`SELECT 1 FROM effective_user_module
    WHERE user_id=$1 AND module_code='PERSONAL_FINANCE' AND enabled`,[auth.userId])).rows[0];
  if(!row)throw forbidden('PERSONAL_FINANCE_DISABLED','Mis finanzas está desactivado para tu cuenta.');
}
async function access(client:PoolClient,auth:AuthState,context:PropertyContext|undefined,scope:Scope){
  if(scope==='PERSONAL'){
    const row=(await client.query(`SELECT 1 FROM effective_user_module
      WHERE user_id=$1 AND module_code='PERSONAL_FINANCE' AND enabled`,[auth.userId])).rows[0];
    if(!row)throw forbidden('PERSONAL_FINANCE_DISABLED','Mis finanzas está desactivado.');
    return;
  }
  const row=(await client.query(`SELECT 1 FROM property p
    JOIN administrative_account aa ON aa.id=p.account_id AND aa.status='ACTIVE'
    JOIN property_membership pm ON pm.property_id=p.id AND pm.user_id=$2 AND pm.status='ACTIVE'
    JOIN membership_role mr ON mr.membership_id=pm.id AND mr.property_id=p.id
    JOIN property_role pr ON pr.id=mr.role_id AND pr.property_id=p.id AND pr.active
    JOIN role_permission rp ON rp.role_id=pr.id AND rp.permission_code='FINANCE_MANAGE'
    JOIN effective_property_module epm ON epm.property_id=p.id
      AND epm.module_code='PROPERTY_FINANCE' AND epm.enabled
    WHERE p.id=$1 AND pr.id=$3 AND p.status='ACTIVE' AND p.deleted_at IS NULL
    FOR SHARE OF p,pm,pr`,[context!.propertyId,auth.userId,context!.roleId])).rows[0];
  if(!row)throw forbidden('FINANCE_DENIED','El rol activo no permite gestionar estas finanzas.');
}
async function audit(client:PoolClient,auth:AuthState,context:PropertyContext|undefined,
  scope:Scope,meta:RequestMetadata,action:string,entityType:string,id:string,
  before:unknown,after:unknown){
  await client.query(`INSERT INTO audit_event(actor_user_id,property_id,active_role_id,
    action,entity_type,entity_id,before_data,after_data,ip_address,user_agent)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)`,
    [auth.userId,scope==='PROPERTY'?context!.propertyId:null,
      scope==='PROPERTY'?context!.roleId:null,action,entityType,id,
      before===null?null:JSON.stringify(before),JSON.stringify(after),meta.ipAddress,meta.userAgent]);
}
function translate(reason:unknown):never{
  const code=(reason as {code?:string}).code;
  if(code==='23505')throw conflict('FINANCE_DUPLICATE','Ya existe una cuenta financiera con ese nombre.');
  if(code==='23503'||code==='23514')throw invalidRequest('FINANCE_INVALID',
    'Las cuentas, el importe o los datos del movimiento ya no son válidos.');
  throw reason;
}
const accountSelect=`SELECT a.id,a.name,a.kind,a.opening_balance::float8 AS "openingBalance",
 a.active,a.created_at AS "createdAt",
 (a.opening_balance+coalesce((SELECT sum(CASE WHEN m.destination_account_id=a.id THEN
    m.amount ELSE -m.amount END) FROM finance_movement m WHERE m.cancelled_at IS NULL
    AND (m.source_account_id=a.id OR m.destination_account_id=a.id)),0))::float8 AS balance
 FROM finance_account a`;
export async function financeAccounts(auth:AuthState,context:PropertyContext|undefined,scope:Scope){
  return (await pool.query(`${accountSelect} WHERE a.scope=$1 AND a.${column(scope)}=$2
    ORDER BY a.active DESC,lower(a.name)`,[scope,scopeId(auth,context,scope)])).rows;
}
const movementSelect=`SELECT m.id,m.kind,m.source_account_id AS "sourceAccountId",
 m.destination_account_id AS "destinationAccountId",s.name AS "sourceAccountName",
 d.name AS "destinationAccountName",m.amount::float8 AS amount,m.occurred_on::text AS "occurredOn",
 m.category,m.concept,m.notes,m.cancelled_at AS "cancelledAt",
 m.cancellation_reason AS "cancellationReason",m.created_at AS "createdAt"
 FROM finance_movement m LEFT JOIN finance_account s ON s.id=m.source_account_id
 LEFT JOIN finance_account d ON d.id=m.destination_account_id`;
export async function financeMovements(auth:AuthState,context:PropertyContext|undefined,scope:Scope){
  return (await pool.query(`${movementSelect} WHERE m.scope=$1 AND m.${column(scope)}=$2
    ORDER BY m.occurred_on DESC,m.created_at DESC LIMIT 2000`,
    [scope,scopeId(auth,context,scope)])).rows;
}
async function readAccount(client:PoolClient,scope:Scope,idValue:string,id:string){
  const row=(await client.query(`${accountSelect} WHERE a.scope=$1 AND a.${column(scope)}=$2
    AND a.id=$3`,[scope,idValue,id])).rows[0];
  if(!row)throw new ApiError(404,'FINANCE_ACCOUNT_NOT_FOUND','Cuenta financiera no encontrada.');
  return row;
}
async function readMovement(client:PoolClient,scope:Scope,idValue:string,id:string){
  const row=(await client.query(`${movementSelect} WHERE m.scope=$1 AND m.${column(scope)}=$2
    AND m.id=$3`,[scope,idValue,id])).rows[0];
  if(!row)throw new ApiError(404,'FINANCE_MOVEMENT_NOT_FOUND','Movimiento no encontrado.');
  return row;
}
export async function createFinanceAccount(auth:AuthState,context:PropertyContext|undefined,
  scope:Scope,input:AccountInput,meta:RequestMetadata){
  try{return await inTransaction(async client=>{
    await access(client,auth,context,scope);const owner=scopeId(auth,context,scope);
    const row=(await client.query<{id:string}>(`INSERT INTO finance_account
      (scope,property_id,user_id,name,kind,opening_balance,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[scope,scope==='PROPERTY'?owner:null,
        scope==='PERSONAL'?owner:null,input.name,input.kind,input.openingBalance,auth.userId])).rows[0]!;
    const after=await readAccount(client,scope,owner,row.id);
    await audit(client,auth,context,scope,meta,'FINANCE_ACCOUNT_CREATED','FINANCE_ACCOUNT',row.id,null,after);
    return after;
  });}catch(error){translate(error);}
}
export async function updateFinanceAccount(auth:AuthState,context:PropertyContext|undefined,
  scope:Scope,id:string,input:Pick<AccountInput,'name'|'kind'>&{active:boolean},meta:RequestMetadata){
  try{return await inTransaction(async client=>{
    await access(client,auth,context,scope);const owner=scopeId(auth,context,scope);
    const before=await readAccount(client,scope,owner,id);
    await client.query(`UPDATE finance_account SET name=$4,kind=$5,active=$6
      WHERE id=$3 AND scope=$1 AND ${column(scope)}=$2`,
      [scope,owner,id,input.name,input.kind,input.active]);
    const after=await readAccount(client,scope,owner,id);
    await audit(client,auth,context,scope,meta,'FINANCE_ACCOUNT_UPDATED','FINANCE_ACCOUNT',id,before,after);
    return after;
  });}catch(error){translate(error);}
}
export async function createFinanceMovement(auth:AuthState,context:PropertyContext|undefined,
  scope:Scope,input:MovementInput,meta:RequestMetadata){
  const valid=input.kind==='INCOME'?!input.sourceAccountId&&!!input.destinationAccountId:
    input.kind==='EXPENSE'?!!input.sourceAccountId&&!input.destinationAccountId:
      !!input.sourceAccountId&&!!input.destinationAccountId&&input.sourceAccountId!==input.destinationAccountId;
  if(!valid)throw invalidRequest('FINANCE_ACCOUNTS_INVALID','Selecciona las cuentas que corresponden al movimiento.');
  try{return await inTransaction(async client=>{
    await access(client,auth,context,scope);const owner=scopeId(auth,context,scope);
    const today=(await client.query<{today:string}>(scope==='PROPERTY'?`SELECT
      (now() AT TIME ZONE timezone)::date::text AS today FROM property WHERE id=$1`:
      `SELECT (now() AT TIME ZONE 'America/Guayaquil')::date::text AS today`,
      scope==='PROPERTY'?[owner]:[])).rows[0]!.today;
    if(input.occurredOn>today)throw invalidRequest('FINANCE_FUTURE_DATE',
      'La fecha del movimiento no puede ser futura.');
    const ids=[...new Set([input.sourceAccountId,input.destinationAccountId].filter(
      (value):value is string=>Boolean(value)))].sort();
    const accounts=(await client.query<{id:string;active:boolean}>(`SELECT id,active
      FROM finance_account WHERE scope=$1 AND ${column(scope)}=$2
        AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE`,[scope,owner,ids])).rows;
    if(accounts.length!==ids.length||accounts.some(account=>!account.active))
      throw invalidRequest('FINANCE_ACCOUNT_DISABLED','Selecciona cuentas activas de este ámbito.');
    const row=(await client.query<{id:string}>(`INSERT INTO finance_movement
      (scope,property_id,user_id,kind,source_account_id,destination_account_id,
       amount,occurred_on,category,concept,notes,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [scope,scope==='PROPERTY'?owner:null,scope==='PERSONAL'?owner:null,input.kind,
        input.sourceAccountId,input.destinationAccountId,input.amount,input.occurredOn,
        input.category,input.concept,input.notes,auth.userId])).rows[0]!;
    const after=await readMovement(client,scope,owner,row.id);
    await audit(client,auth,context,scope,meta,'FINANCE_MOVEMENT_CREATED','FINANCE_MOVEMENT',row.id,null,after);
    return after;
  });}catch(error){translate(error);}
}
export async function cancelFinanceMovement(auth:AuthState,context:PropertyContext|undefined,
  scope:Scope,id:string,reason:string,meta:RequestMetadata){
  try{return await inTransaction(async client=>{
    await access(client,auth,context,scope);const owner=scopeId(auth,context,scope);
    const row=(await client.query<{cancelled_at:Date|null}>(`SELECT cancelled_at FROM finance_movement
      WHERE id=$1 AND scope=$2 AND ${column(scope)}=$3 FOR UPDATE`,[id,scope,owner])).rows[0];
    if(!row)throw new ApiError(404,'FINANCE_MOVEMENT_NOT_FOUND','Movimiento no encontrado.');
    if(row.cancelled_at)throw conflict('FINANCE_MOVEMENT_CANCELLED','El movimiento ya está anulado.');
    const before=await readMovement(client,scope,owner,id);
    await client.query(`UPDATE finance_movement SET cancelled_at=now(),cancelled_by=$2,
      cancellation_reason=$3 WHERE id=$1`,[id,auth.userId,reason]);
    const after=await readMovement(client,scope,owner,id);
    await audit(client,auth,context,scope,meta,'FINANCE_MOVEMENT_CANCELLED','FINANCE_MOVEMENT',id,before,after);
    return after;
  });}catch(error){translate(error);}
}
