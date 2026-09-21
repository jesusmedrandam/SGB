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

export const speciesCodes = ['BOVINE'] as const;
export type SpeciesCode = typeof speciesCodes[number];

export const speciesCapabilities = [
  'ANIMAL_REGISTRATION',
  'GROUP_ASSIGNMENT',
  'LOCATION_ASSIGNMENT',
  'MOVEMENT',
  'WEIGHING',
  'HEALTH_TREATMENT',
  'MILK_PRODUCTION',
  'REPRODUCTION',
  'BRANDING',
  'DEHORNING',
] as const;
export type SpeciesCapability = typeof speciesCapabilities[number];

export const measurementUnitCodes = [
  'MILLIGRAM',
  'GRAM',
  'KILOGRAM',
  'POUND',
  'MILLILITER',
  'LITER',
  'SQUARE_METER',
  'HECTARE',
  'CENTIMETER',
  'METER',
  'UNIT',
  'DOSE',
] as const;
export type MeasurementUnitCode = typeof measurementUnitCodes[number];

export const unitContextCodes = [
  'MEDICINE_DOSE',
  'MEDICINE_RATE_NUMERATOR',
  'AGROCHEMICAL_AMOUNT',
  'ANIMAL_WEIGHT',
  'MILK_VOLUME',
  'LAND_AREA',
  'PRODUCT_QUANTITY',
  'FEED_AMOUNT',
  'LENGTH',
] as const;
export type UnitContextCode = typeof unitContextCodes[number];

export const allowedUnitsByContext = {
  MEDICINE_DOSE: ['MILLIGRAM', 'GRAM', 'MILLILITER', 'LITER', 'UNIT', 'DOSE'],
  MEDICINE_RATE_NUMERATOR: ['MILLIGRAM', 'GRAM', 'MILLILITER', 'UNIT'],
  AGROCHEMICAL_AMOUNT: ['GRAM', 'KILOGRAM', 'MILLILITER', 'LITER'],
  ANIMAL_WEIGHT: ['GRAM', 'KILOGRAM', 'POUND'],
  MILK_VOLUME: ['MILLILITER', 'LITER'],
  LAND_AREA: ['SQUARE_METER', 'HECTARE'],
  PRODUCT_QUANTITY: ['GRAM', 'KILOGRAM', 'MILLILITER', 'LITER', 'UNIT'],
  FEED_AMOUNT: ['GRAM', 'KILOGRAM'],
  LENGTH: ['CENTIMETER', 'METER'],
} as const satisfies Record<UnitContextCode, readonly MeasurementUnitCode[]>;

export function isUnitAllowed(
  context: UnitContextCode,
  unit: MeasurementUnitCode,
): boolean {
  return (allowedUnitsByContext[context] as readonly MeasurementUnitCode[]).includes(unit);
}
