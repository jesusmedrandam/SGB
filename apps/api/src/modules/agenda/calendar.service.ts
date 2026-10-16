import type {PoolClient} from 'pg';
import {pool} from '../../database/pool.js';
import {inTransaction} from '../../database/transaction.js';
import {forbidden,invalidRequest} from '../../core/errors.js';
import type {AuthState,PropertyContext,RequestMetadata} from '../auth/auth.types.js';
import {agendaAction,insertAgendaItem,listAgendaItems,listAgendaOptions,type AgendaInput} from './agenda.service.js';

// Each property uses one eligible role. The user's active role is never widened.
export async function calendarContexts(auth:AuthState,current:PropertyContext,client:Pick<PoolClient,'query'>=pool){
 const rows=(await client.query(`SELECT DISTINCT ON(p.id) p.id,p.name,pr.id AS "roleId",pr.code,pr.name AS "roleName",
   ARRAY(SELECT permission_code FROM role_permission WHERE role_id=pr.id) AS permissions,
   ARRAY(SELECT module_code FROM effective_property_module WHERE property_id=p.id AND enabled) AS modules
   FROM property_membership pm JOIN property p ON p.id=pm.property_id AND p.status='ACTIVE' AND p.deleted_at IS NULL
   JOIN administrative_account aa ON aa.id=p.account_id AND aa.status='ACTIVE'
   JOIN membership_role mr ON mr.membership_id=pm.id AND mr.property_id=p.id
   JOIN property_role pr ON pr.id=mr.role_id AND pr.property_id=p.id AND pr.active
   WHERE pm.user_id=$1 AND membership_access_valid(pm)
    AND (p.id IS DISTINCT FROM $2::uuid OR pr.id=$3::uuid)
    AND EXISTS(SELECT 1 FROM role_permission WHERE role_id=pr.id AND permission_code IN ('AGENDA_TASK_VIEW','AGENDA_EVENT_VIEW'))
   ORDER BY p.id,CASE pr.code WHEN 'OWNER' THEN 0 WHEN 'ADMINISTRATOR' THEN 1 ELSE 2 END,
    (SELECT count(*) FROM role_permission WHERE role_id=pr.id) DESC,pr.id`,[auth.userId,auth.activePropertyId,auth.activeRoleId])).rows;
 const contexts:PropertyContext[]=rows.map(row=>({propertyId:row.id,propertyName:row.name,roleId:row.roleId,
   roleCode:row.code,roleName:row.roleName,permissions:new Set<string>(row.permissions),
   enabledModules:new Set<string>(row.modules),enabledSpecies:new Set<string>()}));
 if(current.isSuperadmin)return [current];
 return contexts.filter(context=>can(context,'TASKS','AGENDA_TASK_VIEW')||can(context,'EVENTS','AGENDA_EVENT_VIEW'));
}
function can(context:PropertyContext,module:string,permission:string){return context.enabledModules.has(module)&&context.permissions.has(permission);}
export async function calendarOptions(auth:AuthState,current:PropertyContext){
 const contexts=await calendarContexts(auth,current);
 return {properties:await Promise.all(contexts.map(async context=>({...await listAgendaOptions(context),
  id:context.propertyId,name:context.propertyName,roleId:context.roleId}))) };
}
export async function createSharedAgenda(auth:AuthState,current:PropertyContext,input:AgendaInput&{propertyIds?:string[]|undefined},meta:RequestMetadata){
 const ids=input.propertyIds??[current.propertyId];
 return inTransaction(async client=>{
  // Serialize with role/membership changes, and resolve permissions again inside the write transaction.
  await client.query(`SELECT p.id FROM property p JOIN property_membership pm ON pm.property_id=p.id
    JOIN membership_role mr ON mr.membership_id=pm.id AND mr.property_id=p.id
    JOIN property_role pr ON pr.id=mr.role_id AND pr.property_id=p.id
    JOIN administrative_account aa ON aa.id=p.account_id WHERE p.id=ANY($1::uuid[]) AND pm.user_id=$2
    ORDER BY p.id FOR SHARE OF p,pm,pr,mr,aa`,[ids,auth.userId]);
  const contexts=(await calendarContexts(auth,current,client)).filter(c=>ids.includes(c.propertyId));
  if(contexts.length!==ids.length)throw forbidden('AGENDA_PROPERTY_DENIED','Una propiedad ya no está disponible para tu usuario o rol.');
  if(ids.length>1&&input.animalIds.length)throw invalidRequest('AGENDA_ANIMAL_SCOPE','Selecciona una sola propiedad para relacionar animales.');
  const memberships=(await client.query(`SELECT user_id,property_id FROM property_membership pm
    JOIN app_user u ON u.id=pm.user_id AND u.status='ACTIVE' AND u.deleted_at IS NULL
    WHERE property_id=ANY($1::uuid[]) AND user_id=ANY($2::uuid[]) AND membership_access_valid(pm)
    FOR SHARE OF pm,u`,[ids,input.userIds])).rows;
  if(input.userIds.some(id=>!memberships.some(row=>row.user_id===id)))throw invalidRequest('AGENDA_USER_INVALID','Un destinatario ya no pertenece a las propiedades elegidas.');
  const result=[];
  for(const context of contexts){
   const userIds=input.userIds.filter(id=>memberships.some(row=>row.user_id===id&&row.property_id===context.propertyId));
   if(input.visibility==='SELECTED'&&!userIds.length)throw invalidRequest('AGENDA_USER_SCOPE','Selecciona al menos un destinatario de cada propiedad elegida.');
   result.push(await insertAgendaItem(client,auth,context,{...input,userIds},meta));
  }
  // Keep the original POST response shape for installed clients.
  return {...result[0],createdItems:result};
 });
}
export async function calendarAction(auth:AuthState,current:PropertyContext,propertyId:string,id:string,action:'ACCEPT'|'DECLINE'|'COMPLETE'|'CANCEL',meta:RequestMetadata){
 const context=(await calendarContexts(auth,current)).find(row=>row.propertyId===propertyId);
 if(!context)throw forbidden('AGENDA_PROPERTY_DENIED','Ya no tienes acceso a esta propiedad.');
 return agendaAction(auth,context,id,action,meta);
}
export async function agendaCalendar(auth:AuthState,current:PropertyContext,range:{from:string;to:string;propertyId?:string|undefined}){
 const contexts=(await calendarContexts(auth,current)).filter(c=>!range.propertyId||c.propertyId===range.propertyId);
 if(range.propertyId&&!contexts.length)throw forbidden('AGENDA_PROPERTY_DENIED','No tienes acceso a esa propiedad.');
 const rows=await Promise.all(contexts.map(async context=>{
  const items=(await listAgendaItems(auth,context,range)).map(item=>({...item,source:'AGENDA',
   canManage:can(context,item.kind==='TASK'?'TASKS':'EVENTS',`AGENDA_${item.kind}_MANAGE`)}));
  const automatic=(await pool.query(`WITH entries AS (
   SELECT 'TREATMENT' AS source,h.id,CASE h.status WHEN 'BORRADOR' THEN 'Tratamiento en borrador · ' ELSE 'Tratamiento · ' END||m.name AS title,h.notes AS instructions,h.applied_on AS day,
    CASE h.status WHEN 'COMPLETADO' THEN 'COMPLETED' ELSE 'PENDING' END AS status
   FROM health_campaign h JOIN health_medicine m ON m.id=h.medicine_id
   WHERE h.property_id=$1 AND h.status<>'CANCELADO' AND h.expired_at IS NULL
    AND (h.status='COMPLETADO' OR h.created_at>now()-interval '24 hours') AND $4::boolean
   UNION ALL SELECT 'BIRTH_EXPECTED',r.id,'Parto previsto · '||a.name,r.notes,r.expected_birth_on,'PENDING'
   FROM reproduction_pregnancy r JOIN animal a ON a.id=r.cow_id AND a.property_id=r.property_id
   WHERE r.property_id=$1 AND r.status='CONFIRMED' AND a.record_status='CURRENT' AND a.transferred_out_at IS NULL AND $5::boolean
   UNION ALL SELECT 'BIRTH',r.id,'Parto · '||a.name,r.notes,r.occurred_on,'COMPLETED'
   FROM reproduction_birth r JOIN animal a ON a.id=r.mother_id AND a.property_id=r.property_id
   WHERE r.property_id=$1 AND $5::boolean
   UNION ALL SELECT 'RETURN',g.id,'Regreso previsto · '||g.name,g.external_place,g.expected_return_on,'PENDING'
   FROM livestock_group g WHERE g.property_id=$1 AND g.active AND g.kind='EXTERNAL' AND $6::boolean
  ) SELECT source,id,title,instructions,day::text AS "allDayDate",day::text||'T12:00:00-05:00' AS "scheduledAt",status
   FROM entries WHERE ((day+1)::timestamp AT TIME ZONE 'America/Guayaquil') > $2::timestamptz
    AND (day::timestamp AT TIME ZONE 'America/Guayaquil') < $3::timestamptz`,
   [context.propertyId,range.from,range.to,can(context,'HEALTH','HEALTH_VIEW'),can(context,'REPRODUCTION','REPRODUCTION_VIEW'),
    context.permissions.has('GROUP_VIEW')&&(context.enabledModules.has('PASTURES')||context.enabledModules.has('CORRALS'))])).rows;
  return [...items,...automatic.map(item=>({...item,id:`${item.source}:${item.id}`,kind:'EVENT',activityType:item.source,
   visibility:'ALL',reminderAt:null,createdBy:null,createdByName:'Registro de la propiedad',myResponse:null,users:[],animals:[],
   propertyId:context.propertyId,propertyName:context.propertyName,roleId:context.roleId,canManage:false}))];
 }));
 return rows.flat().sort((a,b)=>Date.parse(a.scheduledAt)-Date.parse(b.scheduledAt)||a.id.localeCompare(b.id));
}
