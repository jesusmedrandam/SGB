import { z } from 'zod';

const password = z.string()
  .min(12, 'La contraseña debe tener al menos 12 caracteres.')
  .max(128, 'La contraseña es demasiado larga.')
  .regex(/[A-Za-zÁÉÍÓÚáéíóúÑñ]/, 'Incluye al menos una letra.')
  .regex(/[0-9]/, 'Incluye al menos un número.');

export const registerSchema = z.object({
  email: z.email().max(254).transform((value) => value.trim().toLowerCase()),
  password,
  displayName: z.string().trim().min(2).max(160),
  propertyName: z.string().trim().min(2).max(160).optional(),
  invitationToken: z.string().trim().min(40).max(200).optional(),
}).superRefine((value, context) => {
  if (!value.invitationToken && !value.propertyName) {
    context.addIssue({
      code: 'custom', path: ['propertyName'],
      message: 'Indica el nombre de tu primera propiedad.',
    });
  }
});

export const verifyEmailSchema = z.object({
  token: z.string().min(40).max(200),
});

export const resendVerificationSchema = z.object({
  email: z.email().max(254).transform((value) => value.trim().toLowerCase()),
});

export const loginSchema = z.object({
  email: z.email().max(254).transform((value) => value.trim().toLowerCase()),
  password: z.string().min(1).max(128),
  deviceId: z.string().trim().min(8).max(180),
  deviceName: z.string().trim().min(1).max(180).optional(),
});

export const contextSchema = z.object({
  propertyId: z.uuid(),
  roleId: z.uuid(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
