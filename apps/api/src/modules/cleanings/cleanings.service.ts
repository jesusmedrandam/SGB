import type {PoolClient} from 'pg';
import {ApiError,conflict,forbidden,invalidRequest} from '../../core/errors.js';
import {pool} from '../../database/pool.js';
import {inTransaction} from '../../database/transaction.js';
import type {AuthState,PropertyContext,RequestMetadata} from '../auth/auth.types.js';
import type {CleaningInput,ProductInput} from './cleanings.schemas.js';

async function access(client:PoolClient,auth:AuthState,context:PropertyContext,permission:string){
  const row=(await client.query<{account_id:string;today:string}>(
    `SELECT p.account_id,(now() AT TIME ZONE p.timezone)::date::text AS today
     FROM property p JOIN administrative_account aa ON aa.id=p.account_id AND aa.status='ACTIVE'
     JOIN property_membership pm ON pm.property_id=p.id AND pm.user_id=$2 AND pm.status='ACTIVE'
     JOIN membership_role mr ON mr.membership_id=pm.id AND mr.property_id=p.id
     JOIN property_role pr ON pr.id=mr.role_id AND pr.property_id=p.id AND pr.active
     JOIN role_permission rp ON rp.role_id=pr.id AND rp.permission_code=$4
     JOIN effective_property_module epm ON epm.property_id=p.id
       AND epm.module_code='PASTURE_CLEANING' AND epm.enabled
     JOIN effective_property_module pasture ON pasture.property_id=p.id
       AND pasture.module_code='PASTURES' AND pasture.enabled
     WHERE p.id=$1 AND pr.id=$3 AND p.status='ACTIVE' AND p.deleted_at IS NULL
     FOR SHARE OF p,pm,pr`,[context.propertyId,auth.userId,context.roleId,permission])).rows[0];
  if(!row)throw forbidden('CLEANING_DENIED','La limpieza de potreros o el rol no están habilitados.');
  return row;
}
async function audit(client:PoolClient,auth:AuthState,context:PropertyContext,
  metadata:RequestMetadata,action:string,id:string,before:unknown,after:unknown){
  await client.query(`INSERT INTO audit_event(actor_user_id,property_id,active_role_id,
    action,entity_type,entity_id,before_data,after_data,ip_address,user_agent)
    VALUES($1,$2,$3,$4,'CLEANING',$5,$6::jsonb,$7::jsonb,$8,$9)`,
    [auth.userId,context.propertyId,context.roleId,action,id,
      before===null?null:JSON.stringify(before),JSON.stringify(after),metadata.ipAddress,metadata.userAgent]);
}
export async function listProducts(context:PropertyContext){
  return (await pool.query(`SELECT p.id,p.name,p.category,p.active,
    p.active_ingredient AS "activeIngredient",p.formulated_by AS "formulatedBy",p.description
    FROM pasture_agrochemical p
    JOIN property property ON property.account_id=p.account_id WHERE property.id=$1
    ORDER BY p.active DESC,lower(p.name)`,[context.propertyId])).rows;
}
export async function createProduct(auth:AuthState,context:PropertyContext,input:ProductInput,
  metadata:RequestMetadata){
  return inTransaction(async(client)=>{
    const {account_id}=await access(client,auth,context,'CLEANING_MANAGE');
    if(input.category){
      const category=await client.query(`SELECT 1 FROM governed_catalog_item
        WHERE catalog_code='AGROCHEMICAL_CATEGORIES' AND name=$1 AND active AND deleted_at IS NULL
          AND (system_defined OR account_id=$2)`,[input.category,account_id]);
      if(!category.rowCount)throw invalidRequest('CLEANING_CATEGORY_INVALID',
        'Selecciona una categoría del catálogo.');
    }
    const row=(await client.query(`INSERT INTO pasture_agrochemical(account_id,name,category,
      active_ingredient,formulated_by,description,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,name,category,active,
        active_ingredient AS "activeIngredient",formulated_by AS "formulatedBy",description`,
      [account_id,input.name,input.category??null,input.activeIngredient??null,
        input.formulatedBy??null,input.description??null,auth.userId])).rows[0]!;
    await audit(client,auth,context,metadata,'CLEANING_PRODUCT_CREATED',row.id,null,row);
    return row;
  });
}
export async function listCleaningOptions(context:PropertyContext){
  const [locations,units]=await Promise.all([
    pool.query(`SELECT id,name,area_value AS "areaValue",area_unit_code AS "areaUnitCode"
      FROM physical_location WHERE property_id=$1 AND kind='PASTURE' AND active ORDER BY lower(name)`,
      [context.propertyId]),
    pool.query(`SELECT u.code,u.name,u.symbol FROM measurement_unit u
      WHERE u.code=ANY($1::varchar[]) AND u.active ORDER BY u.name`,
      [['MILLIGRAM','GRAM','KILOGRAM','MILLILITER','LITER','UNIT','DOSE']]),
  ]);
  return {locations:locations.rows,units:units.rows};
}
const fields=`c.id,c.location_id AS "locationId",l.name AS "locationName",
 c.started_on::text AS "startedOn",c.finished_on::text AS "finishedOn",
 c.activities,c.application_unit AS "applicationUnit",c.application_count AS "applicationCount",
 c.tank_capacity_liters AS "tankCapacityLiters",c.area_type AS "areaType",
 c.partial_percent AS "partialPercent",c.area_value AS "areaValue",
 c.area_unit_code AS "areaUnitCode",c.status,c.notes,c.version::int,
 c.created_at AS "createdAt",c.completed_at AS "completedAt",c.cancelled_at AS "cancelledAt",
 COALESCE((SELECT json_agg(json_build_object('productId',d.product_id,'productName',p.name,
   'unitCode',d.unit_code,'quantityPerApplication',d.quantity_per_application,
   'totalQuantity',d.total_quantity,'notes',d.notes) ORDER BY p.name)
   FROM pasture_cleaning_product d JOIN pasture_agrochemical p ON p.id=d.product_id
   WHERE d.cleaning_id=c.id),'[]'::json) AS products,
 COALESCE((SELECT json_agg(json_build_object('name',o.name,'function',o.function,
   'notes',o.notes) ORDER BY o.name) FROM pasture_cleaning_operator o
   WHERE o.cleaning_id=c.id),'[]'::json) AS operators`;
const joins=`FROM pasture_cleaning c JOIN physical_location l ON l.id=c.location_id`;
async function read(client:PoolClient,id:string){
  const row=(await client.query(`SELECT ${fields} ${joins} WHERE c.id=$1`,[id])).rows[0];
  if(!row)throw new ApiError(404,'CLEANING_NOT_FOUND','Limpieza no encontrada.');
  return row;
}
export async function listCleanings(context:PropertyContext){
  return (await pool.query(`SELECT ${fields} ${joins} WHERE c.property_id=$1
    ORDER BY c.started_on DESC,c.created_at DESC LIMIT 250`,[context.propertyId])).rows;
}
async function calculatedArea(client:PoolClient,context:PropertyContext,input:CleaningInput,
  accountId:string,today:string){
  if(input.startedOn>today || input.finishedOn && input.finishedOn>today)
    throw invalidRequest('CLEANING_FUTURE_DATE','Las fechas no pueden ser futuras.');
  const location=(await client.query<{area_value:string|null;area_unit_code:string|null}>(
    `SELECT area_value::text,area_unit_code FROM physical_location
      WHERE id=$1 AND account_id=$2 AND property_id=$3 AND kind='PASTURE' AND active FOR SHARE`,
      [input.locationId,accountId,context.propertyId])).rows[0];
  if(!location)throw invalidRequest('CLEANING_PASTURE_INVALID','Selecciona un potrero activo de la propiedad.');
  for(const item of input.products){
    const product=await client.query(`SELECT 1 FROM pasture_agrochemical WHERE id=$1
      AND account_id=$2 AND active FOR SHARE`,[item.productId,accountId]);
    if(!product.rowCount)throw invalidRequest('CLEANING_PRODUCT_INVALID',
      'Uno de los productos no está activo en esta cuenta.');
  }
  return {areaValue:location.area_value===null?null:Number((Number(location.area_value)
    *(input.areaType==='TOTAL'?1:(input.partialPercent??0)/100)).toFixed(4)),
    areaUnitCode:location.area_unit_code};
}
async function details(client:PoolClient,id:string,input:CleaningInput){
  await client.query('DELETE FROM pasture_cleaning_product WHERE cleaning_id=$1',[id]);
  await client.query('DELETE FROM pasture_cleaning_operator WHERE cleaning_id=$1',[id]);
  for(const product of input.products){
    await client.query(`INSERT INTO pasture_cleaning_product(cleaning_id,product_id,unit_code,
      quantity_per_application,total_quantity,notes) VALUES($1,$2,$3,$4,$5,$6)`,
      [id,product.productId,product.unitCode,product.quantityPerApplication,
        Number((product.quantityPerApplication*(input.applicationCount??0)).toFixed(4)),
        product.notes??null]);
  }
  for(const operator of input.operators){
    await client.query(`INSERT INTO pasture_cleaning_operator(cleaning_id,name,function,notes)
      VALUES($1,$2,$3,$4)`,[id,operator.name,operator.function??null,operator.notes??null]);
  }
}
export async function createCleaning(auth:AuthState,context:PropertyContext,input:CleaningInput,
  metadata:RequestMetadata){
  return inTransaction(async(client)=>{
    const {account_id,today}=await access(client,auth,context,'CLEANING_MANAGE');
    const area=await calculatedArea(client,context,input,account_id,today);
    const row=(await client.query<{id:string}>(`INSERT INTO pasture_cleaning(account_id,property_id,
      location_id,started_on,finished_on,activities,application_unit,application_count,
      tank_capacity_liters,area_type,partial_percent,area_value,area_unit_code,notes,
      created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
      RETURNING id`,[account_id,context.propertyId,input.locationId,input.startedOn,
      input.finishedOn??null,input.activities,input.applicationUnit??null,input.applicationCount??null,
      input.tankCapacityLiters??null,input.areaType,input.partialPercent??null,
      area.areaValue,area.areaValue===null?null:area.areaUnitCode,input.notes??null,auth.userId])).rows[0]!;
    await details(client,row.id,input);
    const after=await read(client,row.id);
    await audit(client,auth,context,metadata,'CLEANING_DRAFT_CREATED',row.id,null,after);
    return after;
  });
}
async function draft(client:PoolClient,context:PropertyContext,id:string){
  const row=(await client.query<{status:string;version:number}>(`SELECT status,version::int
    FROM pasture_cleaning WHERE id=$1 AND property_id=$2 FOR UPDATE`,
    [id,context.propertyId])).rows[0];
  if(!row)throw new ApiError(404,'CLEANING_NOT_FOUND','Limpieza no encontrada en esta propiedad.');
  if(row.status!=='BORRADOR')throw conflict('CLEANING_FINAL','La limpieza ya fue completada o cancelada.');
  return row;
}
export async function updateCleaning(auth:AuthState,context:PropertyContext,id:string,
  input:CleaningInput,metadata:RequestMetadata){
  return inTransaction(async(client)=>{
    const {account_id,today}=await access(client,auth,context,'CLEANING_MANAGE');
    const current=await draft(client,context,id);
    if(input.expectedVersion && input.expectedVersion!==current.version)
      throw conflict('CLEANING_VERSION_CONFLICT','El borrador cambió. Actualiza la pantalla.');
    const area=await calculatedArea(client,context,input,account_id,today);
    const before=await read(client,id);
    await client.query('DELETE FROM pasture_cleaning_product WHERE cleaning_id=$1',[id]);
    await client.query('DELETE FROM pasture_cleaning_operator WHERE cleaning_id=$1',[id]);
    await client.query(`UPDATE pasture_cleaning SET location_id=$2,started_on=$3,finished_on=$4,
      activities=$5,application_unit=$6,application_count=$7,tank_capacity_liters=$8,
      area_type=$9,partial_percent=$10,area_value=$11,area_unit_code=$12,notes=$13,updated_by=$14
      WHERE id=$1`,[id,input.locationId,input.startedOn,input.finishedOn??null,input.activities,
      input.applicationUnit??null,input.applicationCount??null,input.tankCapacityLiters??null,
      input.areaType,input.partialPercent??null,area.areaValue,
      area.areaValue===null?null:area.areaUnitCode,input.notes??null,auth.userId]);
    await details(client,id,input);
    const after=await read(client,id);
    await audit(client,auth,context,metadata,'CLEANING_DRAFT_UPDATED',id,before,after);
    return after;
  });
}
export async function applyCleaning(auth:AuthState,context:PropertyContext,id:string,
  metadata:RequestMetadata){
  return inTransaction(async(client)=>{
    const {account_id,today}=await access(client,auth,context,'CLEANING_MANAGE');
    await draft(client,context,id);
    const before=await read(client,id);
    const location=await client.query(`SELECT 1 FROM physical_location WHERE id=$1
      AND account_id=$2 AND property_id=$3 AND kind='PASTURE' AND active FOR SHARE`,
      [before.locationId,account_id,context.propertyId]);
    if(!location.rowCount)throw conflict('CLEANING_PASTURE_CHANGED','El potrero ya no está activo.');
    if(before.startedOn>today || before.finishedOn && before.finishedOn>today)
      throw invalidRequest('CLEANING_FUTURE_DATE','Las fechas no pueden ser futuras.');
    for(const product of before.products as Array<{productId:string}>){
      const valid=await client.query(`SELECT 1 FROM pasture_agrochemical
        WHERE id=$1 AND account_id=$2 AND active FOR SHARE`,[product.productId,account_id]);
      if(!valid.rowCount)throw conflict('CLEANING_PRODUCT_CHANGED','Un producto ya no está disponible.');
    }
    await client.query(`UPDATE pasture_cleaning SET status='COMPLETADO',completed_at=now(),
      updated_by=$2 WHERE id=$1`,[id,auth.userId]);
    const after=await read(client,id);
    await audit(client,auth,context,metadata,'CLEANING_COMPLETED',id,before,after);
    return after;
  });
}
export async function cancelCleaning(auth:AuthState,context:PropertyContext,id:string,
  metadata:RequestMetadata){
  return inTransaction(async(client)=>{
    await access(client,auth,context,'CLEANING_MANAGE');
    await draft(client,context,id);
    const before=await read(client,id);
    await client.query(`UPDATE pasture_cleaning SET status='CANCELADO',cancelled_at=now(),
      updated_by=$2 WHERE id=$1`,[id,auth.userId]);
    const after=await read(client,id);
    await audit(client,auth,context,metadata,'CLEANING_CANCELLED',id,before,after);
    return after;
  });
}
