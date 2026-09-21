export const propertyModules = [
  'PRODUCTION',
  'WEIGHING',
  'PROPERTY_FINANCE',
  'OFFLINE',
  'REPRODUCTION',
  'MOVEMENTS',
  'HEALTH',
  'PASTURE_CLEANING',
  'SALES_PURCHASES',
  'TASKS',
  'EVENTS',
  'MULTIMEDIA',
  'PUBLIC_PROFILES',
] as const;

export const userModules = ['PERSONAL_FINANCE'] as const;

export const configurableModules = [...propertyModules, ...userModules] as const;

export type PropertyModule = typeof propertyModules[number];
export type UserModule = typeof userModules[number];
export type ConfigurableModule = typeof configurableModules[number];

export const platformRoles = ['SUPERADMIN'] as const;
export type PlatformRole = typeof platformRoles[number];

export const membershipStatuses = ['INVITED', 'ACTIVE', 'SUSPENDED', 'ENDED'] as const;
export type MembershipStatus = typeof membershipStatuses[number];
