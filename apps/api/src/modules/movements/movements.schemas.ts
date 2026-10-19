import { z } from 'zod';
import {pastureConditionsSchema} from '../groups/grazing.js';

export const idSchema=z.object({id:z.uuid()});
export const movementSchema=z.object({
  kind:z.enum(['UBICACION','GRUPO','PROPIEDAD','COMBINADO','SEPARACION']),
  selectionMode:z.enum(['GRUPO','MANUAL']),
  sourceGroupId:z.uuid().nullable(),destinationPropertyId:z.uuid(),
  destinationGroupId:z.uuid().nullable(),destinationLocationId:z.uuid().nullable().optional(),
  additionalDestinationLocationIds:z.array(z.uuid()).max(19).optional(),
  countsForOccupancy:z.boolean().optional(),pastureConditions:pastureConditionsSchema.optional(),
  movementOn:z.iso.date(),reason:z.string().trim().min(2).max(300),
  notes:z.string().trim().max(5000).nullable().optional(),
  animalIds:z.array(z.uuid()).max(500).default([]),
  expectedVersion:z.number().int().positive().optional(),
}).superRefine((value,ctx)=>{
  if(value.kind==='SEPARACION'?(!value.sourceGroupId||value.destinationGroupId!==null):!value.destinationGroupId)
    ctx.addIssue({code:'custom',message:'La separación deja al animal sin grupo; los demás movimientos requieren grupo de destino.'});
  if(!value.sourceGroupId&&(value.kind!=='GRUPO'||value.selectionMode!=='MANUAL'))
    ctx.addIssue({code:'custom',message:'Selecciona manualmente los animales sin grupo para reincorporarlos.'});
  const extra=value.additionalDestinationLocationIds??[];
  if(extra.length&&(value.kind!=='UBICACION'||new Set([value.destinationLocationId,...extra]).size!==extra.length+1))
    ctx.addIssue({code:'custom',message:'Solo se combinan potreros distintos al rotar el grupo completo.'});
  if(value.kind!=='SEPARACION'&&value.countsForOccupancy===false)
    ctx.addIssue({code:'custom',message:'Solo los animales separados pueden excluirse de la ocupación.'});
  if(value.kind==='UBICACION' && (value.selectionMode!=='GRUPO'
    || value.sourceGroupId!==value.destinationGroupId || !value.destinationLocationId))
    ctx.addIssue({code:'custom',message:'Una rotación mueve el grupo completo a otra ubicación.'});
  if(value.selectionMode==='MANUAL' && !value.animalIds.length)
    ctx.addIssue({code:'custom',message:'Selecciona al menos un animal.'});
  if(value.animalIds.length!==new Set(value.animalIds).size)
    ctx.addIssue({code:'custom',message:'No repitas animales en la selección.'});
});
export type MovementInput=z.infer<typeof movementSchema>;
