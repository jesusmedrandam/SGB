import {z} from 'zod';

export const externalTransferSchema=z.object({
  destinationPropertyId:z.uuid().optional(),receiveCode:z.uuid().optional(),animalIds:z.array(z.uuid()).min(1).max(50)
    .refine(ids=>new Set(ids).size===ids.length,'Selecciona animales distintos.'),
  movementOn:z.iso.date(),reason:z.string().trim().min(2).max(300),
  notes:z.string().trim().max(5000).nullable().optional(),
}).refine(value=>Boolean(value.destinationPropertyId)!==Boolean(value.receiveCode),'Selecciona una propiedad de destino.');
export const externalVisibilitySchema=z.object({visibility:z.enum(['HIDDEN','COLLABORATORS','PUBLIC']),
  durationDays:z.number().int().min(1).max(365).nullable().optional()})
  .refine(value=>!value.durationDays||value.visibility==='PUBLIC','El plazo solo corresponde a la visibilidad para todos.');
export const externalDecisionSchema=z.object({expectedVersion:z.number().int().positive(),
  groupId:z.uuid().optional(),reason:z.string().trim().min(2).max(500).optional(),
  earTags:z.array(z.object({animalId:z.uuid(),earTagCode:z.string().trim().min(1).max(80).nullable()})).max(50)
    .refine(items=>new Set(items.map(item=>item.animalId)).size===items.length).optional()});
export type ExternalTransferInput=z.infer<typeof externalTransferSchema>;
export type ExternalVisibilityInput=z.infer<typeof externalVisibilitySchema>;
export type ExternalDecisionInput=z.infer<typeof externalDecisionSchema>;
