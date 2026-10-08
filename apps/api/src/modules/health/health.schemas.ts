import {z} from 'zod';
export const idSchema=z.object({id:z.uuid()});
export const conditionSchema=z.object({animalId:z.uuid(),kind:z.string().trim().min(2).max(160),
  detectedOn:z.iso.date(),description:z.string().trim().min(2).max(2000),
  expectedVersion:z.number().int().positive().optional()});
export const resolutionSchema=z.object({resolvedOn:z.iso.date(),
  expectedVersion:z.number().int().positive().optional()});
const routeSchema=z.union([z.enum(['ORAL','INTRAMUSCULAR','SUBCUTANEA','INTRAVENOSA','TOPICA','OTRA']),z.uuid()]);
const classificationRangeSchema=z.object({
  classificationCode:z.enum(['VACA','VACONA','TERNERA','TORO','TORETE','TERNERO']),
  min:z.number().finite().min(0.000001).max(1000000),
  max:z.number().finite().min(0.000001).max(1000000),
}).refine(input=>input.max>=input.min,{message:'El máximo debe ser mayor o igual al mínimo.'});
export const medicineSchema=z.object({
  name:z.string().trim().min(2).max(160),
  kind:z.enum(['VACUNA','DESPARASITACION','ENFERMEDAD','OTRO']),
  activeIngredient:z.string().trim().max(2000).nullable().optional(),
  treatmentCatalogItemId:z.uuid().nullable().optional(),
  defaultUnitCode:z.enum(['MILLIGRAM','GRAM','MILLILITER','LITER','UNIT','DOSE']),
  suggestedDose:z.string().trim().max(300).nullable().optional(),
  indications:z.string().trim().max(2000).nullable().optional(),
  withdrawalMilkDays:z.number().int().min(0).max(10000).default(0),
  withdrawalMeatDays:z.number().int().min(0).max(10000).default(0),
  administrationRoutes:z.array(routeSchema).min(1).max(30).optional(),
  doseAmount:z.number().finite().min(0.000001).max(1000000).nullable().optional(),
  doseWeight:z.number().finite().min(0.000001).max(1000000).nullable().optional(),
  doseWeightUnitCode:z.enum(['KILOGRAM','POUND']).nullable().optional(),
  doseClassificationRanges:z.array(classificationRangeSchema).max(6).optional(),
}).superRefine((input,ctx)=>{
  const ranges=input.doseClassificationRanges??[];
  if(new Set(ranges.map(range=>range.classificationCode)).size!==ranges.length)
    ctx.addIssue({code:'custom',message:'Las clasificaciones de la dosis no pueden repetirse.'});
  if(ranges.length&&(input.doseAmount!=null||input.doseWeight!=null||input.doseWeightUnitCode!=null))
    ctx.addIssue({code:'custom',message:'Elige una referencia por clasificación o por cantidad/peso.'});
  if((input.doseWeight!=null)!==(input.doseWeightUnitCode!=null)||input.doseWeight!=null&&input.doseAmount==null)
    ctx.addIssue({code:'custom',message:'La dosis por peso necesita cantidad, peso base y unidad de peso.'});
  if(input.administrationRoutes&&new Set(input.administrationRoutes).size!==input.administrationRoutes.length)
    ctx.addIssue({code:'custom',message:'Las vías de administración no pueden repetirse.'});
});
export const campaignSchema=z.object({
  medicineId:z.uuid(),
  administrationRoute:routeSchema,
  selectionMode:z.enum(['TODOS','GRUPO','MANUAL']),
  groupId:z.uuid().nullable().optional(),
  appliedOn:z.iso.date(), responsible:z.string().trim().max(200).nullable().optional(),
  notes:z.string().trim().max(5000).nullable().optional(),
  animals:z.array(z.object({animalId:z.uuid(),selected:z.boolean().default(true),
    dose:z.number().finite().positive().max(1000000),
    unitCode:z.enum(['MILLIGRAM','GRAM','MILLILITER','LITER','UNIT','DOSE']),
    conditionId:z.uuid().nullable().optional(),
    notes:z.string().trim().max(300).nullable().optional()})).min(1).max(500),
  expectedVersion:z.number().int().positive().optional(),
}).superRefine((input,ctx)=>{
  if((input.selectionMode==='GRUPO')!==Boolean(input.groupId))
    ctx.addIssue({code:'custom',message:'Selecciona un grupo solo para jornadas por grupo.'});
  if(!input.animals.some((animal)=>animal.selected))
    ctx.addIssue({code:'custom',message:'Selecciona al menos un animal.'});
  if(new Set(input.animals.map((animal)=>animal.animalId)).size!==input.animals.length)
    ctx.addIssue({code:'custom',message:'La selección repite animales.'});
});
export type MedicineInput=z.infer<typeof medicineSchema>;
export type CampaignInput=z.infer<typeof campaignSchema>;
export type ConditionInput=z.infer<typeof conditionSchema>;

export const medicineUpdateSchema=z.strictObject({medicine:medicineSchema,active:z.boolean(),expectedVersion:z.number().int().positive()});
