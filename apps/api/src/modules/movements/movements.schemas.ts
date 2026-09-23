import { z } from 'zod';

export const idSchema=z.object({id:z.uuid()});
export const movementSchema=z.object({
  kind:z.enum(['UBICACION','GRUPO','PROPIEDAD','COMBINADO']),
  selectionMode:z.enum(['GRUPO','MANUAL']),
  sourceGroupId:z.uuid(),destinationPropertyId:z.uuid(),
  destinationGroupId:z.uuid(),destinationLocationId:z.uuid().nullable().optional(),
  movementOn:z.iso.date(),reason:z.string().trim().min(2).max(300),
  notes:z.string().trim().max(5000).nullable().optional(),
  animalIds:z.array(z.uuid()).max(500).default([]),
  expectedVersion:z.number().int().positive().optional(),
}).superRefine((value,ctx)=>{
  if(value.kind==='UBICACION' && (value.selectionMode!=='GRUPO'
    || value.sourceGroupId!==value.destinationGroupId || !value.destinationLocationId))
    ctx.addIssue({code:'custom',message:'Una rotación mueve el grupo completo a otra ubicación.'});
  if(value.selectionMode==='MANUAL' && !value.animalIds.length)
    ctx.addIssue({code:'custom',message:'Selecciona al menos un animal.'});
  if(value.animalIds.length!==new Set(value.animalIds).size)
    ctx.addIssue({code:'custom',message:'No repitas animales en la selección.'});
});
export type MovementInput=z.infer<typeof movementSchema>;
