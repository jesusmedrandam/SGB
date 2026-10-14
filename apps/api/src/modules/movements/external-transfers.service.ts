import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {inTransaction} from '../../database/transaction.js';
import {ApiError,conflict,forbidden,invalidRequest} from '../../core/errors.js';
import type {AuthState,PropertyContext,RequestMetadata} from '../auth/auth.types.js';
import {insertAnimalInTransaction} from '../animals/animals.service.js';
import {captureAnimal,visibleAnimalSnapshot,type AnimalTransferSnapshot} from './external-transfers.history.js';
import type {ExternalTransferInput,ExternalDecisionInput,ExternalVisibilityInput} from './external-transfers.schemas.js';

async function administrator(client:PoolClient,context:PropertyContext,userId:string,roleId=context.roleId){
  const result=await client.query(`SELECT 1 FROM property_membership pm
    JOIN membership_role mr ON mr.membership_id=pm.id AND mr.property_id=pm.property_id
    JOIN property_role pr ON pr.id=mr.role_id AND pr.property_id=pm.property_id
    WHERE pm.property_id=$1 AND pm.user_id=$2 AND pm.status='ACTIVE' AND pr.id=$3 AND pr.active
      AND pr.is_system AND pr.code IN ('OWNER','ADMINISTRATOR')
      AND EXISTS(SELECT 1 FROM role_permission WHERE role_id=pr.id AND permission_code='MOVEMENT_MANAGE')
      FOR SHARE OF pm,pr`,[context.propertyId,userId,roleId]);
  if(!result.rowCount)throw forbidden('EXTERNAL_TRANSFER_ADMIN_REQUIRED','Esta operación requiere un administrador de la propiedad con permiso para gestionar movimientos.');
}
async function property(client:PoolClient,id:string){
  const result=await client.query<{id:string;account_id:string;name:string;owner_user_id:string;external_transfers_enabled:boolean;animal_receive_code:string;today:string;
    external_transfer_visibility:'HIDDEN'|'COLLABORATORS'|'PUBLIC';external_transfer_visible_until:Date|null;effective_visibility:'HIDDEN'|'COLLABORATORS'|'PUBLIC'}>(`
    SELECT p.id,p.account_id,p.name,a.owner_user_id,a.external_transfers_enabled,p.animal_receive_code,
      p.external_transfer_visibility,p.external_transfer_visible_until,
      CASE WHEN p.external_transfer_visible_until<=now() THEN 'HIDDEN' ELSE p.external_transfer_visibility END AS effective_visibility,
      (now() AT TIME ZONE p.timezone)::date::text AS today FROM property p
    JOIN administrative_account a ON a.id=p.account_id AND a.status='ACTIVE'
    WHERE p.id=$1 AND p.status='ACTIVE' AND p.deleted_at IS NULL`,[id]);
  if(!result.rows[0])throw invalidRequest('EXTERNAL_PROPERTY_UNAVAILABLE','La propiedad ya no está disponible.');
  return result.rows[0];
}
async function lockAccounts(client:PoolClient,properties:string[]){
  await client.query(`SELECT a.id FROM administrative_account a WHERE a.id IN
    (SELECT account_id FROM property WHERE id=ANY($1::uuid[])) ORDER BY a.id FOR UPDATE`,[properties]);
}
async function audit(client:PoolClient,auth:AuthState,context:PropertyContext,metadata:RequestMetadata,
  action:string,id:string,data:unknown){
  await client.query(`INSERT INTO audit_event(actor_user_id,property_id,active_role_id,action,entity_type,
    entity_id,after_data,ip_address,user_agent) VALUES($1,$2,$3,$4,'EXTERNAL_ANIMAL_TRANSFER',$5,$6::jsonb,$7,$8)`,
    [auth.userId,context.propertyId,context.roleId,action,id,JSON.stringify(data),metadata.ipAddress,metadata.userAgent]);
}
async function notify(client:PoolClient,propertyId:string,id:string,title:string,message:string,kind:string){
  await client.query(`INSERT INTO app_notification(user_id,property_id,external_transfer_id,kind,title,message)
    SELECT DISTINCT pm.user_id,$1::uuid,$2::uuid,$3::varchar,$4::varchar,$5::text FROM property_membership pm
    JOIN membership_role mr ON mr.membership_id=pm.id AND mr.property_id=pm.property_id
    JOIN property_role pr ON pr.id=mr.role_id AND pr.active AND pr.is_system AND pr.code IN ('OWNER','ADMINISTRATOR')
    WHERE pm.property_id=$1 AND pm.status='ACTIVE' AND EXISTS(SELECT 1 FROM role_permission
      WHERE role_id=pr.id AND permission_code='MOVEMENT_MANAGE')`,[propertyId,id,kind,title,message]);
}
function digest(snapshot:AnimalTransferSnapshot){
  const normalize=(value:any):any=>Array.isArray(value)?value.map(normalize):value&&typeof value==='object'
    ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,normalize(value[key])])):value;
  const profile={...snapshot.profile,classification:null};
  return createHash('sha256').update(JSON.stringify(normalize({...snapshot,profile}))).digest('hex');
}
export async function getExternalTransferSettings(auth:AuthState,context:PropertyContext){
  return inTransaction(async client=>{
    const p=await property(client,context.propertyId);let canRequest=false;
    try{await administrator(client,context,auth.userId);canRequest=context.enabledModules.has('MOVEMENTS');}
    catch(error){if((error as {code?:string}).code!=='EXTERNAL_TRANSFER_ADMIN_REQUIRED')throw error;}
    return {enabled:p.external_transfers_enabled,canManage:p.owner_user_id===auth.userId,canRequest,
      canManageVisibility:canRequest,visibility:p.external_transfer_visibility,visibleUntil:p.external_transfer_visible_until,
      effectiveVisibility:p.effective_visibility,receiveCode:canRequest&&p.external_transfers_enabled?p.animal_receive_code:null};
  });
}
export async function setExternalTransferSettings(auth:AuthState,context:PropertyContext,enabled:boolean,metadata:RequestMetadata){
  await inTransaction(async client=>{
    const p=await property(client,context.propertyId);
    const changed=await client.query(`UPDATE administrative_account SET external_transfers_enabled=$2
      WHERE id=$1 AND owner_user_id=$3 RETURNING id`,[p.account_id,enabled,auth.userId]);
    if(!changed.rowCount)throw forbidden('EXTERNAL_TRANSFER_OWNER_REQUIRED','Solo el dueño puede cambiar esta opción para todas sus propiedades.');
    await audit(client,auth,context,metadata,'EXTERNAL_TRANSFER_POLICY_UPDATED',p.account_id,{enabled});
  });
  return getExternalTransferSettings(auth,context);
}
export async function lookupExternalDestination(auth:AuthState,context:PropertyContext,receiveCode:string){
  return inTransaction(async client=>{
    await administrator(client,context,auth.userId);const source=await property(client,context.propertyId);
    if(!source.external_transfers_enabled)throw forbidden('EXTERNAL_TRANSFERS_DISABLED','El dueño debe permitir los traslados externos para esta cuenta.');
    const result=await client.query(`SELECT p.id,p.name,u.display_name AS "ownerName" FROM property p
      JOIN administrative_account a ON a.id=p.account_id AND a.status='ACTIVE' AND a.external_transfers_enabled
      JOIN app_user u ON u.id=a.owner_user_id
      WHERE p.animal_receive_code=$1 AND p.account_id<>$2 AND p.status='ACTIVE' AND p.deleted_at IS NULL
      AND EXISTS(SELECT 1 FROM effective_property_module WHERE property_id=p.id AND module_code='MOVEMENTS' AND enabled)
      AND EXISTS(SELECT 1 FROM effective_property_species WHERE property_id=p.id AND species_code='BOVINE' AND enabled)`,[receiveCode,source.account_id]);
    if(!result.rows[0])throw invalidRequest('EXTERNAL_DESTINATION_UNAVAILABLE','El código no corresponde a una propiedad externa disponible para recibir animales.');
    return result.rows[0] as {id:string;name:string;ownerName:string};
  });
}
export async function setExternalTransferVisibility(auth:AuthState,context:PropertyContext,input:ExternalVisibilityInput,metadata:RequestMetadata){
  await inTransaction(async client=>{
    await administrator(client,context,auth.userId);await lockAccounts(client,[context.propertyId]);
    const p=await property(client,context.propertyId);
    await client.query(`UPDATE property SET external_transfer_visibility=$2,
      external_transfer_visible_until=CASE WHEN $3::int IS NULL THEN NULL ELSE now()+$3::int*interval '1 day' END WHERE id=$1`,
      [context.propertyId,input.visibility,input.durationDays??null]);
    await audit(client,auth,context,metadata,'EXTERNAL_TRANSFER_VISIBILITY_UPDATED',context.propertyId,
      {name:p.name,visibility:input.visibility,durationDays:input.durationDays??null});
  });
  return getExternalTransferSettings(auth,context);
}
async function visibleExternalDestinations(client:PoolClient,auth:AuthState,context:PropertyContext,email:string|null,id:string|null){
  const source=await property(client,context.propertyId);
  const result=await client.query<{id:string;name:string;ownerName:string}>(`SELECT p.id,p.name,u.display_name AS "ownerName" FROM property p
    JOIN administrative_account a ON a.id=p.account_id AND a.status='ACTIVE'
    JOIN app_user u ON u.id=a.owner_user_id AND u.deleted_at IS NULL
    WHERE (u.email=$1::citext OR p.id=$2::uuid) AND p.account_id<>$3 AND p.status='ACTIVE' AND p.deleted_at IS NULL
    AND EXISTS(SELECT 1 FROM effective_property_module WHERE property_id=p.id AND module_code='MOVEMENTS' AND enabled)
    AND EXISTS(SELECT 1 FROM effective_property_species WHERE property_id=p.id AND species_code='BOVINE' AND enabled)
    AND (p.external_transfer_visibility='PUBLIC' AND (p.external_transfer_visible_until IS NULL OR p.external_transfer_visible_until>now())
      OR p.external_transfer_visibility='COLLABORATORS' AND EXISTS(
        SELECT 1 FROM property_membership pm JOIN property_membership owner_membership ON owner_membership.property_id=pm.property_id
        JOIN property cp ON cp.id=pm.property_id AND cp.status='ACTIVE' AND cp.deleted_at IS NULL
        JOIN administrative_account ca ON ca.id=cp.account_id AND ca.status='ACTIVE'
        WHERE pm.status='ACTIVE' AND pm.user_id=$4 AND owner_membership.status='ACTIVE' AND owner_membership.user_id=a.owner_user_id
        AND EXISTS(SELECT 1 FROM membership_role mr JOIN property_role pr ON pr.id=mr.role_id AND pr.active WHERE mr.membership_id=pm.id)
        AND EXISTS(SELECT 1 FROM membership_role mr JOIN property_role pr ON pr.id=mr.role_id AND pr.active WHERE mr.membership_id=owner_membership.id)))
    ORDER BY lower(p.name),p.id`,[email,id,source.account_id,auth.userId]);
  return result.rows;
}
export async function searchExternalDestinations(auth:AuthState,context:PropertyContext,email:string){
  return inTransaction(async client=>{
    await administrator(client,context,auth.userId);
    return visibleExternalDestinations(client,auth,context,email.trim().toLowerCase(),null);
  });
}
const fields=`t.*,t.movement_on::text AS movement_date,t.source_name AS "sourcePropertyName",t.destination_name AS "destinationPropertyName"`;
async function read(client:PoolClient,context:PropertyContext,id:string){
  const request=(await client.query(`SELECT ${fields} FROM external_animal_transfer t
    JOIN property s ON s.id=t.source_property_id JOIN property d ON d.id=t.destination_property_id
    WHERE t.id=$1 AND (t.source_property_id=$2 OR t.destination_property_id=$2)`,[id,context.propertyId])).rows[0];
  if(!request)throw new ApiError(404,'EXTERNAL_TRANSFER_NOT_FOUND','La solicitud no está disponible en esta propiedad.');
  const items=(await client.query(`SELECT source_animal_id,destination_animal_id,snapshot FROM external_animal_transfer_item WHERE transfer_id=$1 ORDER BY source_animal_id`,[id])).rows;
  return {id:request.id,status:request.status,version:Number(request.version),sourcePropertyId:request.source_property_id,
    sourcePropertyName:request.sourcePropertyName,destinationPropertyId:request.destination_property_id,
    destinationPropertyName:request.destinationPropertyName,movementOn:request.movement_date,
    reason:request.reason,notes:request.notes,createdAt:request.created_at,decidedAt:request.decided_at,decisionReason:request.decision_reason,
    animals:items.map(row=>({sourceAnimalId:row.source_animal_id,destinationAnimalId:row.destination_animal_id,
      ...visibleAnimalSnapshot(row.snapshot as AnimalTransferSnapshot,context)}))};
}
export async function listExternalTransfers(context:PropertyContext){
  return inTransaction(async client=>{
    const requests=await client.query(`SELECT id FROM external_animal_transfer WHERE source_property_id=$1 OR destination_property_id=$1
      ORDER BY created_at DESC,id DESC LIMIT 100`,[context.propertyId]);
    const result=[];for(const row of requests.rows)result.push(await read(client,context,row.id));return result;
  });
}
export async function createExternalTransfer(auth:AuthState,context:PropertyContext,input:ExternalTransferInput,metadata:RequestMetadata){
  const destination=input.destinationPropertyId?{id:input.destinationPropertyId}:
    await lookupExternalDestination(auth,context,input.receiveCode!);
  try{return await inTransaction(async client=>{
    await administrator(client,context,auth.userId);await lockAccounts(client,[context.propertyId,destination.id]);const source=await property(client,context.propertyId);
    const dest=await property(client,destination.id);
    if(input.destinationPropertyId&&!(await visibleExternalDestinations(client,auth,context,null,destination.id)).length)
      throw invalidRequest('EXTERNAL_DESTINATION_UNAVAILABLE','La propiedad ya no está visible para recibir solicitudes. Busca de nuevo el correo del dueño.');
    if(!input.destinationPropertyId&&(!source.external_transfers_enabled||!dest.external_transfers_enabled))
      throw forbidden('EXTERNAL_TRANSFERS_DISABLED','Ambos dueños deben permitir los traslados externos.');
    if(input.movementOn>source.today||input.movementOn>dest.today)throw invalidRequest('EXTERNAL_TRANSFER_DATE','La fecha del traslado no puede ser futura.');
    const animals=(await client.query(`SELECT id FROM animal WHERE id=ANY($1::uuid[]) AND property_id=$2 AND record_status='CURRENT'
      AND availability_status_code='ACTIVE' AND transferred_out_at IS NULL ORDER BY id FOR UPDATE`,[input.animalIds,context.propertyId])).rows;
    if(animals.length!==input.animalIds.length)throw conflict('EXTERNAL_TRANSFER_ANIMALS_CHANGED','Selecciona animales activos de esta propiedad.');
    const request=(await client.query(`INSERT INTO external_animal_transfer(source_property_id,destination_property_id,requested_by,source_role_id,movement_on,reason,notes,source_name,destination_name,uses_property_visibility)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,[context.propertyId,destination.id,auth.userId,context.roleId,input.movementOn,input.reason,input.notes??null,source.name,dest.name,Boolean(input.destinationPropertyId)])).rows[0];
    for(const animal of animals){
      const snapshot=await captureAnimal(client,context,animal.id);
      if(snapshot.profile.entryDate>input.movementOn||snapshot.history.some(event=>event.date>input.movementOn))throw invalidRequest('EXTERNAL_TRANSFER_DATE','El traslado no puede preceder al ingreso del animal en origen.');
      await client.query(`INSERT INTO external_animal_transfer_item(transfer_id,source_animal_id,source_version,snapshot_digest,snapshot)
        VALUES($1,$2,$3,$4,$5::jsonb)`,[request.id,animal.id,snapshot.profile.version,digest(snapshot),JSON.stringify(snapshot)]);
    }
    await audit(client,auth,context,metadata,'EXTERNAL_TRANSFER_REQUESTED',request.id,{name:`${source.name} → ${dest.name}`,reason:input.reason,destinationPropertyId:destination.id,animalIds:input.animalIds});
    await notify(client,destination.id,request.id,'Solicitud para recibir animales',`${source.name} solicita trasladar ${animals.length} animal${animals.length===1?'':'es'}. Revisa su ficha e historial antes de decidir.`,'EXTERNAL_TRANSFER_RECEIVED');
    return read(client,context,request.id);
  });}catch(error){if((error as {code?:string}).code==='23505')throw conflict('EXTERNAL_TRANSFER_ALREADY_PENDING','Uno de estos animales ya tiene una solicitud pendiente. Cancélala o espera su respuesta.');throw error;}
}

export async function refreshExternalTransfer(auth:AuthState,context:PropertyContext,id:string,version:number,metadata:RequestMetadata){
  return inTransaction(async client=>{
    await administrator(client,context,auth.userId);const request=await lockedRequest(client,context,id,version);
    if(request.source_property_id!==context.propertyId)throw forbidden('EXTERNAL_TRANSFER_WRONG_SIDE','Solo el origen puede actualizar la información enviada.');
    await lockAccounts(client,[request.source_property_id,request.destination_property_id]);
    if(!request.uses_property_visibility&&!(await property(client,context.propertyId)).external_transfers_enabled)
      throw forbidden('EXTERNAL_TRANSFERS_DISABLED','El dueño debe permitir los traslados externos.');
    const items=(await client.query('SELECT source_animal_id FROM external_animal_transfer_item WHERE transfer_id=$1 ORDER BY source_animal_id',[id])).rows;
    for(const item of items){
      const animal=(await client.query(`SELECT id FROM animal WHERE id=$1 AND property_id=$2 AND availability_status_code='ACTIVE'
        AND record_status='CURRENT' AND transferred_out_at IS NULL FOR UPDATE`,[item.source_animal_id,context.propertyId])).rows[0];
      if(!animal)throw conflict('EXTERNAL_TRANSFER_ANIMALS_CHANGED','Uno de los animales ya no está activo en origen. Cancela la solicitud.');
      const snapshot=await captureAnimal(client,context,animal.id);
      await client.query(`UPDATE external_animal_transfer_item SET source_version=$3,snapshot_digest=$4,snapshot=$5::jsonb WHERE transfer_id=$1 AND source_animal_id=$2`,
        [id,animal.id,snapshot.profile.version,digest(snapshot),JSON.stringify(snapshot)]);
    }
    await client.query('UPDATE external_animal_transfer SET version=version+1,requested_by=$2,source_role_id=$3 WHERE id=$1',[id,auth.userId,context.roleId]);
    await audit(client,auth,context,metadata,'EXTERNAL_TRANSFER_REFRESHED',id,{});return read(client,context,id);
  });
}

async function relatedAnimal(client:PoolClient,oldId:string|null|undefined,accountId:string,moved:Map<string,string>){
  if(!oldId)return null;if(moved.has(oldId))return moved.get(oldId)!;
  return (await client.query(`SELECT a.id FROM animal a JOIN animal old ON old.identity_id=a.identity_id
    WHERE old.id=$1 AND a.account_id=$2 AND a.record_status='CURRENT' AND a.transferred_out_at IS NULL
    ORDER BY (a.availability_status_code='ACTIVE') DESC,a.created_at DESC LIMIT 1`,[oldId,accountId])).rows[0]?.id??null;
}
async function copyProcesses(client:PoolClient,auth:AuthState,context:PropertyContext,accountId:string,
  transferId:string,animalId:string,snapshot:AnimalTransferSnapshot,moved:Map<string,string>,sourcePropertyId:string){
  const state=snapshot.processes;const copies:Record<string,string>={};const heats=new Map<string,string>();const services=new Map<string,string>();
  const mappedCopy=(type:string,sourceId:string,newId:string)=>{copies[`${type}:${newId}`]=snapshot.copies?.[`${type}:${sourceId}`]??`${type}:${sourceId}`;};
  for(const heat of state.heats){
    const bull=await relatedAnimal(client,heat.bull_id,accountId,moved);
    const result=(await client.query(`INSERT INTO reproduction_heat(account_id,property_id,cow_id,bull_id,starts_on,ends_on,is_false,notes,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,[accountId,context.propertyId,animalId,bull,heat.starts_on,heat.ends_on,heat.is_false,heat.notes,auth.userId])).rows[0];
    heats.set(heat.id,result.id);mappedCopy('REPRODUCTION_HEAT',heat.id,result.id);
  }
  for(const service of state.services){
    const father=await relatedAnimal(client,service.father_id,accountId,moved);
    const donor=await relatedAnimal(client,service.donor_id,accountId,moved);
    const result=(await client.query(`INSERT INTO reproduction_service(account_id,property_id,cow_id,heat_id,kind,occurred_on,
      father_id,external_father,donor_id,external_donor,material_code,quality,technician,supplier,notes,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [accountId,context.propertyId,animalId,heats.get(service.heat_id)??null,service.kind,service.occurred_on,
        father,father?null:service.father_name??service.external_father,donor,donor?null:service.donor_name??service.external_donor,
        service.material_code,service.quality,service.technician,service.supplier,service.notes,auth.userId])).rows[0];
    services.set(service.id,result.id);mappedCopy('REPRODUCTION_SERVICE',service.id,result.id);
  }
  if(state.pregnancy){const pregnancy=state.pregnancy;const father=await relatedAnimal(client,pregnancy.father_id,accountId,moved);
    const result=(await client.query(`INSERT INTO reproduction_pregnancy(account_id,property_id,cow_id,heat_id,service_id,father_id,external_father,
      conception_method,confirmation_method,confirmed_on,gestation_days,conception_on,expected_birth_on,notes,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [accountId,context.propertyId,animalId,heats.get(pregnancy.heat_id)??null,services.get(pregnancy.service_id)??null,
        father,father?null:pregnancy.father_name??pregnancy.external_father,pregnancy.conception_method,pregnancy.confirmation_method,
        pregnancy.confirmed_on,pregnancy.gestation_days,pregnancy.conception_on,pregnancy.expected_birth_on,pregnancy.notes,auth.userId])).rows[0];
    mappedCopy('REPRODUCTION_PREGNANCY',pregnancy.id,result.id);
  }
  for(const condition of state.conditions){
    if(condition.kind){const type=(await client.query(`SELECT ci.id FROM governed_catalog_item ci JOIN property p ON p.id=$1
      WHERE ci.catalog_code='HEALTH_CONDITION_TYPES' AND ci.name=$2 AND ci.active AND ci.deleted_at IS NULL
      AND (ci.system_defined OR ci.account_id=p.account_id) ORDER BY ci.system_defined DESC LIMIT 1`,[sourcePropertyId,condition.kind])).rows[0];
      if(type)await copyReference(client,auth,context,accountId,type.id,'CATALOG');}

    const result=(await client.query(`INSERT INTO health_condition(account_id,property_id,animal_id,kind,detected_on,description,status,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`,[accountId,context.propertyId,animalId,condition.kind,condition.detected_on,condition.description,condition.status,auth.userId])).rows[0];
    mappedCopy('HEALTH_CONDITION',condition.id,result.id);
  }
  if(state.lactation){const lactation=state.lactation;
    const result=(await client.query(`INSERT INTO milk_lactation(account_id,property_id,cow_id,birth_id,external_transfer_id,started_on,in_milking,notes,created_by)
      VALUES($1,$2,$3,NULL,$4,$5,$6,$7,$8) RETURNING id`,[accountId,context.propertyId,animalId,transferId,lactation.started_on,lactation.in_milking,lactation.notes,auth.userId])).rows[0];
    mappedCopy('MILK_LACTATION',lactation.id,result.id);
  }
  if(state.milking)await client.query(`INSERT INTO milk_animal_state(cow_id,property_id,account_id,enabled,updated_by) VALUES($1,$2,$3,true,$4)`,[animalId,context.propertyId,accountId,auth.userId]);
  return copies;
}
export async function acceptExternalTransfer(auth:AuthState,context:PropertyContext,id:string,input:ExternalDecisionInput,metadata:RequestMetadata){
  if(!input.groupId)throw invalidRequest('EXTERNAL_TRANSFER_GROUP_REQUIRED','Selecciona el grupo donde ingresarán los animales.');
  if(!context.permissions.has('ANIMAL_CREATE')||!context.permissions.has('CATALOG_MANAGE'))
    throw forbidden('EXTERNAL_TRANSFER_RECEIVE_DENIED','Para recibir la ficha completa necesitas permiso para registrar animales y administrar catálogos.');
  try{return await inTransaction(async client=>{
    await administrator(client,context,auth.userId);const request=await lockedRequest(client,context,id,input.expectedVersion);
    if(request.destination_property_id!==context.propertyId)throw forbidden('EXTERNAL_TRANSFER_WRONG_SIDE','Solo el destino puede aceptar esta solicitud.');
    await lockAccounts(client,[request.source_property_id,request.destination_property_id]);
    if(!context.enabledSpecies.has('BOVINE'))throw forbidden('EXTERNAL_SPECIES_DISABLED','Habilita bovinos para recibir estos animales.');
    const source=await property(client,request.source_property_id),dest=await property(client,request.destination_property_id);
    if(source.account_id===dest.account_id||!request.uses_property_visibility&&(!source.external_transfers_enabled||!dest.external_transfers_enabled))
      throw forbidden('EXTERNAL_TRANSFERS_DISABLED','Ambos dueños deben permitir el traslado externo.');
    const role=(await client.query('SELECT code,name FROM property_role WHERE id=$1 AND property_id=$2',[request.source_role_id,source.id])).rows[0];
    const permissions=(await client.query('SELECT permission_code FROM role_permission WHERE role_id=$1',[request.source_role_id])).rows.map(row=>row.permission_code as string);
    const sourceContext:PropertyContext={propertyId:source.id,propertyName:request.source_name,roleId:request.source_role_id,
      roleCode:role?.code??'',roleName:role?.name??'',permissions:new Set(permissions),enabledModules:new Set(context.enabledModules),enabledSpecies:new Set(['BOVINE'])};
    await administrator(client,sourceContext,request.requested_by,request.source_role_id);
    const group=(await client.query(`SELECT pl.kind,gla.location_id FROM livestock_group g
      JOIN group_location_assignment gla ON gla.group_id=g.id AND gla.ended_at IS NULL
      JOIN physical_location pl ON pl.id=gla.location_id AND pl.active AND pl.property_id=g.property_id
      WHERE g.id=$1 AND g.property_id=$2 AND g.active FOR UPDATE OF g,gla,pl`,[input.groupId,context.propertyId])).rows[0];
    if(!group||!context.enabledModules.has(group.kind==='PASTURE'?'PASTURES':'CORRALS'))
      throw invalidRequest('EXTERNAL_TRANSFER_GROUP_UNAVAILABLE','Elige un grupo activo con potrero o corral habilitado en esta propiedad.');
    const items=(await client.query(`SELECT source_animal_id,snapshot_digest,snapshot FROM external_animal_transfer_item WHERE transfer_id=$1 ORDER BY source_animal_id`,[id])).rows;
    const animalIds=items.map(row=>row.source_animal_id);
    if(input.earTags?.some(row=>!animalIds.includes(row.animalId)))throw invalidRequest('EXTERNAL_TRANSFER_EAR_TAG','Revisa los aretes de los animales de esta solicitud.');
    const locked=(await client.query(`SELECT id FROM animal WHERE id=ANY($1::uuid[]) AND property_id=$2
      AND record_status='CURRENT' AND availability_status_code='ACTIVE' AND transferred_out_at IS NULL ORDER BY id FOR UPDATE`,[animalIds,source.id])).rows;
    if(locked.length!==items.length)throw conflict('EXTERNAL_TRANSFER_ANIMALS_CHANGED','Uno de los animales cambió de propiedad o ya no está activo.');
    for(const item of items){
      const current=await captureAnimal(client,sourceContext,item.source_animal_id);
      if(digest(current)!==item.snapshot_digest)throw conflict('EXTERNAL_TRANSFER_DETAILS_CHANGED','La ficha o el historial cambió en origen. Solicita al origen actualizar la información y vuelve a revisarla.');
      const snapshot=item.snapshot as AnimalTransferSnapshot;
      for(const [needed,module,permission,label] of [
        [Boolean(snapshot.processes.pregnancy)||snapshot.processes.heats.length>0||snapshot.processes.services.length>0,'REPRODUCTION','REPRODUCTION_MANAGE','Reproducción'],
        [snapshot.processes.conditions.length>0,'HEALTH','HEALTH_MANAGE','Sanidad'],
        [Boolean(snapshot.processes.lactation)||snapshot.processes.milking,'PRODUCTION','PRODUCTION_MANAGE','Producción'],
      ] as const)if(needed&&(!context.enabledModules.has(module)||!context.permissions.has(permission)))
        throw forbidden('EXTERNAL_TRANSFER_PROCESS_DISABLED',`Habilita ${label} y su permiso de administración para continuar los procesos del animal en destino.`);
    }
    const objects=[...new Set(items.flatMap(item=>(item.snapshot as AnimalTransferSnapshot).media.map(photo=>photo.storage_object_id)))];
    const available=(await client.query(`SELECT id,byte_size FROM storage_object WHERE id=ANY($1::uuid[]) AND status='AVAILABLE' ORDER BY id FOR SHARE`,[objects])).rows;
    if(available.length!==objects.length)throw conflict('EXTERNAL_TRANSFER_MEDIA_CHANGED','Una fotografía ya no está disponible. Pide al origen actualizar la solicitud.');
    const quota=(await client.query(`SELECT c.stored_bytes,c.reserved_bytes,q.limit_value FROM account_media_storage_commitment c
      JOIN effective_account_quota q ON q.account_id=c.account_id AND q.quota_code='MEDIA_STORAGE_BYTES' WHERE c.account_id=$1`,[dest.account_id])).rows[0];
    const already=(await client.query(`SELECT DISTINCT storage_object_id FROM media_attachment WHERE account_id=$1 AND storage_object_id=ANY($2::uuid[]) AND deleted_at IS NULL`,[dest.account_id,objects])).rows.map(row=>row.storage_object_id);
    const extra=available.filter(row=>!already.includes(row.id)).reduce((total,row)=>total+Number(row.byte_size),0);
    if(quota&&quota.limit_value!=null&&Number(quota.stored_bytes)+Number(quota.reserved_bytes)+extra>Number(quota.limit_value))
      throw conflict('EXTERNAL_TRANSFER_STORAGE_LIMIT','La cuenta de destino no tiene espacio suficiente para recibir las fotografías.');
    await client.query("SELECT set_config('sgb.allow_animal_managed_write','on',true)");
    await client.query("SELECT set_config('sgb.allow_animal_status_event','on',true)");
    const moved=new Map<string,string>();
    for(const item of items){const snapshot=item.snapshot as AnimalTransferSnapshot;const animal=snapshot.profile;
      const owners=[];for(const owner of animal.owners)owners.push({partyId:await copyReference(client,auth,context,dest.account_id,owner.id,'PARTY'),percent:owner.percent,isPrimary:owner.isPrimary});
      const breeds=[];for(const breed of animal.breeds)breeds.push(await copyReference(client,auth,context,dest.account_id,breed.id,'CATALOG'));
      const colors=[];for(const color of animal.colors??[])colors.push(await copyReference(client,auth,context,dest.account_id,color.id,'CATALOG'));
      const brands=[];for(const brand of animal.brands)brands.push(await copyReference(client,auth,context,dest.account_id,brand.id,'BRAND'));
      await client.query(`UPDATE animal SET availability_status_code='INACTIVE',transferred_out_at=now(),updated_by=$2 WHERE id=$1`,[item.source_animal_id,auth.userId]);
      for(const table of ['animal_group_assignment','animal_location_assignment'])await client.query(`UPDATE ${table}
        SET ended_at=GREATEST(now(),started_at),end_reason='Traslado externo aprobado' WHERE animal_id=$1 AND ended_at IS NULL`,[item.source_animal_id]);
      const tagChoice=input.earTags?.find(row=>row.animalId===item.source_animal_id);
      const earTagCode=tagChoice?tagChoice.earTagCode:animal.earTagCode;
      const received=await insertAnimalInTransaction(client,auth,context,{name:animal.name,description:animal.description,sex:animal.sex,
        speciesCode:'BOVINE',groupId:input.groupId,entryDate:request.movement_date,
        ...(animal.birthDate?{birthDate:animal.birthDate}:{}),...(earTagCode?{earTagCode}:{}),
        ...(animal.initialWeight!=null?{initialWeight:animal.initialWeight,initialWeightUnitCode:animal.initialWeightUnitCode!}:{}),
        owners,breedIds:breeds,colorIds:colors,brandIds:brands},metadata,dest.account_id,dest.today);
      await client.query('UPDATE animal SET identity_id=$2 WHERE id=$1',[received.id,snapshot.identityId]);
      moved.set(item.source_animal_id,received.id);
      await client.query('UPDATE external_animal_transfer_item SET destination_animal_id=$3 WHERE transfer_id=$1 AND source_animal_id=$2',[id,item.source_animal_id,received.id]);
      await client.query(`INSERT INTO animal_received_history(animal_id,transfer_id,source_animal_id,snapshot,has_given_birth,has_confirmed_offspring,last_birth_on,last_loss_on)
        VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8)`,[received.id,id,item.source_animal_id,JSON.stringify(snapshot),snapshot.hasGivenBirth,snapshot.hasConfirmedOffspring,snapshot.lastBirthOn,snapshot.lastLossOn]);
      await client.query(`INSERT INTO animal_status_event(property_id,animal_id,from_status,to_status,action_code,reason,occurred_at,created_by)
        VALUES($1,$2,'ACTIVE','INACTIVE','EXTERNAL_TRANSFER',$3,now(),$4)`,[source.id,item.source_animal_id,`Traslado a ${dest.name}: ${request.reason}`,auth.userId]);
    }
    await client.query(`UPDATE external_animal_transfer SET status='ACCEPTED',decided_at=now(),decided_by=$2,version=version+1 WHERE id=$1`,[id,auth.userId]);
    for(const item of items){const snapshot=item.snapshot as AnimalTransferSnapshot;const animalId=moved.get(item.source_animal_id)!;
      for(const role of ['mother','father'] as const){const parent=snapshot.profile[role];if(!parent)continue;
        const registered=await relatedAnimal(client,parent.animalId,dest.account_id,moved);
        await client.query(`INSERT INTO animal_parentage(property_id,child_animal_id,role,parent_animal_id,reported_parent_name,created_by)
          VALUES($1,$2,$3,$4,$5,$6)`,[context.propertyId,animalId,role==='mother'?'MOTHER':'FATHER',registered,registered?null:parent.name,auth.userId]);
      }
      const copies=await copyProcesses(client,auth,context,dest.account_id,id,animalId,snapshot,moved,source.id);
      await client.query(`UPDATE animal_received_history SET snapshot=jsonb_set(snapshot,'{copies}',$2::jsonb) WHERE animal_id=$1`,[animalId,JSON.stringify({...snapshot.copies,...copies})]);
      for(const media of snapshot.media){
        await client.query(`INSERT INTO external_transfer_media_grant(storage_object_id,account_id,animal_id,transfer_id)
          VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[media.storage_object_id,dest.account_id,animalId,id]);
        const attachment=(await client.query(`INSERT INTO media_attachment(account_id,storage_object_id,property_id,entity_type,entity_id,relation_code,created_by,
          description,captured_on,imported_record_type,imported_record_details) VALUES($1,$2,$3,'ANIMAL',$4,$5,$6,$7,$8,$9,$10::jsonb)
          ON CONFLICT(storage_object_id,entity_type,entity_id,relation_code) WHERE deleted_at IS NULL DO UPDATE SET imported_record_type=COALESCE(media_attachment.imported_record_type,EXCLUDED.imported_record_type),
            imported_record_details=COALESCE(media_attachment.imported_record_details,EXCLUDED.imported_record_details)
          RETURNING id`,
          [dest.account_id,media.storage_object_id,context.propertyId,animalId,media.entity_type==='ANIMAL'?media.relation_code:'GENERAL',auth.userId,
            media.description,media.captured_on,media.recordType,JSON.stringify(media.recordDetails)])).rows[0];
        for(const tag of media.tags){const tagId=await copyReference(client,auth,context,dest.account_id,tag.id,'CATALOG');
          await client.query('INSERT INTO media_attachment_tag(attachment_id,tag_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[attachment.id,tagId]);}
      }
      await client.query(`UPDATE milk_lactation SET ended_on=GREATEST(started_on,$2::date),in_milking=false WHERE cow_id=$1 AND ended_on IS NULL`,[item.source_animal_id,request.movement_date]);
      await client.query('UPDATE milk_animal_state SET enabled=false,updated_by=$2 WHERE cow_id=$1',[item.source_animal_id,auth.userId]);
    }
    await audit(client,auth,context,metadata,'EXTERNAL_TRANSFER_ACCEPTED',id,{name:`${source.name} → ${dest.name}`,reason:request.reason,animals:[...moved.values()],groupId:input.groupId});
    // Record the authorized outcome in origin without exposing subsequent destination data.
    await client.query(`INSERT INTO audit_event(actor_user_id,property_id,action,entity_type,entity_id,after_data,ip_address,user_agent)
      VALUES($1,$2,'EXTERNAL_TRANSFER_COMPLETED','EXTERNAL_ANIMAL_TRANSFER',$3,$4::jsonb,$5,$6)`,[auth.userId,source.id,id,JSON.stringify({destinationPropertyId:context.propertyId,animalIds}),metadata.ipAddress,metadata.userAgent]);
    await notify(client,source.id,id,'Traslado aceptado',`${dest.name} aceptó el traslado. Los animales permanecen como registros inactivos en origen.`,'EXTERNAL_TRANSFER_DECIDED');
    return read(client,context,id);
  });}catch(error){const db=error as {code?:string;constraint?:string};
    if(db.code==='P0001')throw conflict('EXTERNAL_TRANSFER_ANIMAL_LIMIT','La cuenta de destino alcanzó su límite de animales.');
    if(db.code==='23505'&&db.constraint==='animal_tag_per_property_unique')throw conflict('EXTERNAL_TRANSFER_TAG_CONFLICT','Ya existe en destino un animal con uno de estos aretes. Corrige esa coincidencia antes de aceptar.');
    if(db.code==='23505')throw conflict('EXTERNAL_TRANSFER_CONFLICT','El animal o una referencia de su ficha ya existe en destino. Actualiza la solicitud antes de continuar.');
    throw error;
  }
}

export async function getReceivedAnimalHistory(context:PropertyContext,id:string){
  return inTransaction(async client=>{
    const row=(await client.query(`SELECT h.snapshot,t.source_name AS "sourcePropertyName",h.received_at FROM animal_received_history h
      JOIN animal a ON a.id=h.animal_id JOIN external_animal_transfer t ON t.id=h.transfer_id
      JOIN property p ON p.id=t.source_property_id WHERE h.animal_id=$1 AND a.property_id=$2 AND a.record_status='CURRENT'`,[id,context.propertyId])).rows[0];
    if(!row)return null;
    return {sourcePropertyName:row.sourcePropertyName,receivedAt:row.received_at,sourceProfile:visibleAnimalSnapshot(row.snapshot as AnimalTransferSnapshot,context).profile,
      history:visibleAnimalSnapshot(row.snapshot as AnimalTransferSnapshot,context).history};
  });
}
async function lockedRequest(client:PoolClient,context:PropertyContext,id:string,version:number){
  const request=(await client.query(`SELECT *,movement_on::text AS movement_date FROM external_animal_transfer WHERE id=$1
    AND (source_property_id=$2 OR destination_property_id=$2) FOR UPDATE`,[id,context.propertyId])).rows[0];
  if(!request)throw new ApiError(404,'EXTERNAL_TRANSFER_NOT_FOUND','La solicitud no está disponible.');
  if(request.status!=='PENDING')throw conflict('EXTERNAL_TRANSFER_DECIDED','Esta solicitud ya fue respondida.');
  if(Number(request.version)!==version)throw conflict('EXTERNAL_TRANSFER_CHANGED','La solicitud cambió. Ábrela de nuevo antes de decidir.');
  return request;
}
export async function decideExternalTransfer(auth:AuthState,context:PropertyContext,id:string,input:ExternalDecisionInput,decision:'REJECTED'|'CANCELLED',metadata:RequestMetadata){
  return inTransaction(async client=>{
    await administrator(client,context,auth.userId);const request=await lockedRequest(client,context,id,input.expectedVersion);
    if((decision==='REJECTED'?request.destination_property_id:request.source_property_id)!==context.propertyId)
      throw forbidden('EXTERNAL_TRANSFER_WRONG_SIDE','La propiedad activa no puede realizar esta acción.');
    await client.query(`UPDATE external_animal_transfer SET status=$2,decided_at=now(),decided_by=$3,
      decision_reason=$4,version=version+1 WHERE id=$1`,[id,decision,auth.userId,input.reason??null]);
    await audit(client,auth,context,metadata,decision==='REJECTED'?'EXTERNAL_TRANSFER_REJECTED':'EXTERNAL_TRANSFER_CANCELLED',id,{reason:input.reason??null});
    await notify(client,decision==='REJECTED'?request.source_property_id:request.destination_property_id,id,
      decision==='REJECTED'?'Traslado rechazado':'Solicitud cancelada',input.reason??'La solicitud terminó y los animales permanecen en origen.','EXTERNAL_TRANSFER_DECIDED');
    return read(client,context,id);
  });
}

async function copyReference(client:PoolClient,auth:AuthState,context:PropertyContext,accountId:string,id:string,kind:'PARTY'|'BRAND'|'CATALOG'){
  const mapped=(await client.query('SELECT destination_id FROM external_transfer_reference_map WHERE source_id=$1 AND account_id=$2 AND kind=$3',[id,accountId,kind])).rows[0];
  const table=kind==='PARTY'?'property_party':kind==='BRAND'?'livestock_brand':'governed_catalog_item';
  const original=(await client.query(`SELECT * FROM ${table} WHERE id=$1`,[id])).rows[0];
  if(!original)throw conflict('EXTERNAL_REFERENCE_CHANGED','Una referencia de la ficha ya no está disponible.');
  if(original.system_defined||original.account_id===accountId)return id;
  let destinationId=mapped?.destination_id as string|undefined;
  if(!destinationId&&kind==='PARTY'&&original.linked_user_id)
    destinationId=(await client.query(`SELECT id FROM property_party WHERE account_id=$1 AND linked_user_id=$2 AND deleted_at IS NULL LIMIT 1`,[accountId,original.linked_user_id])).rows[0]?.id;
  if(!destinationId&&kind==='BRAND')
    destinationId=(await client.query('SELECT id FROM livestock_brand WHERE property_id=$1 AND lower(name)=lower($2) LIMIT 1',[context.propertyId,original.name])).rows[0]?.id;
  if(!destinationId){
    if(kind==='PARTY')destinationId=(await client.query(`INSERT INTO property_party(account_id,property_id,kind,linked_user_id,display_name,created_by)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,[accountId,context.propertyId,original.kind,original.linked_user_id,original.display_name,auth.userId])).rows[0].id;
    else if(kind==='BRAND')destinationId=(await client.query(`INSERT INTO livestock_brand(account_id,property_id,name,created_by) VALUES($1,$2,$3,$4) RETURNING id`,
      [accountId,context.propertyId,original.name,auth.userId])).rows[0].id;
    else destinationId=(await client.query(`INSERT INTO governed_catalog_item(account_id,property_id,catalog_code,species_code,name,description,metadata,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING id`,[accountId,context.propertyId,original.catalog_code,original.species_code,original.name,null,JSON.stringify({}),auth.userId])).rows[0].id;
  }
  await client.query(`INSERT INTO external_transfer_reference_map(source_id,account_id,kind,destination_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[id,accountId,kind,destinationId]);
  return destinationId!;
}

export async function listReceivedAnimalHistories(context:PropertyContext,page:number){
 const ids=await inTransaction(async client=>(await client.query(`SELECT h.animal_id FROM animal_received_history h JOIN animal a ON a.id=h.animal_id
   WHERE a.property_id=$1 AND a.record_status='CURRENT' ORDER BY h.received_at DESC,h.animal_id LIMIT 26 OFFSET $2`,[context.propertyId,(page-1)*25])).rows);
 const items=[];for(const row of ids.slice(0,25))items.push({id:row.animal_id,...await getReceivedAnimalHistory(context,row.animal_id)});
 return {items,page,hasMore:ids.length>25};
}
