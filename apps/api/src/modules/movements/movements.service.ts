import type {PoolClient} from 'pg';
import {ApiError,conflict,forbidden,invalidRequest} from '../../core/errors.js';
import {pool} from '../../database/pool.js';
import {inTransaction} from '../../database/transaction.js';
import type {AuthState,PropertyContext,RequestMetadata} from '../auth/auth.types.js';
import type {MovementInput} from './movements.schemas.js';

// The former system's draft -> validate -> apply flow, using SGB's immutable
// group/location intervals and account-scoped properties.
type QueryClient=Pick<PoolClient,'query'>;
type Group={id:string;property_id:string;location_id:string|null;name:string};
type Animal={id:string;name:string;group_id:string|null;location_id:string|null};
type Draft={id:string;account_id:string;source_property_id:string;destination_property_id:string;
  kind:MovementInput['kind'];selection_mode:MovementInput['selectionMode'];
  source_group_id:string;destination_group_id:string;source_location_id:string|null;
  destination_location_id:string|null;movement_on:string;reason:string;notes:string|null;
  status:string;version:string};
type Resolved={source:Group;destination:Group;destinationLocationId:string|null;
  animals:Animal[];sourceLocationId:string|null;accountId:string};

async function access(client:PoolClient,auth:AuthState,context:PropertyContext,permission:string){
  const row=(await client.query<{account_id:string;today:string}>(
    `SELECT p.account_id,(now() AT TIME ZONE p.timezone)::date::text AS today
     FROM property p JOIN administrative_account aa ON aa.id=p.account_id AND aa.status='ACTIVE'
     JOIN property_membership pm ON pm.property_id=p.id AND pm.user_id=$2 AND pm.status='ACTIVE'
     JOIN membership_role mr ON mr.membership_id=pm.id AND mr.property_id=p.id
     JOIN property_role pr ON pr.id=mr.role_id AND pr.property_id=p.id AND pr.active
     JOIN role_permission rp ON rp.role_id=pr.id AND rp.permission_code=$4
     JOIN effective_property_module epm ON epm.property_id=p.id
       AND epm.module_code='MOVEMENTS' AND epm.enabled
     WHERE p.id=$1 AND pr.id=$3 AND p.status='ACTIVE' AND p.deleted_at IS NULL
     FOR SHARE OF p,pm,pr`,[context.propertyId,auth.userId,context.roleId,permission])).rows[0];
  if(!row)throw forbidden('MOVEMENT_DENIED','El módulo o el rol activo no permiten esta operación.');
  return row;
}

async function destinationAccess(client:PoolClient,auth:AuthState,accountId:string,propertyId:string){
  const row=(await client.query<{id:string}>(
    `SELECT p.id FROM property p
     JOIN administrative_account aa ON aa.id=p.account_id AND aa.status='ACTIVE'
     JOIN property_membership pm ON pm.property_id=p.id AND pm.user_id=$2 AND pm.status='ACTIVE'
     JOIN membership_role mr ON mr.membership_id=pm.id AND mr.property_id=p.id
     JOIN property_role pr ON pr.id=mr.role_id AND pr.property_id=p.id AND pr.active
     JOIN role_permission rp ON rp.role_id=pr.id AND rp.permission_code='MOVEMENT_MANAGE'
     JOIN effective_property_module epm ON epm.property_id=p.id AND epm.module_code='MOVEMENTS' AND epm.enabled
     WHERE p.id=$1 AND p.account_id=$3 AND p.status='ACTIVE' AND p.deleted_at IS NULL
     LIMIT 1 FOR SHARE OF p,pm,pr`,[propertyId,auth.userId,accountId])).rows[0];
  if(!row)throw forbidden('MOVEMENT_DESTINATION_DENIED',
    'Necesitas acceso para gestionar movimientos en la propiedad de destino de la misma cuenta.');
}

async function requireLocations(client:PoolClient,propertyIds:string[]){
  for(const propertyId of new Set(propertyIds)){
    const result=await client.query<{module_code:string}>(
      `SELECT module_code FROM effective_property_module WHERE property_id=$1
        AND module_code IN ('PASTURES','CORRALS','MOVEMENTS') AND enabled`,[propertyId]);
    if(result.rows.length!==3)throw forbidden('MOVEMENT_LOCATION_MODULES_DISABLED',
      'Para mover entre potreros o corrales habilita Potreros, Corrales y Movimientos en ambas propiedades.');
  }
}

async function audit(client:PoolClient,auth:AuthState,context:PropertyContext,
  metadata:RequestMetadata,action:string,id:string,before:unknown,after:unknown){
  await client.query(`INSERT INTO audit_event(actor_user_id,property_id,active_role_id,
    action,entity_type,entity_id,before_data,after_data,ip_address,user_agent)
    VALUES($1,$2,$3,$4,'LIVESTOCK_MOVEMENT',$5,$6::jsonb,$7::jsonb,$8,$9)`,
    [auth.userId,context.propertyId,context.roleId,action,id,
      before===null?null:JSON.stringify(before),JSON.stringify(after),metadata.ipAddress,metadata.userAgent]);
}

const fields=`m.id,m.account_id,m.source_property_id,m.destination_property_id,
  m.kind,m.selection_mode,m.source_group_id,m.destination_group_id,
  m.source_location_id,m.destination_location_id,m.movement_on::text AS movement_on,
  m.reason,m.notes,m.status,m.version::text,m.created_at,m.applied_at,m.cancelled_at,
  p1.name AS source_property_name,p2.name AS destination_property_name,
  sg.name AS source_group_name,dg.name AS destination_group_name,
  sl.name AS source_location_name,dl.name AS destination_location_name,
  COALESCE((SELECT json_agg(json_build_object('id',ma.animal_id,'name',a.name,
    'sourceGroupId',ma.source_group_id,'sourceLocationId',ma.source_location_id,
    'destinationGroupId',ma.destination_group_id,'destinationLocationId',ma.destination_location_id)
    ORDER BY lower(a.name),a.id) FROM livestock_movement_animal ma JOIN animal a ON a.id=ma.animal_id
    WHERE ma.movement_id=m.id),'[]'::json) AS animals`;
const joins=`FROM livestock_movement m JOIN property p1 ON p1.id=m.source_property_id
  JOIN property p2 ON p2.id=m.destination_property_id
  JOIN livestock_group sg ON sg.id=m.source_group_id
  JOIN livestock_group dg ON dg.id=m.destination_group_id
  LEFT JOIN physical_location sl ON sl.id=m.source_location_id
  LEFT JOIN physical_location dl ON dl.id=m.destination_location_id`;
function view(row:Record<string,unknown>){
  return {id:row.id as string,kind:row.kind,selectionMode:row.selection_mode,
    sourcePropertyId:row.source_property_id,sourcePropertyName:row.source_property_name,
    destinationPropertyId:row.destination_property_id,destinationPropertyName:row.destination_property_name,
    sourceGroupId:row.source_group_id,sourceGroupName:row.source_group_name,
    destinationGroupId:row.destination_group_id,destinationGroupName:row.destination_group_name,
    sourceLocationId:row.source_location_id,sourceLocationName:row.source_location_name,
    destinationLocationId:row.destination_location_id,destinationLocationName:row.destination_location_name,
    movementOn:row.movement_on,reason:row.reason,notes:row.notes,status:row.status as string,
    version:Number(row.version),animals:row.animals as Array<{id:string;name:string}>,createdAt:row.created_at,
    appliedAt:row.applied_at,cancelledAt:row.cancelled_at};
}
async function read(client:QueryClient,id:string){
  const row=(await client.query(`SELECT ${fields} ${joins} WHERE m.id=$1`,[id])).rows[0];
  if(!row)throw new ApiError(404,'MOVEMENT_NOT_FOUND','El movimiento no está disponible.');
  return view(row);
}
export async function listMovements(context:PropertyContext){
  const result=await pool.query(`SELECT ${fields} ${joins}
    WHERE m.source_property_id=$1 OR m.destination_property_id=$1
    ORDER BY m.created_at DESC,m.id DESC LIMIT 250`,[context.propertyId]);
  return result.rows.map(view);
}
export async function listMovementOptions(auth:AuthState,context:PropertyContext){
  const account=(await pool.query<{account_id:string}>(
    `SELECT account_id FROM property WHERE id=$1`,[context.propertyId])).rows[0]?.account_id;
  if(!account)throw forbidden('MOVEMENT_DENIED','Selecciona una propiedad válida.');
  const [properties,groups,locations,animals]=await Promise.all([
    pool.query(`SELECT DISTINCT p.id,p.name FROM property p
      JOIN property_membership pm ON pm.property_id=p.id AND pm.user_id=$2 AND pm.status='ACTIVE'
      JOIN membership_role mr ON mr.membership_id=pm.id AND mr.property_id=p.id
      JOIN property_role pr ON pr.id=mr.role_id AND pr.active AND pr.property_id=p.id
      JOIN role_permission rp ON rp.role_id=pr.id AND rp.permission_code='MOVEMENT_MANAGE'
      JOIN effective_property_module epm ON epm.property_id=p.id AND epm.module_code='MOVEMENTS' AND epm.enabled
      WHERE p.account_id=$1 AND p.status='ACTIVE' AND p.deleted_at IS NULL
      ORDER BY p.name`,[account,auth.userId]),
    pool.query(`SELECT g.id,g.name,g.property_id AS "propertyId",pl.id AS "locationId",
      pl.name AS "locationName" FROM livestock_group g
      LEFT JOIN group_location_assignment gla ON gla.group_id=g.id AND gla.ended_at IS NULL
      LEFT JOIN physical_location pl ON pl.id=gla.location_id
      WHERE g.account_id=$1 AND g.active AND g.property_id IN
        (SELECT pm.property_id FROM property_membership pm WHERE pm.user_id=$2 AND pm.status='ACTIVE')
      ORDER BY lower(g.name)`,[account,auth.userId]),
    pool.query(`SELECT id,name,kind,property_id AS "propertyId" FROM physical_location
      WHERE account_id=$1 AND active AND property_id IN
        (SELECT pm.property_id FROM property_membership pm WHERE pm.user_id=$2 AND pm.status='ACTIVE')
      ORDER BY lower(name)`,[account,auth.userId]),
    pool.query(`SELECT a.id,a.name,a.ear_tag_code AS "earTagCode",
      aga.group_id AS "groupId",ala.location_id AS "locationId" FROM animal a
      LEFT JOIN animal_group_assignment aga ON aga.animal_id=a.id AND aga.ended_at IS NULL
      LEFT JOIN animal_location_assignment ala ON ala.animal_id=a.id AND ala.ended_at IS NULL
      WHERE a.property_id=$1 AND a.record_status='CURRENT' AND a.availability_status_code='ACTIVE'
      ORDER BY lower(a.name),a.id LIMIT 5000`,[context.propertyId]),
  ]);
  const ids=new Set(properties.rows.map((row)=>row.id as string));
  return {properties:properties.rows,groups:groups.rows.filter((row)=>ids.has(row.propertyId)),
    locations:locations.rows.filter((row)=>ids.has(row.propertyId)),animals:animals.rows};
}

async function resolve(client:PoolClient,auth:AuthState,context:PropertyContext,
  input:MovementInput,accountId:string):Promise<Resolved>{
  await destinationAccess(client,auth,accountId,input.destinationPropertyId);
  const groupRows=await client.query<Group>(`SELECT g.id,g.property_id,g.name,
    gla.location_id FROM livestock_group g
    LEFT JOIN group_location_assignment gla ON gla.group_id=g.id AND gla.ended_at IS NULL
    WHERE g.id=ANY($1::uuid[]) AND g.account_id=$2 AND g.active
    ORDER BY g.id FOR UPDATE OF g`,
    [[input.sourceGroupId,input.destinationGroupId],accountId]);
  const source=groupRows.rows.find((item)=>item.id===input.sourceGroupId);
  const destination=groupRows.rows.find((item)=>item.id===input.destinationGroupId);
  if(!source || source.property_id!==context.propertyId || !destination
    || destination.property_id!==input.destinationPropertyId)
    throw invalidRequest('MOVEMENT_GROUP_INVALID','Selecciona grupos activos de las propiedades de origen y destino.');
  const cross=context.propertyId!==input.destinationPropertyId;
  if((input.kind==='PROPIEDAD' && !cross)
    || (input.kind==='GRUPO' || input.kind==='UBICACION') && cross)
    throw invalidRequest('MOVEMENT_PROPERTIES_INVALID','Elige propiedades diferentes para un traslado y la misma para un cambio interno.');
  if(input.kind==='UBICACION' && (input.selectionMode!=='GRUPO' || source.id!==destination.id))
    throw invalidRequest('MOVEMENT_GROUP_REQUIRED','La rotación mueve el grupo completo, sin cambiarlo de grupo.');
  if(input.kind!=='UBICACION' && source.id===destination.id)
    throw invalidRequest('MOVEMENT_SAME_GROUP','Selecciona otro grupo de destino.');
  const destinationLocationId=input.kind==='UBICACION'
    ? input.destinationLocationId??null : destination.location_id;
  if(input.kind==='UBICACION' && (!destinationLocationId
    || source.location_id===destinationLocationId))
    throw invalidRequest('MOVEMENT_LOCATION_INVALID','Elige una ubicación diferente para el grupo completo.');
  if(input.kind!=='UBICACION' && input.destinationLocationId
    && input.destinationLocationId!==destinationLocationId)
    throw invalidRequest('MOVEMENT_LOCATION_INVALID','La ubicación de destino la determina el grupo de destino.');
  if(destinationLocationId){
    const location=await client.query<{id:string}>(
      `SELECT pl.id FROM physical_location pl WHERE pl.id=$1 AND pl.account_id=$2
        AND pl.property_id=$3 AND pl.active FOR UPDATE`,
      [destinationLocationId,accountId,input.destinationPropertyId]);
    if(!location.rows[0])throw invalidRequest('MOVEMENT_LOCATION_INVALID','El potrero o corral de destino no está activo.');
    await requireLocations(client,[context.propertyId,input.destinationPropertyId]);
  }
  if(input.kind==='UBICACION'){
    const occupied=await client.query(`SELECT 1 FROM group_location_assignment
      WHERE location_id=$1 AND ended_at IS NULL LIMIT 1`,[destinationLocationId]);
    if(occupied.rowCount)throw conflict('MOVEMENT_LOCATION_OCCUPIED','El potrero o corral ya tiene un grupo.');
  }
  const current=await client.query<Animal>(
    `SELECT a.id,a.name,aga.group_id,ala.location_id
     FROM animal a JOIN animal_group_assignment aga ON aga.animal_id=a.id AND aga.ended_at IS NULL
     LEFT JOIN animal_location_assignment ala ON ala.animal_id=a.id AND ala.ended_at IS NULL
     WHERE a.property_id=$1 AND a.account_id=$2 AND a.record_status='CURRENT'
       AND a.availability_status_code='ACTIVE' AND aga.group_id=$3
     ORDER BY a.id FOR UPDATE OF a,aga`,[context.propertyId,accountId,source.id]);
  const selectedIds=input.selectionMode==='GRUPO'
    ? current.rows.map((animal)=>animal.id) : input.animalIds;
  if((!selectedIds.length && input.kind!=='UBICACION') || selectedIds.length>500
    || new Set(selectedIds).size!==selectedIds.length)
    throw invalidRequest('MOVEMENT_SELECTION_INVALID','Selecciona entre uno y 500 animales del grupo de origen.');
  const selected=new Set(selectedIds);
  const animals=current.rows.filter((animal)=>selected.has(animal.id));
  if(animals.length!==selected.size)throw conflict('MOVEMENT_SELECTION_CHANGED',
    'Un animal ya no está activo o cambió de grupo o propiedad. Actualiza la selección.');
  if(animals.some((animal)=>animal.location_id!==source.location_id))
    throw conflict('MOVEMENT_LOCATION_CHANGED',
      'La ubicación de un animal no coincide con la del grupo. Revisa su historial.');
  if(cross){
    const blocked=await client.query(`SELECT 1 FROM animal a WHERE a.id=ANY($1::uuid[]) AND (
      EXISTS(SELECT 1 FROM reproduction_pregnancy p WHERE p.cow_id=a.id AND p.status='CONFIRMED')
      OR EXISTS(SELECT 1 FROM milk_lactation l WHERE l.cow_id=a.id AND l.ended_on IS NULL)
      OR EXISTS(SELECT 1 FROM milk_animal_state ms WHERE ms.cow_id=a.id AND ms.enabled)
      OR EXISTS(SELECT 1 FROM health_condition hc WHERE hc.animal_id=a.id
        AND hc.status<>'RESUELTA')) LIMIT 1`,
    [selectedIds]);
    if(blocked.rowCount)throw conflict('MOVEMENT_OPEN_PROCESS',
      'Finaliza la preñez, lactancia o condición sanitaria y desactiva el ordeño antes del traslado.');
  }
  return {source,destination,destinationLocationId,animals,sourceLocationId:source.location_id,accountId};
}

function translate(error:unknown):never{
  const database=error as {code?:string};
  if(database.code==='23505' || database.code==='23514' || database.code==='23503')
    throw conflict('MOVEMENT_CONFLICT','El grupo, animal o potrero cambió. Actualiza la pantalla antes de continuar.');
  throw error;
}

async function saveDetails(client:PoolClient,id:string,state:Resolved){
  await client.query(`DELETE FROM livestock_movement_animal WHERE movement_id=$1`,[id]);
  for(const animal of state.animals)await client.query(`INSERT INTO livestock_movement_animal
    (movement_id,animal_id,source_group_id,source_location_id,destination_group_id,destination_location_id)
    VALUES($1,$2,$3,$4,$5,$6)`,[id,animal.id,state.source.id,state.sourceLocationId,
      state.destination.id,state.destinationLocationId]);
}
export async function createMovement(auth:AuthState,context:PropertyContext,input:MovementInput,
  metadata:RequestMetadata){
  try{return await inTransaction(async(client)=>{
    const {account_id:accountId,today}=await access(client,auth,context,'MOVEMENT_MANAGE');
    if(input.movementOn>today)throw invalidRequest('MOVEMENT_FUTURE_DATE','La fecha no puede ser futura.');
    const state=await resolve(client,auth,context,input,accountId);
    const created=(await client.query<{id:string}>(`INSERT INTO livestock_movement
      (account_id,source_property_id,destination_property_id,kind,selection_mode,
       source_group_id,destination_group_id,source_location_id,destination_location_id,
       movement_on,reason,notes,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING id`,
      [accountId,context.propertyId,input.destinationPropertyId,input.kind,input.selectionMode,
        state.source.id,state.destination.id,state.sourceLocationId,state.destinationLocationId,
        input.movementOn,input.reason,input.notes??null,auth.userId])).rows[0]!;
    await saveDetails(client,created.id,state);
    const after=await read(client,created.id);
    await audit(client,auth,context,metadata,'MOVEMENT_DRAFT_CREATED',created.id,null,after);
    return after;
  });}catch(error){return translate(error);}
}
async function lockDraft(client:PoolClient,context:PropertyContext,id:string){
  const row=(await client.query<Draft>(`SELECT id,account_id,source_property_id,destination_property_id,
    kind,selection_mode,source_group_id,destination_group_id,source_location_id,
    destination_location_id,movement_on::text,reason,notes,status,version::text
    FROM livestock_movement WHERE id=$1 AND source_property_id=$2 FOR UPDATE`,
    [id,context.propertyId])).rows[0];
  if(!row)throw new ApiError(404,'MOVEMENT_NOT_FOUND','El movimiento no pertenece a esta propiedad.');
  if(row.status!=='BORRADOR')throw conflict('MOVEMENT_ALREADY_FINAL','El movimiento ya fue aplicado o cancelado.');
  return row;
}
export async function updateMovement(auth:AuthState,context:PropertyContext,id:string,
  input:MovementInput,metadata:RequestMetadata){
  try{return await inTransaction(async(client)=>{
    const {account_id:accountId,today}=await access(client,auth,context,'MOVEMENT_MANAGE');
    const draft=await lockDraft(client,context,id);
    if(input.expectedVersion && input.expectedVersion!==Number(draft.version))
      throw conflict('MOVEMENT_VERSION_CONFLICT','El borrador cambió. Actualiza la pantalla.');
    if(input.movementOn>today)throw invalidRequest('MOVEMENT_FUTURE_DATE','La fecha no puede ser futura.');
    const before=await read(client,id);
    const state=await resolve(client,auth,context,input,accountId);
    await client.query(`UPDATE livestock_movement SET destination_property_id=$2,kind=$3,
      selection_mode=$4,source_group_id=$5,destination_group_id=$6,source_location_id=$7,
      destination_location_id=$8,movement_on=$9,reason=$10,notes=$11,updated_by=$12 WHERE id=$1`,
      [id,input.destinationPropertyId,input.kind,input.selectionMode,state.source.id,state.destination.id,
        state.sourceLocationId,state.destinationLocationId,input.movementOn,input.reason,
        input.notes??null,auth.userId]);
    await saveDetails(client,id,state);
    const after=await read(client,id);
    await audit(client,auth,context,metadata,'MOVEMENT_DRAFT_UPDATED',id,before,after);
    return after;
  });}catch(error){return translate(error);}
}

export async function applyMovement(auth:AuthState,context:PropertyContext,id:string,
  metadata:RequestMetadata){
  try{return await inTransaction(async(client)=>{
    const {account_id:accountId,today}=await access(client,auth,context,'MOVEMENT_MANAGE');
    const draft=await lockDraft(client,context,id);
    if(draft.account_id!==accountId)throw forbidden('MOVEMENT_DENIED','El movimiento pertenece a otra cuenta.');
    if(draft.movement_on>today)throw invalidRequest('MOVEMENT_FUTURE_DATE','La fecha no puede ser futura.');
    const before=await read(client,id);
    const stored=(await client.query<{animal_id:string}>(
      `SELECT animal_id FROM livestock_movement_animal WHERE movement_id=$1 ORDER BY animal_id`,[id]))
      .rows.map((row)=>row.animal_id);
    const input:MovementInput={kind:draft.kind,selectionMode:draft.selection_mode,
      sourceGroupId:draft.source_group_id,destinationPropertyId:draft.destination_property_id,
      destinationGroupId:draft.destination_group_id,destinationLocationId:draft.destination_location_id,
      movementOn:draft.movement_on,reason:draft.reason,notes:draft.notes,animalIds:stored};
    const state=await resolve(client,auth,context,input,accountId);
    if(draft.source_location_id!==state.sourceLocationId
      || draft.destination_location_id!==state.destinationLocationId
      || stored.length!==state.animals.length
      || state.animals.some((animal)=>!stored.includes(animal.id)))
      throw conflict('MOVEMENT_DRAFT_STALE',
        'El grupo, sus integrantes o la ubicación cambiaron. Actualiza el borrador antes de aplicarlo.');

    const instant=new Date();
    const reason=`Movimiento ${draft.kind.toLowerCase()}: ${draft.reason}`.slice(0,120);
    if(draft.kind==='UBICACION'){
      await client.query(`UPDATE group_location_assignment SET ended_at=$2,end_reason=$3
        WHERE group_id=$1 AND ended_at IS NULL`,[state.source.id,instant,reason]);
      await client.query(`INSERT INTO group_location_assignment
        (property_id,group_id,location_id,started_at,start_reason,movement_batch_id,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [context.propertyId,state.source.id,state.destinationLocationId,instant,reason,id,auth.userId]);
      await client.query(`UPDATE livestock_group SET updated_by=$2 WHERE id=$1`,[state.source.id,auth.userId]);
    }
    if(context.propertyId!==draft.destination_property_id)
      await client.query("SELECT set_config('sgb.allow_animal_managed_write','on',true)");

    for(const animal of state.animals){
      if(animal.location_id)await client.query(`UPDATE animal_location_assignment
        SET ended_at=$2,end_reason=$3 WHERE animal_id=$1 AND ended_at IS NULL`,[animal.id,instant,reason]);
      if(draft.kind!=='UBICACION')await client.query(`UPDATE animal_group_assignment
        SET ended_at=$2,end_reason=$3 WHERE animal_id=$1 AND ended_at IS NULL`,[animal.id,instant,reason]);
      if(context.propertyId!==draft.destination_property_id)
        await client.query(`UPDATE animal SET property_id=$2,updated_by=$3 WHERE id=$1`,
          [animal.id,draft.destination_property_id,auth.userId]);
      else await client.query(`UPDATE animal SET updated_by=$2 WHERE id=$1`,[animal.id,auth.userId]);
      if(draft.kind!=='UBICACION')await client.query(`INSERT INTO animal_group_assignment
        (property_id,animal_id,group_id,started_at,start_reason,movement_batch_id,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [draft.destination_property_id,animal.id,state.destination.id,instant,reason,id,auth.userId]);
      if(state.destinationLocationId)await client.query(`INSERT INTO animal_location_assignment
        (property_id,animal_id,location_id,started_at,start_reason,movement_batch_id,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [draft.destination_property_id,animal.id,state.destinationLocationId,instant,reason,id,auth.userId]);
    }
    await client.query(`UPDATE livestock_movement SET status='COMPLETADO',applied_at=$2,
      updated_by=$3 WHERE id=$1 AND status='BORRADOR'`,[id,instant,auth.userId]);
    const after=await read(client,id);
    await audit(client,auth,context,metadata,'MOVEMENT_APPLIED',id,before,after);
    return after;
  });}catch(error){return translate(error);}
}

export async function cancelMovement(auth:AuthState,context:PropertyContext,id:string,
  metadata:RequestMetadata){
  try{return await inTransaction(async(client)=>{
    await access(client,auth,context,'MOVEMENT_CANCEL');
    await lockDraft(client,context,id);
    const before=await read(client,id);
    await client.query(`UPDATE livestock_movement SET status='CANCELADO',cancelled_at=now(),
      updated_by=$2 WHERE id=$1`,[id,auth.userId]);
    const after=await read(client,id);
    await audit(client,auth,context,metadata,'MOVEMENT_CANCELLED',id,before,after);
    return after;
  });}catch(error){return translate(error);}
}
