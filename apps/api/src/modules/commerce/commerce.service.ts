import type {PoolClient} from 'pg';
import {ApiError,conflict,forbidden,invalidRequest} from '../../core/errors.js';
import {pool} from '../../database/pool.js';
import {inTransaction} from '../../database/transaction.js';
import type {AuthState,PropertyContext,RequestMetadata} from '../auth/auth.types.js';

type Line={animalId?:string|undefined;productId?:string|undefined;productName?:string|undefined;
  quantity:number;unit:string;unitPrice:number;
  animalEffect?:'KEEP_CURRENT_PROPERTY'|'EXIT_CURRENT_PROPERTY'|undefined};
type Input={kind:'SALE'|'PURCHASE';tradedOn:string;buyerId?:string|undefined;
  counterpartyName?:string|undefined;
  counterpartyContact?:string|null|undefined;destination?:string|null|undefined;
  notes?:string|null|undefined;lines:Line[]};
const select=`SELECT r.id,r.kind,r.traded_on::text AS "tradedOn",
 r.counterparty_name AS "counterpartyName",r.counterparty_contact AS "counterpartyContact",
 r.destination,r.currency,r.notes,r.total::float8 AS total,r.status,
 r.buyer_catalog_item_id AS "buyerId",
 r.cancellation_reason AS "cancellationReason",r.created_at AS "createdAt",
 u.display_name AS "registeredBy",
 coalesce((SELECT jsonb_agg(jsonb_build_object('id',l.id,'animalId',l.animal_id,
 'animalName',a.name,'productName',l.product_name,'productId',l.product_catalog_item_id,
 'quantity',l.quantity::float8,
 'unit',l.unit,'unitPrice',l.unit_price::float8,'animalEffect',l.animal_effect)
 ORDER BY l.id) FROM commerce_line l LEFT JOIN animal a ON a.id=l.animal_id
 WHERE l.record_id=r.id),'[]'::jsonb) AS lines
 FROM commerce_record r JOIN app_user u ON u.id=r.created_by`;
async function read(client:PoolClient,context:PropertyContext,id:string){
  const row=(await client.query(`${select} WHERE r.property_id=$1 AND r.id=$2`,
    [context.propertyId,id])).rows[0];
  if(!row)throw new ApiError(404,'COMMERCE_NOT_FOUND','Operación no encontrada en esta propiedad.');
  return row;
}
export async function listCommerce(context:PropertyContext){
  return (await pool.query(`${select} WHERE r.property_id=$1
    ORDER BY r.traded_on DESC,r.created_at DESC LIMIT 2000`,[context.propertyId])).rows;
}
export async function listCommerceAnimals(context:PropertyContext){
  return (await pool.query(`SELECT id,name,ear_tag_code AS "earTagCode",
    availability_status_code AS status FROM animal
    WHERE property_id=$1 AND record_status='CURRENT' AND availability_status_code='ACTIVE'
    ORDER BY lower(name),id LIMIT 5000`,[context.propertyId])).rows;
}
async function access(client:PoolClient,auth:AuthState,context:PropertyContext){
  const row=(await client.query<{account_id:string;today:string;timezone:string}>(`
    SELECT p.account_id,p.timezone,(now() AT TIME ZONE p.timezone)::date::text AS today
    FROM property p JOIN administrative_account aa ON aa.id=p.account_id AND aa.status='ACTIVE'
    JOIN property_membership pm ON pm.property_id=p.id AND pm.user_id=$2 AND pm.status='ACTIVE'
    JOIN membership_role mr ON mr.membership_id=pm.id AND mr.property_id=p.id
    JOIN property_role pr ON pr.id=mr.role_id AND pr.property_id=p.id AND pr.active
    JOIN role_permission rp ON rp.role_id=pr.id AND rp.permission_code='COMMERCE_MANAGE'
    JOIN effective_property_module epm ON epm.property_id=p.id AND epm.module_code='SALES_PURCHASES'
      AND epm.enabled
    WHERE p.id=$1 AND pr.id=$3 AND p.status='ACTIVE' AND p.deleted_at IS NULL
    FOR SHARE OF p,pm,pr`,[context.propertyId,auth.userId,context.roleId])).rows[0];
  if(!row)throw forbidden('COMMERCE_DENIED','El módulo o el rol activo no permite gestionar ventas y compras.');
  return row;
}
async function audit(client:PoolClient,auth:AuthState,context:PropertyContext,
  meta:RequestMetadata,action:string,id:string,before:unknown,after:unknown){
  await client.query(`INSERT INTO audit_event(actor_user_id,property_id,active_role_id,
    action,entity_type,entity_id,before_data,after_data,ip_address,user_agent)
    VALUES($1,$2,$3,$4,'COMMERCE_RECORD',$5,$6::jsonb,$7::jsonb,$8,$9)`,
    [auth.userId,context.propertyId,context.roleId,action,id,
      before===null?null:JSON.stringify(before),JSON.stringify(after),meta.ipAddress,meta.userAgent]);
}
function translate(reason:unknown):never{
  const code=(reason as {code?:string}).code;
  if(code==='40001')throw conflict('COMMERCE_ANIMAL_CHANGED','El animal cambió. Actualiza la lista e inténtalo de nuevo.');
  if(code==='23503'||code==='23514'||code==='22007')
    throw invalidRequest('COMMERCE_INVALID',reason instanceof Error?reason.message:'Datos comerciales inválidos.');
  if(code==='42501')throw forbidden('COMMERCE_ANIMAL_DENIED',
    'El rol activo no permite registrar la salida de animales.');
  throw reason;
}
export async function createCommerce(auth:AuthState,context:PropertyContext,input:Input,
  meta:RequestMetadata){
  try{return await inTransaction(async client=>{
    const {account_id:accountId,today,timezone}=await access(client,auth,context);
    let buyer:{id:string;name:string}|undefined;
    if(input.kind==='SALE'){
      buyer=(await client.query<{id:string;name:string}>(`SELECT id,name FROM governed_catalog_item
        WHERE id=$1 AND catalog_code='BUYERS' AND account_id=$2 AND active AND deleted_at IS NULL
        FOR SHARE`,[input.buyerId,accountId])).rows[0];
      if(!buyer)throw invalidRequest('COMMERCE_BUYER_UNAVAILABLE',
        'Selecciona un comprador activo de tu cuenta.');
    }
    const counterpartyName=buyer?.name??input.counterpartyName!;
    if(input.tradedOn>today)throw invalidRequest('COMMERCE_FUTURE_DATE',
      'La fecha de la operación no puede ser futura.');
    if(input.lines.some(line=>line.animalId&&input.kind==='SALE'&&!line.animalEffect))
      throw invalidRequest('COMMERCE_EFFECT_REQUIRED','Indica si cada animal vendido permanece o sale.');
    // Prices have two decimals; totals are recomputed on the server.
    if(input.lines.some(line=>!/^\d+(\.\d{1,2})?$/.test(String(line.unitPrice))||
      !/^\d+(\.\d{1,3})?$/.test(String(line.quantity))))
      throw invalidRequest('COMMERCE_PRECISION','Precio admite dos decimales y cantidad tres.');
    const total=input.lines.reduce((sum,line)=>sum+Math.round(line.quantity*line.unitPrice*100),0)/100;
    if(total>999999999999.99)throw invalidRequest('COMMERCE_TOTAL','Total fuera de rango.');
    const created=(await client.query<{id:string}>(`INSERT INTO commerce_record
      (account_id,property_id,kind,traded_on,counterparty_name,counterparty_contact,
       destination,notes,total,created_by,buyer_catalog_item_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [accountId,context.propertyId,input.kind,input.tradedOn,counterpartyName,
        input.counterpartyContact??null,input.destination??null,input.notes??null,total,
        auth.userId,buyer?.id??null])).rows[0]!;
    for(const line of input.lines){
      let eventId:string|null=null;
      let product:{id:string;name:string}|undefined;
      if(input.kind==='SALE'&&!line.animalId){
        product=(await client.query<{id:string;name:string}>(`SELECT id,name FROM governed_catalog_item
          WHERE id=$1 AND catalog_code='SALE_PRODUCTS' AND account_id=$2 AND active
            AND deleted_at IS NULL FOR SHARE`,[line.productId,accountId])).rows[0];
        if(!product)throw invalidRequest('COMMERCE_PRODUCT_UNAVAILABLE',
          'Selecciona un producto de venta activo de tu cuenta.');
      }
      if(line.animalId){
        const animal=(await client.query<{version:number}>(`SELECT version::int FROM animal
          WHERE id=$1 AND account_id=$2 AND property_id=$3 AND record_status='CURRENT'
            AND availability_status_code='ACTIVE' FOR UPDATE`,
          [line.animalId,accountId,context.propertyId])).rows[0];
        if(!animal)throw conflict('COMMERCE_ANIMAL_UNAVAILABLE',
          'El animal ya no está activo en la propiedad.');
        if(input.kind==='SALE'&&line.animalEffect==='EXIT_CURRENT_PROPERTY'){
          const occurredAt=(await client.query<{at:Date}>(`SELECT CASE WHEN $1::date=$2::date
            THEN now() ELSE ($1::date::timestamp+interval '12 hours') AT TIME ZONE $3 END AS at`,
            [input.tradedOn,today,timezone])).rows[0]!.at;
          await client.query(`SELECT change_animal_status($1,$2,$3,'EXITED',
            'RECORD_EXIT',$4,'SALE',$5,NULL,$6)`,[line.animalId,auth.userId,
            context.roleId,`Venta a ${counterpartyName}`,occurredAt,animal.version]);
          eventId=(await client.query<{id:string}>(`SELECT id FROM animal_status_event
            WHERE animal_id=$1 AND action_code='RECORD_EXIT'
            ORDER BY created_at DESC,id DESC LIMIT 1`,[line.animalId])).rows[0]!.id;
        }
      }
      await client.query(`INSERT INTO commerce_line(record_id,animal_id,product_name,
        quantity,unit,unit_price,animal_effect,exit_event_id,product_catalog_item_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [created.id,line.animalId??null,product?.name??line.productName??null,
          line.quantity,line.unit,line.unitPrice,line.animalEffect??null,eventId,
          product?.id??null]);
    }
    const after=await read(client,context,created.id);
    await audit(client,auth,context,meta,'COMMERCE_CREATED',created.id,null,after);
    return after;
  });}catch(reason){translate(reason);}
}
export async function cancelCommerce(auth:AuthState,context:PropertyContext,id:string,
  reason:string,meta:RequestMetadata){
  try{return await inTransaction(async client=>{
    await access(client,auth,context);
    const locked=(await client.query<{status:string}>(`SELECT status FROM commerce_record
      WHERE id=$1 AND property_id=$2 FOR UPDATE`,[id,context.propertyId])).rows[0];
    if(!locked)throw new ApiError(404,'COMMERCE_NOT_FOUND','Operación no encontrada.');
    if(locked.status!=='ACTIVE')throw conflict('COMMERCE_CANCELLED','La operación ya fue anulada.');
    const before=await read(client,context,id);
    const exits=(await client.query<{animal_id:string;exit_event_id:string}>(`
      SELECT animal_id,exit_event_id FROM commerce_line WHERE record_id=$1
        AND exit_event_id IS NOT NULL ORDER BY animal_id`,[id])).rows;
    for(const exit of exits){
      const animal=(await client.query<{version:number;availability_status_code:string}>(`
        SELECT version::int,availability_status_code FROM animal WHERE id=$1
        AND property_id=$2 FOR UPDATE`,[exit.animal_id,context.propertyId])).rows[0];
      if(!animal||animal.availability_status_code!=='EXITED')throw conflict('COMMERCE_RESTORE_BLOCKED',
        'El animal ya no está en estado de salida; revisa su historial antes de anular.');
      await client.query(`SELECT change_animal_status($1,$2,$3,'ACTIVE',
        'REVERSE_EXIT',$4,NULL,now(),$5,$6)`,[exit.animal_id,auth.userId,context.roleId,
          reason,exit.exit_event_id,animal.version]);
    }
    await client.query(`UPDATE commerce_record SET status='CANCELLED',cancelled_at=now(),
      cancelled_by=$2,cancellation_reason=$3 WHERE id=$1`,[id,auth.userId,reason]);
    const after=await read(client,context,id);
    await audit(client,auth,context,meta,'COMMERCE_CANCELLED',id,before,after);
    return after;
  });}catch(error){translate(error);}
}
