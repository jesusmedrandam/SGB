import { z } from 'zod';

const note = z.string().trim().max(500).nullable().optional();
export const idSchema = z.object({ id: z.uuid() });
export const createHeatSchema = z.object({
  cowId: z.uuid(), bullId: z.uuid().nullable().optional(),
  startsOn: z.iso.date(), endsOn: z.iso.date().nullable().optional(),
  isFalse: z.boolean().default(false), notes: note,
}).refine((value) => !value.endsOn || value.endsOn >= value.startsOn,
  'La fecha final del celo no puede preceder a la inicial.');

export const createPregnancySchema = z.object({
  cowId: z.uuid(), heatId: z.uuid().nullable().optional(),
  fatherId: z.uuid().nullable().optional(), externalFather: z.string().trim().min(1).max(240).nullable().optional(),
  conceptionMethod: z.enum(['NATURAL','INSEMINATION','EMBRYO_TRANSFER','UNKNOWN']),
  confirmationMethod: z.enum(['PALPATION','ULTRASOUND','BLOOD_TEST','OBSERVATION','OTHER']),
  confirmedOn: z.iso.date(), gestationDays: z.number().int().min(0).max(400).nullable().optional(),
  notes: note,
}).refine((value) => !(value.fatherId && value.externalFather),
  'Selecciona un padre registrado o escribe uno externo.');

export const createBirthSchema = z.object({
  pregnancyId: z.uuid(), occurredOn: z.iso.date(),
  calves: z.array(z.object({
    name: z.string().trim().min(1).max(160),
    sex: z.enum(['FEMALE','MALE']), earTagCode: z.string().trim().min(1).max(80).optional(),
  })).max(8),
  stillbornCount: z.number().int().min(0).max(8),
  notes: z.string().trim().max(5000).nullable().optional(),
}).refine((value) => value.calves.length + value.stillbornCount > 0
  && value.calves.length + value.stillbornCount <= 8,
  'El parto debe registrar entre una y ocho crías.');

export const createLossSchema = z.object({
  pregnancyId: z.uuid(), occurredOn: z.iso.date(),
  notes: z.string().trim().min(1).max(5000),
});

export const reproductionSettingSchema = z.object({
  daysAfterBirthHeat: z.number().int().min(0).max(365),
  daysAfterBirthPregnancy: z.number().int().min(0).max(365),
  daysAfterLossHeat: z.number().int().min(0).max(365),
  daysAfterLossPregnancy: z.number().int().min(0).max(365),
  minimumCowMonths: z.number().int().min(0).max(120),
  minimumBullMonths: z.number().int().min(0).max(120),
  allowSecondHeat: z.boolean(),
  allowFalseHeatInPregnancy: z.boolean(),
  useLastValidHeat: z.boolean(),
});

export type HeatInput = z.infer<typeof createHeatSchema>;
export type PregnancyInput = z.infer<typeof createPregnancySchema>;
export type BirthInput = z.infer<typeof createBirthSchema>;
export type LossInput = z.infer<typeof createLossSchema>;
export type ReproductionSettingInput = z.infer<typeof reproductionSettingSchema>;
