import {z} from 'zod';

export const externalTransferSchema=z.object({
  receiveCode:z.uuid(),animalIds:z.array(z.uuid()).min(1).max(50)
    .refine(ids=>new Set(ids).size===ids.length,'Selecciona animales distintos.'),
  movementOn:z.iso.date(),reason:z.string().trim().min(2).max(300),
  notes:z.string().trim().max(5000).nullable().optional(),
});
export const externalDecisionSchema=z.object({expectedVersion:z.number().int().positive(),
  groupId:z.uuid().optional(),reason:z.string().trim().min(2).max(500).optional(),
  earTags:z.array(z.object({animalId:z.uuid(),earTagCode:z.string().trim().min(1).max(80).nullable()})).max(50)
    .refine(items=>new Set(items.map(item=>item.animalId)).size===items.length).optional()});
export type ExternalTransferInput=z.infer<typeof externalTransferSchema>;
export type ExternalDecisionInput=z.infer<typeof externalDecisionSchema>;
