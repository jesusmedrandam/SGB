import {z} from 'zod';
export const activityMethods={HERRAJE:['CALOR','FRIO','OTRO'],DESCORNE:['DESBOTONE_TERMICO','DESBOTONE_QUIMICO','MECANICO','OTRO'],CASTRACION:['QUIRURGICA','ANILLO','PINZA','OTRO'],OTRA:[]};
export const procedureSchema=z.object({method:z.string().trim().min(1).max(60),productName:z.string().trim().max(180).nullable().optional(),
 operatorName:z.string().trim().max(180).nullable().optional(),site:z.string().trim().max(180).nullable().optional(),
 painControl:z.string().trim().max(500).nullable().optional(),followUpOn:z.iso.date().nullable().optional(),otherMethod:z.string().trim().max(180).nullable().optional()}).strict();
export const idSchema=z.object({id:z.uuid()});
export const activitySchema=z.object({kind:z.enum(['HERRAJE','DESCORNE','CASTRACION','OTRA']),
  title:z.string().trim().min(2).max(180),occurredOn:z.iso.date(),
  description:z.string().trim().max(5000).nullable().optional(),
  procedure:procedureSchema.nullable().optional(),
  brandId:z.uuid().nullable().optional(),
  animalIds:z.array(z.uuid()).min(1).max(500),
  expectedVersion:z.number().int().positive().optional(),
}).superRefine((input,ctx)=>{
  if(input.procedure){
    if(!(activityMethods[input.kind] as string[]).includes(input.procedure.method))ctx.addIssue({code:'custom',message:'El método no corresponde a la actividad.'});
    if(input.procedure.method==='DESBOTONE_QUIMICO'&&!input.procedure.productName?.trim())ctx.addIssue({code:'custom',message:'Indica el producto utilizado en el desbotone químico.'});
    if(input.procedure.method==='OTRO'&&!input.procedure.otherMethod?.trim())ctx.addIssue({code:'custom',message:'Describe el método utilizado.'});
    if(input.procedure.followUpOn&&input.procedure.followUpOn<input.occurredOn)ctx.addIssue({code:'custom',message:'La revisión no puede ser anterior a la actividad.'});
  }
  if((input.kind==='HERRAJE')!==Boolean(input.brandId))
    ctx.addIssue({code:'custom',message:'Selecciona una marquilla solo al registrar un herraje.'});
  if(new Set(input.animalIds).size!==input.animalIds.length)
    ctx.addIssue({code:'custom',message:'No repitas animales.'});
});
export type ActivityInput=z.infer<typeof activitySchema>;
