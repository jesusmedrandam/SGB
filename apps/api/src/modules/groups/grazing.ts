import {z} from 'zod';
import type {PoolClient} from 'pg';
import {invalidRequest} from '../../core/errors.js';

export const pastureConditionsSchema=z.array(z.object({locationId:z.uuid(),
 entryHeightCm:z.number().finite().min(0).max(500).nullable().optional(),
 exitState:z.enum(['REMAINS','DEPLETED']).nullable().optional()})).max(40)
 .refine(rows=>new Set(rows.map(row=>row.locationId)).size===rows.length,'No repitas un potrero.');
export type PastureConditions=z.infer<typeof pastureConditionsSchema>;

export async function validatePastureChange(client:PoolClient,propertyId:string,animalIds:string[],
 destinationIds:string[],conditions:PastureConditions=[],destinationPropertyId=propertyId){
 const source=(await client.query<{location_id:string}>(`SELECT DISTINCT location_id FROM animal_grazing_stay
  WHERE property_id=$1 AND animal_id=ANY($2::uuid[]) AND ended_at IS NULL`,[propertyId,animalIds])).rows.map(row=>row.location_id);
 const places=[...new Set([...source,...destinationIds,...conditions.map(row=>row.locationId)])].sort();
 const locations=await client.query<{id:string;kind:string;name:string}>(`SELECT id,kind,name FROM physical_location
  WHERE property_id=ANY($1::uuid[]) AND id=ANY($2::uuid[]) AND active ORDER BY id FOR UPDATE`,[[propertyId,destinationPropertyId],places]);
 if(locations.rows.length!==places.length)throw invalidRequest('GRAZING_LOCATION_INVALID','Selecciona ubicaciones activas de esta propiedad.');
 for(const condition of conditions)if(![...source,...destinationIds].includes(condition.locationId)||locations.rows.find(row=>row.id===condition.locationId)?.kind!=='PASTURE'
  ||condition.entryHeightCm!=null&&!destinationIds.includes(condition.locationId)||condition.exitState&&!source.includes(condition.locationId))
   throw invalidRequest('GRAZING_CONDITION_INVALID','El estado de salida y la altura de entrada deben corresponder a los potreros del movimiento.');
 for(const id of source){
  const place=locations.rows.find(row=>row.id===id)!;
  if(place.kind!=='PASTURE'||destinationIds.includes(id))continue;
  const remaining=await client.query(`SELECT 1 FROM animal_grazing_stay WHERE property_id=$1 AND location_id=$2
   AND ended_at IS NULL AND NOT(animal_id=ANY($3::uuid[])) LIMIT 1`,[propertyId,id,animalIds]);
  if(!remaining.rowCount&&!conditions.find(row=>row.locationId===id)?.exitState)
   throw invalidRequest('PASTURE_EXIT_STATE_REQUIRED',`Indica si queda pasto aprovechable en ${place.name} al terminar la ocupación.`);
 }
 return source;
}

export async function savePastureConditions(client:PoolClient,batchId:string,on:string,userId:string,conditions:PastureConditions=[]){
 for(const row of conditions){if(row.entryHeightCm==null&&!row.exitState)continue;
  await client.query(`INSERT INTO pasture_observation(property_id,location_id,movement_batch_id,observed_on,entry_height_cm,exit_state,created_by)
   VALUES((SELECT property_id FROM physical_location WHERE id=$1),$1,$2,$3,$4,$5,$6)`,[row.locationId,batchId,on,row.entryHeightCm??null,row.exitState??null,userId]);
 }
}
