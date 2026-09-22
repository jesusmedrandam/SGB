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

export const accountQuotaCodes = [
  'MEDIA_STORAGE_BYTES',
  'MANAGED_ANIMALS',
  'COLLABORATOR_USERS',
] as const;
export type AccountQuotaCode = typeof accountQuotaCodes[number];

export const defaultAccountQuotas = {
  MEDIA_STORAGE_BYTES: 2 * 1024 * 1024 * 1024,
  MANAGED_ANIMALS: 100,
  COLLABORATOR_USERS: 10,
} as const satisfies Record<AccountQuotaCode, number>;

export const animalAvailabilityStatuses = [
  'ACTIVE',
  'MISSING',
  'INACTIVE',
  'EXITED',
  'DEAD',
] as const;
export type AnimalAvailabilityStatus = typeof animalAvailabilityStatuses[number];

export const animalExitReasons = [
  'SALE',
  'DONATION',
  'SLAUGHTER',
  'EXTERNAL_TRANSFER',
  'OTHER',
] as const;
export type AnimalExitReason = typeof animalExitReasons[number];

export const saleAnimalEffects = [
  'KEEP_CURRENT_PROPERTY',
  'EXIT_CURRENT_PROPERTY',
  'TRANSFER_TO_PROPERTY',
] as const;
export type SaleAnimalEffect = typeof saleAnimalEffects[number];

export const quotaCountingAnimalStatuses = [
  'ACTIVE',
  'MISSING',
  'INACTIVE',
] as const satisfies readonly AnimalAvailabilityStatus[];

export const animalStatusTransitions = [
  ['ACTIVE', 'MISSING', 'REPORT_MISSING'],
  ['MISSING', 'ACTIVE', 'MARK_FOUND'],
  ['ACTIVE', 'INACTIVE', 'DEACTIVATE'],
  ['INACTIVE', 'ACTIVE', 'REACTIVATE'],
  ['ACTIVE', 'DEAD', 'RECORD_DEATH'],
  ['MISSING', 'DEAD', 'RECORD_DEATH'],
  ['INACTIVE', 'DEAD', 'RECORD_DEATH'],
  ['ACTIVE', 'EXITED', 'RECORD_EXIT'],
  ['MISSING', 'EXITED', 'RECORD_EXIT'],
  ['INACTIVE', 'EXITED', 'RECORD_EXIT'],
  ['EXITED', 'ACTIVE', 'REVERSE_EXIT'],
] as const satisfies readonly (readonly [AnimalAvailabilityStatus, AnimalAvailabilityStatus, string])[];

export const mediaPolicyVersion = 1 as const;

export const imageUploadPolicy = {
  maxInputBytes: 25 * 1024 * 1024,
  maxStoredBytes: 5 * 1024 * 1024,
  maxLongEdgePixels: 2560,
  thumbnailLongEdgePixels: 512,
  preferredMimeType: 'image/webp',
  fallbackMimeType: 'image/jpeg',
  initialQuality: 82,
  acceptedInputMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'],
} as const;

export const videoUploadPolicy = {
  maxInputBytes: 500 * 1024 * 1024,
  maxStoredBytes: 120 * 1024 * 1024,
  maxDurationSeconds: 5 * 60,
  maxHeightPixels: 720,
  mimeType: 'video/mp4',
  videoCodec: 'h264',
  audioCodec: 'aac',
} as const;

export const mediaTrashRetentionDays = 30 as const;
export const mediaQuotaReservationMinutes = 30 as const;
