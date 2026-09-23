import { z } from 'zod';

const notes = z.string().trim().max(2000).nullable().optional();
const source = z.enum(['MANUAL','SENSOR']).default('MANUAL');
const shift = z.enum(['MORNING','AFTERNOON','NIGHT','SINGLE']);
export const idSchema = z.object({ id: z.uuid() });
export const lactationSchema = z.object({
  birthId: z.uuid(), endedOn: z.iso.date().nullable().optional(),
  inMilking: z.boolean().default(true), notes,
}).refine((value) => !(value.endedOn && value.inMilking),
  'Una lactancia cerrada no puede estar en ordeño.');
export const finishLactationSchema = z.object({ endedOn: z.iso.date() });
export const milkingSchema = z.object({ inMilking: z.boolean() });
export const milkSchema = z.object({
  lactationId: z.uuid(), producedOn: z.iso.date(), shift,
  liters: z.number().finite().min(0).max(10000), source,
  externalReference: z.string().trim().max(160).nullable().optional(), notes,
});
export const tankSchema = z.object({
  producedOn: z.iso.date(), shift, liters: z.number().finite().min(0).max(100000), source,
  externalReference: z.string().trim().max(160).nullable().optional(), notes,
});
export type LactationInput = z.infer<typeof lactationSchema>;
export type MilkInput = z.infer<typeof milkSchema>;
export type TankInput = z.infer<typeof tankSchema>;
