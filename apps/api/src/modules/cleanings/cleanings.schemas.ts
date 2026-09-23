import {z} from 'zod';
export const idSchema=z.object({id:z.uuid()});
export const productSchema=z.object({name:z.string().trim().min(2).max(160),
  category:z.string().trim().max(120).nullable().optional()});
export const cleaningSchema=z.object({
  locationId:z.uuid(),startedOn:z.iso.date(),finishedOn:z.iso.date().nullable().optional(),
  activities:z.array(z.enum(['FUMIGACION','TALA_SELECTIVA','DESBROCE','OTRA'])).min(1).max(4),
  applicationUnit:z.enum(['TANQUES','BOMBADAS']).default('TANQUES'),
  applicationCount:z.number().finite().positive().max(100000).nullable().optional(),
  tankCapacityLiters:z.number().finite().positive().max(100000).nullable().optional(),
  areaType:z.enum(['TOTAL','PARCIAL']),partialPercent:z.number().finite().positive().lt(100)
    .nullable().optional(),notes:z.string().trim().max(5000).nullable().optional(),
  products:z.array(z.object({productId:z.uuid(),unitCode:z.enum(['MILLIGRAM','GRAM',
    'KILOGRAM','MILLILITER','LITER','UNIT','DOSE']),quantityPerApplication:z.number()
    .finite().positive().max(1000000),notes:z.string().trim().max(300).nullable().optional()})).max(30),
  operators:z.array(z.object({name:z.string().trim().min(2).max(160),
    function:z.string().trim().max(100).nullable().optional(),
    notes:z.string().trim().max(300).nullable().optional()})).max(30),
  expectedVersion:z.number().int().positive().optional(),
}).superRefine((value,ctx)=>{
  if(value.finishedOn && value.finishedOn<value.startedOn)
    ctx.addIssue({code:'custom',message:'La finalización no puede ser anterior al inicio.'});
  if((value.areaType==='PARCIAL')!==Boolean(value.partialPercent))
    ctx.addIssue({code:'custom',message:'Indica el porcentaje del potrero para un área parcial.'});
  if(value.products.length&&!value.applicationCount)
    ctx.addIssue({code:'custom',message:'Indica tanques o bombadas para calcular el consumo.'});
  if(new Set(value.products.map((item)=>item.productId)).size!==value.products.length)
    ctx.addIssue({code:'custom',message:'No repitas un producto.'});
  if(new Set(value.operators.map((item)=>item.name.toLowerCase())).size!==value.operators.length)
    ctx.addIssue({code:'custom',message:'No repitas un operador.'});
});
export type CleaningInput=z.infer<typeof cleaningSchema>;
export type ProductInput=z.infer<typeof productSchema>;
