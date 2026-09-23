import type {PoolClient} from 'pg';
import {ApiError,conflict,forbidden,invalidRequest} from '../../core/errors.js';
import {pool} from '../../database/pool.js';
import {inTransaction} from '../../database/transaction.js';
import type {AuthState,PropertyContext,RequestMetadata} from '../auth/auth.types.js';
import type {CampaignInput,MedicineInput} from './health.schemas.js';

async function access(client:PoolClient,auth:AuthState,context:PropertyContext,permission:string){
  const row=(await client.query<{account_id:string;today:string}>(
    `SELECT p.account_id,(now() AT TIME ZONE p.timezone)::date::text AS today
     FROM property p JOIN administrative_account aa ON aa.id=p.account_id AND aa.status='ACTIVE'
     JOIN property_membership pm ON pm.property_id=p.id AND pm.user_id=$2 AND pm.status='ACTIVE'
     JOIN membership_role mr ON mr.membership_id=pm.id AND mr.property_id=p.id
     JOIN property_role pr ON pr.id=mr.role_id AND pr.property_id=p.id AND pr.active
     JOIN role_permission rp ON rp.role_id=pr.id AND rp.permission_code=$4
     JOIN effective_property_module epm ON epm.property_id=p.id AND epm.module_code='HEALTH' AND epm.enabled
     WHERE p.id=$1 AND pr.id=$3 AND p.status='ACTIVE' AND p.deleted_at IS NULL
     FOR SHARE OF p,pm,pr`,[context.propertyId,auth.userId,context.roleId,permission])).rows[0];
  if(!row)throw forbidden('HEALTH_DENIED','Sanidad no está habilitada o el rol no tiene permiso.');
  return row;
}
async function audit(client:PoolClient,auth:AuthState,context:PropertyContext,
  metadata:RequestMetadata,action:string,entityType:string,id:string,before:unknown,after:unknown){
  await client.query(`INSERT INTO audit_event(actor_user_id,property_id,active_role_id,
    action,entity_type,entity_id,before_data,after_data,ip_address,user_agent)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)`,
    [auth.userId,context.propertyId,context.roleId,action,entityType,id,
      before===null?null:JSON.stringify(before),JSON.stringify(after),metadata.ipAddress,metadata.userAgent]);
}
function medicine(row:Record<string,unknown>){return {
  id:row.id,name:row.name,kind:row.kind,activeIngredient:row.active_ingredient,
  defaultUnitCode:row.default_unit_code,suggestedDose:row.suggested_dose,
  indications:row.indications,withdrawalMilkDays:row.withdrawal_milk_days,
  withdrawalMeatDays:row.withdrawal_meat_days,active:row.active};}
export async function listMedicines(context:PropertyContext){
  const result=await pool.query(`SELECT m.* FROM health_medicine m JOIN property p ON p.account_id=m.account_id
    WHERE p.id=$1 ORDER BY m.active DESC,lower(m.name)`,[context.propertyId]);
  return result.rows.map(medicine);
}
export async function createMedicine(auth:AuthState,context:PropertyContext,input:MedicineInput,
  metadata:RequestMetadata){
  return inTransaction(async(client)=>{
    const {account_id}=await access(client,auth,context,'HEALTH_MANAGE');
    const result=await client.query(`INSERT INTO health_medicine(account_id,name,kind,active_ingredient,
      default_unit_code,suggested_dose,indications,withdrawal_milk_days,withdrawal_meat_days,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [account_id,input.name,input.kind,input.activeIngredient??null,input.defaultUnitCode,
        input.suggestedDose??null,input.indications??null,input.withdrawalMilkDays,
        input.withdrawalMeatDays,auth.userId]);
    const created=medicine(result.rows[0]!);
    await audit(client,auth,context,metadata,'HEALTH_MEDICINE_CREATED','HEALTH_MEDICINE',
      result.rows[0]!.id,null,created);
    return created;
  });
}
export async function listHealthOptions(context:PropertyContext){
  const [animals,groups,units]=await Promise.all([
    pool.query(`SELECT a.id,a.name,a.ear_tag_code AS "earTagCode",aga.group_id AS "groupId"
      FROM animal a LEFT JOIN animal_group_assignment aga ON aga.animal_id=a.id AND aga.ended_at IS NULL
      WHERE a.property_id=$1 AND a.record_status='CURRENT' AND a.availability_status_code='ACTIVE'
      ORDER BY lower(a.name),a.id LIMIT 5000`,[context.propertyId]),
    pool.query(`SELECT id,name FROM livestock_group WHERE property_id=$1 AND active ORDER BY lower(name)`,
      [context.propertyId]),
    pool.query(`SELECT u.code,u.name,u.symbol FROM allowed_context_unit acu
      JOIN measurement_unit u ON u.code=acu.unit_code AND u.active
      WHERE acu.context_code='MEDICINE_DOSE' ORDER BY acu.sort_order`),
  ]);
  return {animals:animals.rows,groups:groups.rows,units:units.rows};
}
const fields=`c.id,c.medicine_id AS "medicineId",m.name AS "medicineName",m.kind,
 c.administration_route AS "administrationRoute",c.selection_mode AS "selectionMode",
 c.group_id AS "groupId",g.name AS "groupName",c.applied_on::text AS "appliedOn",
 c.responsible,c.notes,c.status,c.version::int,c.created_at AS "createdAt",
 c.applied_at AS "appliedAt",c.cancelled_at AS "cancelledAt",
 COALESCE((SELECT json_agg(json_build_object('animalId',d.animal_id,'name',a.name,
   'selected',d.selected,'dose',d.dose,'unitCode',d.unit_code,'notes',d.notes)
   ORDER BY lower(a.name),a.id)
   FROM health_campaign_animal d JOIN animal a ON a.id=d.animal_id
   WHERE d.campaign_id=c.id),'[]'::json) AS animals`;
const joins=`FROM health_campaign c JOIN health_medicine m ON m.id=c.medicine_id
 LEFT JOIN livestock_group g ON g.id=c.group_id`;
async function read(client:PoolClient,id:string){
  const row=(await client.query(`SELECT ${fields} ${joins} WHERE c.id=$1`,[id])).rows[0];
  if(!row)throw new ApiError(404,'HEALTH_CAMPAIGN_NOT_FOUND','Jornada no encontrada.');
  return row;
}
export async function listCampaigns(context:PropertyContext){
  return (await pool.query(`SELECT ${fields} ${joins} WHERE c.property_id=$1
    ORDER BY c.created_at DESC,c.id DESC LIMIT 250`,[context.propertyId])).rows;
}
async function validate(client:PoolClient,context:PropertyContext,input:CampaignInput,
  accountId:string,today:string){
  if(input.appliedOn>today)throw invalidRequest('HEALTH_FUTURE_DATE','La aplicación no puede ser futura.');
  const medicine=(await client.query<{default_unit_code:string}>(
    `SELECT default_unit_code FROM health_medicine WHERE id=$1 AND account_id=$2 AND active FOR SHARE`,
    [input.medicineId,accountId])).rows[0];
  if(!medicine)throw invalidRequest('HEALTH_MEDICINE_INVALID','Selecciona un medicamento activo de la cuenta.');
  if(input.animals.some((animal)=>animal.unitCode!==medicine.default_unit_code))
    throw invalidRequest('HEALTH_UNIT_INVALID','Todas las dosis deben usar la unidad del medicamento.');
  if(input.groupId){
    const group=await client.query(`SELECT 1 FROM livestock_group
      WHERE id=$1 AND property_id=$2 AND active FOR SHARE`,[input.groupId,context.propertyId]);
    if(!group.rowCount)throw invalidRequest('HEALTH_GROUP_INVALID','El grupo no está activo en esta propiedad.');
  }
  const current=await client.query<{id:string}>(`SELECT a.id FROM animal a
    LEFT JOIN animal_group_assignment aga ON aga.animal_id=a.id AND aga.ended_at IS NULL
    WHERE a.property_id=$1 AND a.account_id=$2 AND a.record_status='CURRENT'
      AND a.availability_status_code='ACTIVE'
      AND ($3::varchar='TODOS' OR $3='MANUAL' OR aga.group_id=$4)
    ORDER BY a.id FOR UPDATE OF a`,
    [context.propertyId,accountId,input.selectionMode,input.groupId??null]);
  const candidates=new Set(current.rows.map((animal)=>animal.id));
  if(input.animals.some((animal)=>!candidates.has(animal.animalId)))
    throw conflict('HEALTH_SELECTION_CHANGED',
      'Hay animales de otra propiedad, inactivos o fuera del grupo. Actualiza la selección.');
  if(input.selectionMode!=='MANUAL'&&(candidates.size!==input.animals.length
    || current.rows.some((animal)=>!input.animals.some((item)=>item.animalId===animal.id))))
    throw conflict('HEALTH_SELECTION_CHANGED','La composición del grupo o propiedad cambió. Actualiza la selección.');
}
async function details(client:PoolClient,id:string,input:CampaignInput){
  await client.query('DELETE FROM health_campaign_animal WHERE campaign_id=$1',[id]);
  for(const animal of input.animals)await client.query(`INSERT INTO health_campaign_animal
    (campaign_id,animal_id,selected,dose,unit_code,notes) VALUES($1,$2,$3,$4,$5,$6)`,
    [id,animal.animalId,animal.selected,animal.dose,animal.unitCode,animal.notes??null]);
}
export async function createCampaign(auth:AuthState,context:PropertyContext,input:CampaignInput,
  metadata:RequestMetadata){
  return inTransaction(async(client)=>{
    const {account_id,today}=await access(client,auth,context,'HEALTH_MANAGE');
    await validate(client,context,input,account_id,today);
    const row=(await client.query<{id:string}>(`INSERT INTO health_campaign(account_id,property_id,
      medicine_id,administration_route,selection_mode,group_id,applied_on,responsible,notes,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id`,
      [account_id,context.propertyId,input.medicineId,input.administrationRoute,input.selectionMode,
        input.groupId??null,input.appliedOn,input.responsible??null,input.notes??null,auth.userId])).rows[0]!;
    await details(client,row.id,input);
    const after=await read(client,row.id);
    await audit(client,auth,context,metadata,'HEALTH_CAMPAIGN_DRAFT_CREATED',
      'HEALTH_CAMPAIGN',row.id,null,after);
    return after;
  });
}
async function draft(client:PoolClient,context:PropertyContext,id:string){
  const row=(await client.query<{status:string;version:number;account_id:string}>(
    `SELECT status,version::int,account_id FROM health_campaign WHERE id=$1 AND property_id=$2 FOR UPDATE`,
    [id,context.propertyId])).rows[0];
  if(!row)throw new ApiError(404,'HEALTH_CAMPAIGN_NOT_FOUND','Jornada no encontrada en esta propiedad.');
  if(row.status!=='BORRADOR')throw conflict('HEALTH_CAMPAIGN_FINAL','La jornada ya fue aplicada o cancelada.');
  return row;
}
export async function updateCampaign(auth:AuthState,context:PropertyContext,id:string,
  input:CampaignInput,metadata:RequestMetadata){
  return inTransaction(async(client)=>{
    const {account_id,today}=await access(client,auth,context,'HEALTH_MANAGE');
    const current=await draft(client,context,id);
    if(input.expectedVersion && input.expectedVersion!==current.version)
      throw conflict('HEALTH_VERSION_CONFLICT','El borrador cambió. Actualiza la pantalla.');
    const before=await read(client,id);
    await validate(client,context,input,account_id,today);
    await client.query(`UPDATE health_campaign SET medicine_id=$2,administration_route=$3,
      selection_mode=$4,group_id=$5,applied_on=$6,responsible=$7,notes=$8,updated_by=$9 WHERE id=$1`,
      [id,input.medicineId,input.administrationRoute,input.selectionMode,input.groupId??null,
        input.appliedOn,input.responsible??null,input.notes??null,auth.userId]);
    await details(client,id,input);
    const after=await read(client,id);
    await audit(client,auth,context,metadata,'HEALTH_CAMPAIGN_DRAFT_UPDATED',
      'HEALTH_CAMPAIGN',id,before,after);
    return after;
  });
}
export async function applyCampaign(auth:AuthState,context:PropertyContext,id:string,
  metadata:RequestMetadata){
  return inTransaction(async(client)=>{
    const {account_id,today}=await access(client,auth,context,'HEALTH_MANAGE');
    await draft(client,context,id);
    const before=await read(client,id);
    const row=(await client.query<{medicine_id:string;administration_route:CampaignInput['administrationRoute'];
      selection_mode:CampaignInput['selectionMode'];group_id:string|null;applied_on:string;
      responsible:string|null;notes:string|null}>(`SELECT medicine_id,administration_route,
      selection_mode,group_id,applied_on::text,responsible,notes FROM health_campaign WHERE id=$1`,[id])).rows[0]!;
    const items=(await client.query<{animal_id:string;selected:boolean;dose:string;
      unit_code:CampaignInput['animals'][number]['unitCode'];notes:string|null}>(
      `SELECT animal_id,selected,dose::text,unit_code,notes FROM health_campaign_animal
       WHERE campaign_id=$1 ORDER BY animal_id`,[id])).rows;
    const input:CampaignInput={medicineId:row.medicine_id,administrationRoute:row.administration_route,
      selectionMode:row.selection_mode,groupId:row.group_id,appliedOn:row.applied_on,
      responsible:row.responsible,notes:row.notes,
      animals:items.map((item)=>({animalId:item.animal_id,selected:item.selected,
        dose:Number(item.dose),unitCode:item.unit_code,notes:item.notes}))};
    if(!items.some((item)=>item.selected))throw conflict('HEALTH_EMPTY_CAMPAIGN','Selecciona animales.');
    await validate(client,context,input,account_id,today);
    await client.query(`UPDATE health_campaign SET status='COMPLETADO',applied_at=now(),updated_by=$2
      WHERE id=$1`,[id,auth.userId]);
    const after=await read(client,id);
    await audit(client,auth,context,metadata,'HEALTH_CAMPAIGN_APPLIED',
      'HEALTH_CAMPAIGN',id,before,after);
    return after;
  });
}
export async function cancelCampaign(auth:AuthState,context:PropertyContext,id:string,
  metadata:RequestMetadata){
  return inTransaction(async(client)=>{
    await access(client,auth,context,'HEALTH_MANAGE');
    await draft(client,context,id);
    const before=await read(client,id);
    await client.query(`UPDATE health_campaign SET status='CANCELADO',cancelled_at=now(),updated_by=$2
      WHERE id=$1`,[id,auth.userId]);
    const after=await read(client,id);
    await audit(client,auth,context,metadata,'HEALTH_CAMPAIGN_CANCELLED',
      'HEALTH_CAMPAIGN',id,before,after);
    return after;
  });
}
