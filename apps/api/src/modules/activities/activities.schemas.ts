import {z} from 'zod';
export const idSchema=z.object({id:z.uuid()});
export const activitySchema=z.object({kind:z.enum(['HERRAJE','DESCORNE','OTRA']),
  title:z.string().trim().min(2).max(180),occurredOn:z.iso.date(),
  description:z.string().trim().max(5000).nullable().optional(),
  brandId:z.uuid().nullable().optional(),
  animalIds:z.array(z.uuid()).min(1).max(500),
  expectedVersion:z.number().int().positive().optional(),
}).superRefine((input,ctx)=>{
  if((input.kind==='HERRAJE')!==Boolean(input.brandId))
    ctx.addIssue({code:'custom',message:'Selecciona una marquilla solo al registrar un herraje.'});
  if(new Set(input.animalIds).size!==input.animalIds.length)
    ctx.addIssue({code:'custom',message:'No repitas animales.'});
});
export type ActivityInput=z.infer<typeof activitySchema>;
