import type {PoolClient} from 'pg';
import {ApiError,conflict,forbidden,invalidRequest} from '../../core/errors.js';
import {pool} from '../../database/pool.js';
import {inTransaction} from '../../database/transaction.js';
import type {AuthState,PropertyContext,RequestMetadata} from '../auth/auth.types.js';
import {superadminPropertyAccess} from '../auth/superadmin-access.js';

type Kind='TASK'|'EVENT';
export type AgendaInput={kind:Kind;activityType:string;title:string;instructions:string|null;
  scheduledAt:string;reminderAt:string|null;visibility:'PRIVATE'|'SELECTED'|'ALL';
  userIds:string[];animalIds:string[]};
const permission=(kind:Kind,operation:'VIEW'|'MANAGE')=>`AGENDA_${kind}_${operation}`;
const moduleCode=(kind:Kind)=>kind==='TASK'?'TASKS':'EVENTS';
function allowed(context:PropertyContext,kind:Kind,operation:'VIEW'|'MANAGE'){
  return context.enabledModules.has(moduleCode(kind))&&context.permissions.has(permission(kind,operation));
}
function canView(context:PropertyContext){
  if(!allowed(context,'TASK','VIEW')&&!allowed(context,'EVENT','VIEW'))
    throw forbidden('AGENDA_DENIED','La agenda no está habilitada para este rol o propiedad.');
}
async function checkAccess(client:PoolClient,auth:AuthState,context:PropertyContext,kind:Kind,operation:'VIEW'|'MANAGE'){
  if(await superadminPropertyAccess(client,auth,context))return;
  const grant=await client.query(`SELECT p.id FROM property p
    JOIN administrative_account aa ON aa.id=p.account_id AND aa.status='ACTIVE'
    JOIN property_membership pm ON pm.property_id=p.id AND pm.user_id=$2 AND membership_access_valid(pm)
    JOIN membership_role mr ON mr.membership_id=pm.id AND mr.property_id=p.id
    JOIN property_role pr ON pr.id=mr.role_id AND pr.property_id=p.id AND pr.active
    JOIN role_permission rp ON rp.role_id=pr.id AND rp.permission_code=$4
    JOIN effective_property_module epm ON epm.property_id=p.id AND epm.enabled AND epm.module_code=$5
    WHERE p.id=$1 AND pr.id=$3 AND p.status='ACTIVE' AND p.deleted_at IS NULL
    FOR SHARE OF p,aa,pm,mr,pr,rp`,[context.propertyId,auth.userId,context.roleId,permission(kind,operation),moduleCode(kind)]);
  if(!grant.rowCount)throw forbidden('AGENDA_ACCESS_REVOKED','Ya no tienes permiso para esta tarea o evento.');
}
const fields=`SELECT i.id,i.kind,i.activity_type AS "activityType",i.title,i.instructions,
  i.property_id AS "propertyId",p.name AS "propertyName",i.scheduled_at AS "scheduledAt",i.reminder_at AS "reminderAt",i.visibility,i.status,
  i.created_by AS "createdBy",i.created_at AS "createdAt",u.display_name AS "createdByName",
  (SELECT ap.response FROM agenda_participant ap WHERE ap.item_id=i.id AND ap.user_id=$2)
    AS "myResponse",
  coalesce((SELECT jsonb_agg(jsonb_build_object('id',ap.user_id,'name',member.display_name,
    'response',ap.response) ORDER BY member.display_name) FROM agenda_participant ap
    JOIN app_user member ON member.id=ap.user_id WHERE ap.item_id=i.id),'[]'::jsonb) AS users,
  coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,
    'earTagCode',a.ear_tag_code) ORDER BY a.name) FROM agenda_animal aa
    JOIN animal a ON a.id=aa.animal_id WHERE aa.item_id=i.id),'[]'::jsonb) AS animals
  FROM agenda_item i JOIN app_user u ON u.id=i.created_by JOIN property p ON p.id=i.property_id`;
async function read(client:PoolClient,auth:AuthState,context:PropertyContext,id:string){
  const row=(await client.query(`${fields} WHERE i.id=$3 AND i.property_id=$1`,
    [context.propertyId,auth.userId,id])).rows[0];
  if(!row)throw new ApiError(404,'AGENDA_NOT_FOUND','Elemento de agenda no encontrado.');
  return {...row,roleId:context.roleId};
}
export async function listAgendaItems(auth:AuthState,context:PropertyContext,range?:{from:string;to:string}){
  canView(context);
  return (await pool.query(`${fields} WHERE i.property_id=$1
    AND ((i.kind='TASK' AND $3::boolean) OR (i.kind='EVENT' AND $4::boolean))
    AND ($5::boolean OR i.created_by=$2 OR EXISTS (SELECT 1 FROM agenda_participant ap
      WHERE ap.item_id=i.id AND ap.user_id=$2) OR i.visibility='ALL')
    AND ($6::timestamptz IS NULL OR i.scheduled_at >= $6)
    AND ($7::timestamptz IS NULL OR i.scheduled_at < $7)
    ORDER BY i.scheduled_at ASC,i.id ASC`,
    [context.propertyId,auth.userId,allowed(context,'TASK','VIEW'),
      allowed(context,'EVENT','VIEW'),Boolean(context.isSuperadmin),range?.from??null,range?.to??null])).rows.map(row=>({...row,roleId:context.roleId,canManage:allowed(context,row.kind,'MANAGE')}));
}
export async function listAgendaOptions(context:PropertyContext){
  canView(context);
  const [users,animals]=await Promise.all([
    pool.query(`SELECT u.id,u.display_name AS name FROM property_membership pm
      JOIN app_user u ON u.id=pm.user_id AND u.status='ACTIVE' AND u.deleted_at IS NULL
      WHERE pm.property_id=$1 AND membership_access_valid(pm)
      ORDER BY lower(u.display_name) LIMIT 500`,[context.propertyId]),
    pool.query(`SELECT id,name,ear_tag_code AS "earTagCode" FROM animal
      WHERE property_id=$1 AND record_status='CURRENT' AND transferred_out_at IS NULL AND $2::boolean
      ORDER BY lower(name) LIMIT 5000`,[context.propertyId,context.permissions.has('ANIMAL_VIEW')])]);
  return {users:users.rows,animals:animals.rows,tasks:allowed(context,'TASK','MANAGE'),
    events:allowed(context,'EVENT','MANAGE')};
}
async function audit(client:PoolClient,auth:AuthState,context:PropertyContext,meta:RequestMetadata,
  action:string,id:string,before:unknown,after:unknown){
  await client.query(`INSERT INTO audit_event(actor_user_id,property_id,active_role_id,action,
    entity_type,entity_id,before_data,after_data,ip_address,user_agent)
    VALUES($1,$2,$3,$4,'AGENDA_ITEM',$5,$6::jsonb,$7::jsonb,$8,$9)`,
    [auth.userId,context.propertyId,context.roleId,action,id,before===null?null:JSON.stringify(before),
      JSON.stringify(after),meta.ipAddress,meta.userAgent]);
}
export async function createAgendaItem(auth:AuthState,context:PropertyContext,input:AgendaInput,
  meta:RequestMetadata){
  return inTransaction(client=>insertAgendaItem(client,auth,context,input,meta));
}
export async function insertAgendaItem(client:PoolClient,auth:AuthState,context:PropertyContext,input:AgendaInput,meta:RequestMetadata){
  if(!allowed(context,input.kind,'MANAGE'))throw forbidden('AGENDA_MANAGE_DENIED',
    'Este rol no puede crear tareas o eventos.');
  if(input.visibility==='SELECTED'&&!input.userIds.length)
    throw invalidRequest('AGENDA_ASSIGNEE_REQUIRED','Asigna al menos un usuario a la tarea.');
  if(input.visibility!=='SELECTED'&&input.userIds.length)
    throw invalidRequest('AGENDA_VISIBILITY','Selecciona usuarios únicamente al compartir con usuarios seleccionados.');
  if(input.reminderAt&&Date.parse(input.reminderAt)>Date.parse(input.scheduledAt))
    throw invalidRequest('AGENDA_REMINDER_DATE','El recordatorio no puede ser posterior al evento.');
    await checkAccess(client,auth,context,input.kind,'MANAGE');
    if(input.animalIds.length&&!context.permissions.has('ANIMAL_VIEW'))
      throw forbidden('AGENDA_ANIMAL_DENIED','Tu rol no permite relacionar animales.');
    const participants=(await client.query<{id:string}>(`SELECT user_id AS id
      FROM property_membership pm WHERE property_id=$1 AND membership_access_valid(pm)
      AND user_id=ANY($2::uuid[])`,[context.propertyId,input.userIds])).rows;
    if(participants.length!==input.userIds.length)
      throw invalidRequest('AGENDA_USER_INVALID','Algunos usuarios ya no pertenecen a esta propiedad.');
    const animals=(await client.query<{id:string}>(`SELECT id FROM animal
      WHERE property_id=$1 AND record_status='CURRENT' AND id=ANY($2::uuid[])`,
      [context.propertyId,input.animalIds])).rows;
    if(animals.length!==input.animalIds.length)
      throw invalidRequest('AGENDA_ANIMAL_INVALID','Algunos animales ya no pertenecen a esta propiedad.');
    const id=(await client.query<{id:string}>(`INSERT INTO agenda_item(property_id,kind,
      activity_type,title,instructions,scheduled_at,reminder_at,visibility,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [context.propertyId,input.kind,input.activityType,input.title,input.instructions,
        input.scheduledAt,input.reminderAt,input.visibility,auth.userId])).rows[0]!.id;
    const assignees=input.visibility==='PRIVATE'?[auth.userId]:input.userIds;
    if(assignees.length)await client.query(`INSERT INTO agenda_participant(item_id,user_id)
      SELECT $1,unnest($2::uuid[])`,[id,assignees]);
    if(input.animalIds.length)await client.query(`INSERT INTO agenda_animal(item_id,animal_id)
      SELECT $1,unnest($2::uuid[])`,[id,input.animalIds]);
    await client.query(`INSERT INTO app_notification(user_id,property_id,agenda_item_id,
      kind,title,message)
      SELECT recipients.user_id,$2,$1,'AGENDA_ASSIGNED',$3,$4
      FROM (SELECT ap.user_id FROM agenda_participant ap WHERE ap.item_id=$1
        UNION SELECT pm.user_id FROM property_membership pm
          WHERE pm.property_id=$2 AND membership_access_valid(pm) AND $5='ALL') recipients
      WHERE recipients.user_id<>$6
      ON CONFLICT(user_id,agenda_item_id,kind) DO NOTHING`,
      [id,context.propertyId,input.title,input.kind==='TASK'?'Tienes una tarea asignada.':
        'Hay un evento compartido en tu propiedad.',input.visibility,auth.userId]);
    const after=await read(client,auth,context,id);
    await audit(client,auth,context,meta,'AGENDA_CREATED',id,null,after);
    return after;
}
export async function agendaAction(auth:AuthState,context:PropertyContext,id:string,
  action:'ACCEPT'|'DECLINE'|'COMPLETE'|'CANCEL',meta:RequestMetadata){
  return inTransaction(async client=>{
    const item=(await client.query<{kind:Kind;status:string;created_by:string;visibility:string}>(`
      SELECT kind,status,created_by,visibility FROM agenda_item WHERE id=$1 AND property_id=$2 FOR UPDATE`,
      [id,context.propertyId])).rows[0];
    if(!item)throw new ApiError(404,'AGENDA_NOT_FOUND','Elemento no encontrado.');
    await checkAccess(client,auth,context,item.kind,action==='COMPLETE'||action==='CANCEL'?'MANAGE':'VIEW');
    if(!allowed(context,item.kind,'VIEW'))throw forbidden('AGENDA_VIEW_DENIED',
      'No tienes acceso a este elemento.');
    if(item.status!=='PENDING')throw conflict('AGENDA_FINISHED','La tarea o evento ya finalizó.');
    let participant=(await client.query<{response:string}>(`SELECT response FROM agenda_participant
      WHERE item_id=$1 AND user_id=$2 FOR UPDATE`,[id,auth.userId])).rows[0];
    if(item.kind==='TASK'&&item.visibility==='ALL'&&!participant&&(action==='ACCEPT'||action==='DECLINE'||action==='COMPLETE')){
      await client.query('INSERT INTO agenda_participant(item_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,auth.userId]);
      participant={response:'PENDING'};
    }
    if(action==='ACCEPT'||action==='DECLINE'){
      if(!participant)throw forbidden('AGENDA_NOT_ASSIGNED','No estás asignado a esta tarea.');
      if(participant.response!=='PENDING')throw conflict('AGENDA_ALREADY_ANSWERED',
        'Tu respuesta ya está registrada.');
      if(item.kind!=='TASK')throw invalidRequest('AGENDA_EVENT_RESPONSE',
        'La confirmación se aplica solo a tareas.');
    }else if(action==='COMPLETE'){
      if(item.kind!=='TASK'||!allowed(context,'TASK','MANAGE'))
        throw forbidden('AGENDA_COMPLETE_DENIED','Este rol no puede completar la tarea.');
      if(item.created_by!==auth.userId&&(!participant||participant.response==='DECLINED')&&!Boolean(context.isSuperadmin))
        throw forbidden('AGENDA_COMPLETE_DENIED','No estás asignado a esta tarea.');
    }else if((item.created_by!==auth.userId||!allowed(context,item.kind,'MANAGE'))&&!Boolean(context.isSuperadmin))
      throw forbidden('AGENDA_CANCEL_DENIED','Solo quien creó el elemento puede cancelarlo.');
    const before=await read(client,auth,context,id);
    if(action==='ACCEPT'||action==='DECLINE')await client.query(`UPDATE agenda_participant
      SET response=$3,responded_at=now() WHERE item_id=$1 AND user_id=$2`,
      [id,auth.userId,action==='ACCEPT'?'ACCEPTED':'DECLINED']);
    else await client.query(`UPDATE agenda_item SET status=$2::varchar,
      completed_at=CASE WHEN $2::varchar='COMPLETED' THEN now() ELSE NULL END,
      completed_by=CASE WHEN $2::varchar='COMPLETED' THEN $3::uuid ELSE NULL END,
      cancelled_at=CASE WHEN $2::varchar='CANCELLED' THEN now() ELSE NULL END,
      cancelled_by=CASE WHEN $2::varchar='CANCELLED' THEN $3::uuid ELSE NULL END WHERE id=$1`,
      [id,action==='COMPLETE'?'COMPLETED':'CANCELLED',auth.userId]);
    if(action==='COMPLETE'||action==='CANCEL')await client.query(`INSERT INTO app_notification
      (user_id,property_id,agenda_item_id,kind,title,message)
      SELECT recipients.user_id,$2,$1,$3,$4,$5 FROM
        (SELECT ap.user_id FROM agenda_participant ap WHERE ap.item_id=$1
         UNION SELECT created_by AS user_id FROM agenda_item WHERE id=$1
         UNION SELECT pm.user_id FROM property_membership pm JOIN agenda_item i ON i.id=$1
          WHERE pm.property_id=i.property_id AND i.visibility='ALL' AND membership_access_valid(pm)) recipients
      WHERE recipients.user_id<>$6
      ON CONFLICT(user_id,agenda_item_id,kind) DO NOTHING`,
      [id,context.propertyId,action==='COMPLETE'?'AGENDA_COMPLETED':'AGENDA_CANCELLED',
        before.title,action==='COMPLETE'?'La tarea se marcó como realizada.':
          'La tarea o evento se canceló.',auth.userId]);
    const after=await read(client,auth,context,id);
    await audit(client,auth,context,meta,`AGENDA_${action}`,id,before,after);
    return after;
  });
}
