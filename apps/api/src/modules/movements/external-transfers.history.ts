import type {PoolClient} from 'pg';
import type {PropertyContext} from '../auth/auth.types.js';
import {readAnimal} from '../animals/animals.service.js';
import {visibleMediaTypes,listMedia} from '../media/media.service.js';
import {forbidden} from '../../core/errors.js';

export type PreviousAnimalEvent={id:string;module:string;title:string;date:string;notes:string|null;lines:string[];sourcePropertyName:string};
export type AnimalTransferSnapshot={profile:Awaited<ReturnType<typeof readAnimal>>;history:PreviousAnimalEvent[];
  media:Awaited<ReturnType<typeof listMedia>>;identityId:string;hasGivenBirth:boolean;hasConfirmedOffspring:boolean;
  lastBirthOn:string|null;lastLossOn:string|null;processes:Record<string,any>;copies?:Record<string,string>};

export async function captureAnimal(client:PoolClient,context:PropertyContext,id:string):Promise<AnimalTransferSnapshot>{
  const profile=await readAnimal(client,context,id);
  const original=(await client.query('SELECT snapshot FROM animal_received_history WHERE animal_id=$1',[id])).rows[0]?.snapshot as AnimalTransferSnapshot|undefined;
  const history=new Map<string,PreviousAnimalEvent>((original?.history??[]).map(row=>[row.id,row]));
  const mediaTargets:Array<{type:string;id:string}>=[{type:'ANIMAL',id}];
  const add=(module:string,type:string,row:Record<string,any>,title:string,date:string,notes:string|null,lines:(string|null|undefined)[])=>{
    mediaTargets.push({type,id:row.id});
    const key=original?.copies?.[`${type}:${row.id}`]??`${type}:${row.id}`;
    history.set(key,{id:key,module,title,date:date.slice(0,10),notes,lines:lines.filter((value):value is string=>typeof value==='string'&&value.length>0),
      sourcePropertyName:history.get(key)?.sourcePropertyName??context.propertyName});
  };
  const heats=(await client.query(`SELECT h.*,h.starts_on::text,h.ends_on::text,b.name AS bull_name
    FROM reproduction_heat h LEFT JOIN animal b ON b.id=h.bull_id WHERE h.property_id=$1 AND (h.cow_id=$2 OR h.bull_id=$2) ORDER BY h.id`,[context.propertyId,id])).rows;
  for(const row of heats)add('REPRODUCTION','REPRODUCTION_HEAT',row,row.bull_id===id?'Participación como reproductor':row.is_false?'Celo falso':'Celo',row.starts_on,row.cow_id===id?row.notes:null,
    [row.ends_on?`Fin: ${row.ends_on}`:'Sin finalizar',row.bull_name?`Reproductor: ${row.bull_name}`:null,row.cancelled_at?'Registro anulado':null]);
  const services=(await client.query(`SELECT s.*,s.occurred_on::text,f.name AS father_name,d.name AS donor_name
    FROM reproduction_service s LEFT JOIN animal f ON f.id=s.father_id LEFT JOIN animal d ON d.id=s.donor_id
    WHERE s.property_id=$1 AND (s.cow_id=$2 OR s.father_id=$2 OR s.donor_id=$2) ORDER BY s.id`,[context.propertyId,id])).rows;
  for(const row of services)add('REPRODUCTION','REPRODUCTION_SERVICE',row,row.kind==='INSEMINATION'?'Inseminación artificial':'Implantación de embrión',row.occurred_on,row.cow_id===id?row.notes:null,
    [row.father_name||row.external_father?`Reproductor: ${row.father_name??row.external_father}`:null,row.donor_name||row.external_donor?`Donante: ${row.donor_name??row.external_donor}`:null,
      row.material_code?`Material: ${row.material_code}`:null,row.technician?`Responsable: ${row.technician}`:null,row.supplier?`Proveedor: ${row.supplier}`:null,
      row.quality,row.cancelled_at?'Registro anulado':null]);
  const pregnancies=(await client.query(`SELECT p.*,p.confirmed_on::text,p.conception_on::text,p.expected_birth_on::text,f.name AS father_name
    FROM reproduction_pregnancy p LEFT JOIN animal f ON f.id=p.father_id WHERE p.property_id=$1 AND (p.cow_id=$2 OR p.father_id=$2) ORDER BY p.id`,[context.propertyId,id])).rows;
  const statuses:Record<string,string>={CONFIRMED:'Confirmada',BORN:'Parto registrado',LOST:'Aborto o pérdida',CANCELLED:'Anulada'};
  for(const row of pregnancies)add('REPRODUCTION','REPRODUCTION_PREGNANCY',row,row.father_id===id?'Participación como padre':'Preñez',row.confirmed_on,row.cow_id===id?row.notes:null,
    [statuses[row.status],row.expected_birth_on?`Parto estimado: ${row.expected_birth_on}`:null,row.gestation_days!=null?`${row.gestation_days} días de gestación`:null,
      row.father_name||row.external_father?`Padre: ${row.father_name??row.external_father}`:null]);
  const births=(await client.query(`SELECT b.*,b.occurred_on::text FROM reproduction_birth b
    LEFT JOIN reproduction_pregnancy p ON p.id=b.pregnancy_id WHERE b.property_id=$1 AND
    (b.mother_id=$2 OR p.father_id=$2 OR EXISTS(SELECT 1 FROM reproduction_birth_calf c WHERE c.birth_id=b.id AND c.animal_id=$2)) ORDER BY b.id`,[context.propertyId,id])).rows;
  for(const row of births)add('REPRODUCTION','REPRODUCTION_BIRTH',row,row.mother_id===id?'Parto':'Nacimiento o descendencia',row.occurred_on,row.notes,
    [`${row.live_count} crías vivas`,`${row.stillborn_count} nacidas sin vida`,({NORMAL:'Parto normal',ASSISTED:'Parto asistido',CAESAREAN:'Cesárea',UNKNOWN:'Tipo no registrado'} as Record<string,string>)[row.kind]]);
  const losses=(await client.query('SELECT *,occurred_on::text FROM reproduction_loss WHERE property_id=$1 AND cow_id=$2 ORDER BY id',[context.propertyId,id])).rows;
  for(const row of losses)add('REPRODUCTION','REPRODUCTION_LOSS',row,'Aborto o pérdida',row.occurred_on,row.notes,[]);
  const conditions=(await client.query('SELECT *,detected_on::text,resolved_on::text FROM health_condition WHERE property_id=$1 AND animal_id=$2 ORDER BY id',[context.propertyId,id])).rows;
  for(const row of conditions)add('HEALTH','HEALTH_CONDITION',row,row.kind??'Condición de salud',row.detected_on,row.description,
    [({POR_RESOLVER:'Por resolver',EN_TRATAMIENTO:'En tratamiento',RESUELTA:'Resuelta'} as Record<string,string>)[row.status],row.resolved_on?`Resuelta: ${row.resolved_on}`:null]);
  const treatments=(await client.query(`SELECT c.id,c.applied_on::text,c.notes,c.administration_route,c.responsible,
    COALESCE(c.medicine_snapshot->>'name',m.name) AS medicine_name,a.dose::text AS dose_value,a.unit_code
    FROM health_campaign c JOIN health_campaign_animal a ON a.campaign_id=c.id JOIN health_medicine m ON m.id=c.medicine_id
    WHERE c.property_id=$1 AND a.animal_id=$2 AND a.selected AND c.status='COMPLETADO' ORDER BY c.id`,[context.propertyId,id])).rows;
  for(const row of treatments)add('HEALTH','HEALTH_CAMPAIGN',row,'Tratamiento',row.applied_on,row.notes,
    [row.medicine_name,row.dose_value?`Dosis: ${row.dose_value} ${row.unit_code}`:null,row.responsible?`Responsable: ${row.responsible}`:null]);
  const weights=(await client.query('SELECT *,weighed_on::text FROM animal_weighing WHERE property_id=$1 AND animal_id=$2 AND voided_at IS NULL ORDER BY id',[context.propertyId,id])).rows;
  for(const row of weights)add('WEIGHING','ANIMAL_WEIGHING',row,'Pesaje',row.weighed_on,row.notes,[`${row.weight} ${row.unit_code==='POUND'?'lb':'kg'}`,row.method]);
  const milk=(await client.query('SELECT *,produced_on::text FROM milk_production WHERE property_id=$1 AND cow_id=$2 ORDER BY id',[context.propertyId,id])).rows;
  for(const row of milk)add('PRODUCTION','MILK_PRODUCTION',row,'Producción de leche',row.produced_on,row.notes,
    [`${row.liters} litros`,({MORNING:'Mañana',AFTERNOON:'Tarde',NIGHT:'Noche',SINGLE:'Turno único'} as Record<string,string>)[row.shift]]);
  const lactations=(await client.query('SELECT *,started_on::text,ended_on::text FROM milk_lactation WHERE property_id=$1 AND cow_id=$2 ORDER BY id',[context.propertyId,id])).rows;
  for(const row of lactations)add('PRODUCTION','MILK_LACTATION',row,'Lactancia',row.started_on,row.notes,[row.ended_on?`Fin: ${row.ended_on}`:'En curso']);
  const movements=(await client.query(`SELECT m.id,m.movement_on::text,m.reason,m.notes,sp.name AS source_name,dp.name AS destination_name,
    sg.name AS source_group,dg.name AS destination_group FROM livestock_movement m JOIN livestock_movement_animal a ON a.movement_id=m.id
    JOIN property sp ON sp.id=m.source_property_id JOIN property dp ON dp.id=m.destination_property_id
    JOIN livestock_group sg ON sg.id=m.source_group_id JOIN livestock_group dg ON dg.id=m.destination_group_id
    WHERE a.animal_id=$1 AND (m.source_property_id=$2 OR m.destination_property_id=$2) AND m.status='COMPLETADO' ORDER BY m.id`,[id,context.propertyId])).rows;
  for(const row of movements)add('MOVEMENTS','LIVESTOCK_MOVEMENT',row,'Movimiento',row.movement_on,row.notes,
    [row.reason,`${row.source_name} → ${row.destination_name}`,`${row.source_group} → ${row.destination_group}`]);
  const events=(await client.query(`SELECT e.*,(e.occurred_at AT TIME ZONE p.timezone)::date::text AS occurred_at
    FROM animal_status_event e JOIN property p ON p.id=e.property_id WHERE e.property_id=$1 AND e.animal_id=$2 ORDER BY e.id`,[context.propertyId,id])).rows;
  for(const row of events)add('CORE','ANIMAL_STATUS',row,({REPORT_MISSING:'Desaparición',MARK_FOUND:'Recuperación',RECORD_DEATH:'Fallecimiento',RECORD_EXIT:'Salida',EXTERNAL_TRANSFER:'Traslado externo'} as Record<string,string>)[row.action_code]??'Cambio de estado',row.occurred_at,row.reason,[]);
  const ownership=(await client.query(`SELECT o.id,o.valid_from::text,o.valid_until::text,o.ownership_percent,p.display_name
    FROM animal_ownership o JOIN property_party p ON p.id=o.party_id WHERE o.animal_id=$1 ORDER BY o.id`,[id])).rows;
  for(const row of ownership)add('CORE','ANIMAL_OWNERSHIP',row,'Propietarios',row.valid_from,null,
    [`${row.display_name}: ${row.ownership_percent}%`,row.valid_until?`Hasta: ${row.valid_until}`:null]);
  const activities=(await client.query(`SELECT a.id,a.title,a.occurred_on::text,a.description,a.kind FROM livestock_activity a
    JOIN livestock_activity_animal x ON x.activity_id=a.id WHERE a.property_id=$1 AND x.animal_id=$2 AND a.status='COMPLETADA' ORDER BY a.id`,[context.propertyId,id])).rows;
  for(const row of activities)add('TASKS','LIVESTOCK_ACTIVITY',row,row.title,row.occurred_on,row.description,[]);
  const identity=(await client.query('SELECT identity_id FROM animal WHERE id=$1',[id])).rows[0].identity_id as string;
  for(const row of history.values())if(!context.permissions.has(modulePermissions[row.module]??'ANIMAL_VIEW'))
    throw forbidden('EXTERNAL_HISTORY_PERMISSION_REQUIRED','Tu rol necesita permiso para consultar todo el historial que se compartirá.');
  const last=(dates:Array<string|null|undefined>)=>dates.filter((date):date is string=>Boolean(date)).sort().at(-1)??null;
  const boundary=last([original?.lastBirthOn,original?.lastLossOn,...births.filter(row=>row.mother_id===id).map(row=>row.occurred_on),...losses.map(row=>row.occurred_on)])??'';
  const attachments=(await client.query(`SELECT m.id,m.storage_object_id,m.entity_type,m.entity_id FROM media_attachment m WHERE m.property_id=$1 AND m.deleted_at IS NULL
    AND EXISTS(SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS x(type text,id uuid) WHERE x.type=m.entity_type AND x.id=m.entity_id) ORDER BY m.id`,
    [context.propertyId,JSON.stringify(mediaTargets)])).rows;
  const media:AnimalTransferSnapshot['media']=[];
  if(attachments.length&&!context.permissions.has('MEDIA_VIEW'))
    throw forbidden('EXTERNAL_MEDIA_PERMISSION_REQUIRED','Necesitas permiso para consultar las fotos que se compartirán.');
  // ponytail: snapshots are bounded to 50 animals per request; use a background export if farms need larger batches.
  for(let page=1;attachments.length&&page<=Math.ceil(attachments.length/500);page++)
    media.push(...await listMedia({...context,enabledModules:new Set([...context.enabledModules,'MULTIMEDIA','REPRODUCTION','HEALTH','PRODUCTION','MOVEMENTS','TASKS','WEIGHING'])},undefined,undefined,undefined,page,attachments.map(row=>row.id)));
  for(const photo of media){
    const ref=attachments.find(row=>row.storage_object_id===photo.storage_object_id&&row.entity_type===photo.recordType);
    const event=ref?history.get(original?.copies?.[`${ref.entity_type}:${ref.entity_id}`]??`${ref.entity_type}:${ref.entity_id}`):null;
    photo.recordDetails=event?{title:event.title,date:event.date,notes:event.notes,lines:event.lines}:null;
    if(!event){photo.recordType=null;}
  }
  const consumedHeat=new Set(pregnancies.filter(row=>row.status!=='CANCELLED'&&row.status!=='CONFIRMED').map(row=>row.heat_id));
  const consumedService=new Set(pregnancies.filter(row=>row.status!=='CANCELLED'&&row.status!=='CONFIRMED').map(row=>row.service_id));
  const milking=(await client.query('SELECT enabled FROM milk_animal_state WHERE cow_id=$1',[id])).rows[0]?.enabled??false;
  return {profile,history:[...history.values()].sort((a,b)=>a.id.localeCompare(b.id)),media,identityId:identity,copies:original?.copies??{},
    hasGivenBirth:original?.hasGivenBirth===true||profile.classification?.code==='VACA',
    hasConfirmedOffspring:original?.hasConfirmedOffspring===true||profile.classification?.code==='TORO',
    lastBirthOn:last([original?.lastBirthOn,...births.filter(row=>row.mother_id===id).map(row=>row.occurred_on)]),
    lastLossOn:last([original?.lastLossOn,...losses.map(row=>row.occurred_on)]),
    processes:{heats:heats.filter(row=>row.cow_id===id&&!row.cancelled_at&&!consumedHeat.has(row.id)&&row.starts_on>=boundary),
      services:services.filter(row=>row.cow_id===id&&!row.cancelled_at&&!consumedService.has(row.id)&&row.occurred_on>=boundary),
      pregnancy:pregnancies.find(row=>row.cow_id===id&&row.status==='CONFIRMED')??null,
      conditions:conditions.filter(row=>row.status!=='RESUELTA'),lactation:lactations.find(row=>!row.ended_on)??null,milking}};
}

const modulePermissions:Record<string,string>={CORE:'ANIMAL_VIEW',REPRODUCTION:'REPRODUCTION_VIEW',HEALTH:'HEALTH_VIEW',
  WEIGHING:'WEIGHING_VIEW',PRODUCTION:'PRODUCTION_VIEW',MOVEMENTS:'MOVEMENT_VIEW',TASKS:'ACTIVITY_VIEW'};
export function visibleAnimalSnapshot(snapshot:AnimalTransferSnapshot,context:PropertyContext){
  const types=visibleMediaTypes(context);const can=(module:string)=>context.enabledModules.has(module)&&context.permissions.has(modulePermissions[module]!);
  return {profile:context.permissions.has('ANIMAL_VIEW')?snapshot.profile:null,
    history:snapshot.history.filter(row=>context.permissions.has(modulePermissions[row.module]??'ANIMAL_VIEW')
      &&(row.module==='CORE'||context.enabledModules.has(row.module))),
    media:context.permissions.has('MEDIA_VIEW')&&context.enabledModules.has('MULTIMEDIA')?snapshot.media.filter(photo=>types.includes(photo.entity_type)).map(photo=>types.includes(photo.recordType??'')?photo:{...photo,recordType:null,recordDetails:null}):[],
    processes:{pregnancy:can('REPRODUCTION')&&Boolean(snapshot.processes.pregnancy),conditions:can('HEALTH')?snapshot.processes.conditions.length:0,
      milking:can('PRODUCTION')&&Boolean(snapshot.processes.milking)}};
}
