import { z } from 'zod';

const token = z.string().trim().min(40).max(200);
const payFrequency = z.enum(['HOURLY', 'DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'OTHER']);

export const invitationPreviewParamsSchema = z.object({ token });
export const acceptInvitationSchema = z.object({ token });

export const createInvitationSchema = z.object({
  email: z.email().max(254).transform((value) => value.trim().toLowerCase()),
  roleIds: z.array(z.uuid()).min(1).max(4).transform((values) => [...new Set(values)]),
  jobTitle: z.string().trim().min(2).max(140).optional(),
  payAmount: z.number().min(0).max(999999999999.99).nullable().optional(),
  payFrequency: payFrequency.nullable().optional(),
  employmentNotes: z.string().trim().max(2000).optional(),
}).superRefine((value, context) => {
  if (value.payAmount !== null && value.payAmount !== undefined && !value.jobTitle) {
    context.addIssue({ code: 'custom', path: ['jobTitle'], message: 'Indica el cargo para registrar un pago.' });
  }
  if (value.payAmount !== null && value.payAmount !== undefined && !value.payFrequency) {
    context.addIssue({ code: 'custom', path: ['payFrequency'], message: 'Indica la frecuencia del pago.' });
  }
  if (value.payFrequency && (value.payAmount === null || value.payAmount === undefined)) {
    context.addIssue({ code: 'custom', path: ['payAmount'], message: 'Indica el valor del pago.' });
  }
});

export const invitationParamsSchema = z.object({ invitationId: z.uuid() });
export const membershipParamsSchema = z.object({ membershipId: z.uuid() });
export const membershipStatusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'ENDED']) });

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
