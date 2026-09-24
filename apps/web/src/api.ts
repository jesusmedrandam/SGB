const configuredApiUrl = import.meta.env.VITE_API_URL?.trim();

export const API_URL = (configuredApiUrl || 'http://localhost:3000').replace(/\/$/, '');

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  isSuperadmin: boolean;
}

export interface ActiveContext {
  propertyId: string;
  roleId: string;
}

export interface SessionPayload {
  accessToken: string;
  accessExpiresAt: string;
  user: SessionUser;
  activeContext: ActiveContext | null;
}

export interface PropertyAccess {
  id: string;
  name: string;
  timezone: string;
  isOwner: boolean;
  roles: Array<{ id: string; code: string; name: string; permissions: string[] }>;
  enabledModules: string[];
  enabledSpecies: string[];
}

export interface SessionOverview {
  user: SessionUser;
  activeContext: ActiveContext | null;
  properties: PropertyAccess[];
  enabledUserModules: string[];
  ownedAccount: null | { id: string; name: string; status: string; maxProperties: number; usedProperties: number };
}

export interface PropertySettings {
  account: { id: string; name: string; maxProperties: number; usedProperties: number };
  canCreate: boolean;
  canManageModules: boolean;
  modules: Array<{
    code: string; name: string; isCore: boolean; accountEnabled: boolean;
    propertyEnabled: boolean; enabled: boolean;
  }>;
}

export type EditableCatalogCode = 'BREEDS' | 'COLORS' | 'GRASS_TYPES' |
  'HEALTH_CONDITION_TYPES' | 'AGROCHEMICAL_CATEGORIES' | 'MEDIA_TAGS' |
  'MOVEMENT_REASONS' | 'TREATMENT_TYPES';
export interface CatalogItem {
  id: string;
  catalogCode: EditableCatalogCode;
  name: string;
  speciesCode: string | null;
  systemDefined: boolean;
  active: boolean;
}
export interface CatalogReference {
  species: Array<{ code: string; name: string; rulesetCode: string; rulesetVersion: number }>;
  units: Array<{ contextCode: string; code: string; name: string; symbol: string; isDefault: boolean }>;
}

export interface Animal {
  id: string;
  name: string;
  description: string | null;
  earTagCode: string | null;
  sex: 'FEMALE' | 'MALE';
  speciesCode: 'BOVINE';
  birthDate: string | null;
  entryDate: string;
  initialWeight: number | null;
  initialWeightUnitCode: string | null;
  availabilityStatusCode: string;
  profilePhotoUrl?:string|null;
  primaryOwnerName?:string|null;
  classification: {code:string;name:string}|null;
  version: number;
  breed?: { id: string; name: string } | null;
  breeds: Array<{ id: string; name: string }>;
  owners: Array<{ id: string; name: string; percent: number; isPrimary: boolean }>;
  colors?: Array<{ id: string; name: string }>;
  brands: Array<{ id: string; name: string }>;
  mother?: { animalId: string | null; name: string } | null;
  father?: { animalId: string | null; name: string } | null;
  group?: { id: string; name: string } | null;
  location?: { id: string; name: string; kind: 'PASTURE' | 'CORRAL' } | null;
}

export interface LivestockBrand { id: string; name: string; active: boolean; owner_ids?: string[] }
export interface LivestockOwner { id: string; name: string; kind: string; active: boolean }

export interface AnimalList { items: Animal[]; page: number; hasMore: boolean; total:number }
export interface AnimalSummary {
  total:number;classifications:Array<{code:string;label:string;count:number}>;
  groups:Array<{name:string;count:number}>;sex:Array<{sex:'FEMALE'|'MALE';count:number}>;
}
export interface AnimalClassificationPolicy {
  femaleAdultMonths:number;maleAdultMonths:number;
  names:{VACA:string;VACONA:string;TERNERA:string;TORO:string;TORETE:string;TERNERO:string};
}

export interface LivestockGroup {
  id: string; name: string; description: string | null; active: boolean;
  version: number; animalCount: number;
  location: { id: string; name: string; kind: 'PASTURE' | 'CORRAL' } | null;
}
export interface PhysicalLocation {
  id: string; name: string; kind: 'PASTURE' | 'CORRAL'; description: string | null;
  active: boolean; group: { id: string; name: string } | null;
  version: number; area: number | null; areaUnitCode: string | null;
  pastureUse: string | null; capacityEstimate: number | null; waterAvailable: boolean | null;
  lastRestDate: string | null; floorMaterial: string | null; covered: boolean | null;
  grasses: Array<{ name: string; catalogItemId?:string|null;percent: number | null; area: number | null;
    areaUnitCode: string | null; sowingDate: string | null; notes: string | null }>;
}

export interface RegistrationResult {
  userId: string;
  accountId: string | null;
  propertyId: string | null;
  invitationId: string | null;
  verificationRequired: true;
  verificationExpiresAt: string;
  verificationDelivery: 'SENT' | 'UNAVAILABLE' | 'FAILED';
  verificationToken?: string;
}

export interface InvitationPreview {
  id: string;
  email: string;
  expiresAt: string;
  property: { id: string; name: string };
  accountName: string;
  invitedBy: string;
  existingUser: boolean;
  roles: Array<{ id: string; code: string; name: string }>;
  employment: null | {
    jobTitle: string;
    payAmount: number | null;
    currency: string;
    frequency: string | null;
    notes: string | null;
  };
}

export interface PropertyTeam {
  canManage: boolean;
  members: Array<{
    id: string;
    userId: string;
    displayName: string;
    email: string;
    status: 'ACTIVE' | 'SUSPENDED';
    jobTitle: string | null;
    joinedAt: string | null;
    isOwner: boolean;
    isSelf: boolean;
    roles: Array<{ id: string; code: string; name: string }>;
    payment: null | { amount: number; currency: string; frequency: string | null };
  }>;
  invitations: Array<{
    id: string;
    email: string;
    expiresAt: string;
    jobTitle: string | null;
    roles: Array<{ id: string; code: string; name: string }>;
  }>;
  assignableRoles: Array<{ id: string; code: string; name: string; description: string | null }>;
  quota: { used: number; limit: number | null };
}

export interface AdministrativeAccountSummary {
  id: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
  maxProperties: number;
  createdAt: string;
  owner: { id: string; name: string; email: string };
  propertyCount: number;
  collaboratorCount: number;
}

export interface PlatformOverview {
  totals: { users: number; accounts: number; properties: number; managedAnimals: number };
  accounts: AdministrativeAccountSummary[];
}

export interface AccountDetails {
  account: AdministrativeAccountSummary;
  properties: Array<{
    id: string;
    name: string;
    status: string;
    timezone: string;
    createdAt: string;
    memberCount: number;
    animalCount: number;
  }>;
  quotas: Array<{
    code: string;
    name: string;
    description: string;
    unit: 'BYTES' | 'COUNT';
    limitValue: number | null;
    usedValue: number;
    warningPercent: number;
  }>;
  modules: Array<{
    code: string;
    name: string;
    description: string | null;
    isCore: boolean;
    enabled: boolean;
  }>;
}

interface ApiEnvelope<T> {
  ok: boolean;
  data: T;
}

interface ApiErrorEnvelope {
  ok: false;
  error?: { code?: string; message?: string };
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiRequestError(
      'No fue posible conectar con el servidor. Revisa tu conexión e inténtalo nuevamente.',
      0,
      'NETWORK_ERROR',
    );
  }

  const text = await response.text();
  const body = text ? JSON.parse(text) as ApiEnvelope<T> | ApiErrorEnvelope : null;
  if (!response.ok) {
    const failure = body as ApiErrorEnvelope | null;
    throw new ApiRequestError(
      failure?.error?.message || 'No fue posible completar la solicitud.',
      response.status,
      failure?.error?.code || 'REQUEST_FAILED',
    );
  }

  if (response.status === 204) return undefined as T;
  return (body as ApiEnvelope<T>).data;
}

export function login(email: string, password: string, deviceId: string) {
  return request<SessionPayload>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password, deviceId, deviceName: 'Navegador web' }),
  });
}

export function register(input: {
  displayName: string;
  propertyName?: string;
  email: string;
  password: string;
  invitationToken?: string;
}) {
  return request<RegistrationResult>('/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getInvitationPreview(token: string) {
  return request<InvitationPreview>(`/invitations/preview/${encodeURIComponent(token)}`);
}

export function acceptInvitation(accessToken: string, token: string) {
  return request<{ propertyId: string; propertyName: string; membershipId: string; roleId: string }>(
    '/invitations/accept', {
      method: 'POST', headers: { authorization: `Bearer ${accessToken}` }, body: JSON.stringify({ token }),
    },
  );
}

export function verifyEmail(token: string) {
  return request<{ verified: true }>('/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

export function resendVerification(email: string) {
  return request<{ accepted: true; verificationToken?: string }>('/auth/resend-verification', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export function requestPasswordReset(email:string){
  return request<{accepted:true}>('/auth/forgot-password',{
    method:'POST',body:JSON.stringify({email}),
  });
}
export function resetPassword(token:string,password:string){
  return request<{reset:true}>('/auth/reset-password',{
    method:'POST',body:JSON.stringify({token,password}),
  });
}

export function refreshSession() {
  return request<SessionPayload>('/auth/refresh', { method: 'POST' });
}

export function getSessionOverview(accessToken: string) {
  return request<SessionOverview>('/auth/me', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

export function changeContext(accessToken: string, propertyId: string, roleId: string) {
  return request<{ propertyId: string; roleId: string }>('/auth/context', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ propertyId, roleId }),
  });
}

export async function logout(accessToken: string | null) {
  await request<never>('/auth/logout', {
    method: 'POST',
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
  });
}

const bearer = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });

export function getPropertyTeam(accessToken: string) {
  return request<PropertyTeam>('/property-team', { headers: bearer(accessToken) });
}

export function getPropertySettings(accessToken: string) {
  return request<PropertySettings>('/property-settings', { headers: bearer(accessToken) });
}

export function getCatalogReference(accessToken: string) {
  return request<CatalogReference>('/catalogs/reference', { headers: bearer(accessToken) });
}

export type AnimalFilters = Partial<Record<'sex'|'status'|'groupId'|'locationId'|'ownerId'|
  'breedId'|'colorId'|'brandId'|'birthFrom'|'birthTo',string>>;
export function getAnimals(accessToken: string, page = 1, search = '',classification='',
  filters:AnimalFilters={}) {
  const query = new URLSearchParams({ page: String(page), search });
  if(classification)query.set('classification',classification);
  for(const [key,value] of Object.entries(filters))if(value)query.set(key,value);
  return request<AnimalList>(`/animals?${query}`, { headers: bearer(accessToken) });
}
export function getAnimalSummary(accessToken:string){return request<AnimalSummary>('/animals/summary',{
  headers:bearer(accessToken)});}
export function getAnimalClassificationPolicy(accessToken:string){
  return request<AnimalClassificationPolicy>('/animals/classification',{headers:bearer(accessToken)});
}
export function updateAnimalClassificationPolicy(accessToken:string,input:AnimalClassificationPolicy){
  return request<AnimalClassificationPolicy>('/animals/classification',{
    method:'PUT',headers:bearer(accessToken),body:JSON.stringify(input)});
}

export function getAnimal(accessToken: string, id: string) {
  return request<Animal>(`/animals/${encodeURIComponent(id)}`, { headers: bearer(accessToken) });
}

export function createAnimal(accessToken: string, input: {
  name: string; sex: Animal['sex']; speciesCode: 'BOVINE';
  groupId: string; mother?:ParentSelection;father?:ParentSelection;
  description?: string | null;
  earTagCode?: string; birthDate?: string; entryDate?: string;
  initialWeight?: number; initialWeightUnitCode?: string;
  breedId?: string | null; breedIds?: string[]; colorIds?: string[];
  brandIds?: string[];
  owners?: Array<{ partyId: string; percent: number; isPrimary: boolean }>;
}) {
  return request<Animal>('/animals', {
    method: 'POST', headers: bearer(accessToken), body: JSON.stringify(input),
  });
}

export function updateAnimalDescription(accessToken: string, id: string, input: {
  description: string | null; expectedVersion: number;
}) {
  return request<Animal>(`/animals/${encodeURIComponent(id)}/description`, {
    method: 'PATCH', headers: bearer(accessToken), body: JSON.stringify(input),
  });
}

export function listGroups(accessToken: string) {
  return request<LivestockGroup[]>('/groups', { headers: bearer(accessToken) });
}

export function createGroup(accessToken: string, input: {
  name: string; description: string | null;
}) {
  return request<LivestockGroup>('/groups', {
    method: 'POST', headers: bearer(accessToken), body: JSON.stringify(input),
  });
}

export function updateGroup(accessToken: string, id: string, input: {
  name: string; description: string | null; expectedVersion: number;
}) {
  return request<LivestockGroup>(`/groups/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: bearer(accessToken), body: JSON.stringify(input),
  });
}

export function setGroupState(accessToken: string, id: string, input: {
  active: boolean; expectedVersion: number;
}) {
  return request<LivestockGroup>(`/groups/${encodeURIComponent(id)}/state`, {
    method: 'PATCH', headers: bearer(accessToken), body: JSON.stringify(input),
  });
}

export function listLocations(accessToken: string) {
  return request<PhysicalLocation[]>('/locations', { headers: bearer(accessToken) });
}

export interface LocationInput {
  kind: 'PASTURE' | 'CORRAL'; name: string; description: string | null;
  area?: number | null; areaUnitCode?: string | null; pastureUse?: string | null;
  capacityEstimate?: number | null; waterAvailable?: boolean | null;
  lastRestDate?: string | null; floorMaterial?: string | null; covered?: boolean | null;
  grasses?: Array<{ name: string; catalogItemId?:string|null;percent?: number | null; area?: number | null;
    areaUnitCode?: string | null; sowingDate?: string | null; notes?: string | null }>;
}
export function createLocation(accessToken: string, input: LocationInput) {
  return request<PhysicalLocation>('/locations', {
    method: 'POST', headers: bearer(accessToken), body: JSON.stringify(input),
  });
}

export function updateLocation(accessToken: string, id: string, input: LocationInput & { expectedVersion: number }) {
  return request<PhysicalLocation>(`/locations/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: bearer(accessToken), body: JSON.stringify(input),
  });
}

export function updateAnimalCatalogs(accessToken: string, id: string, input: {
  breedIds: string[]; colorIds: string[]; expectedVersion: number;
}) {
  return request<Animal>(`/animals/${encodeURIComponent(id)}/catalogs`, {
    method: 'PATCH', headers: bearer(accessToken), body: JSON.stringify(input),
  });
}

export function listOwners(accessToken: string) {
  return request<LivestockOwner[]>('/owners', { headers: bearer(accessToken) });
}
export function listAccountUsers(accessToken: string) {
  return request<Array<{ id: string; name: string }>>('/owners/users', { headers: bearer(accessToken) });
}
export function createOwner(accessToken: string, input:
  { kind: 'USER'; userId: string } | { kind: 'EXTERNAL_PERSON' | 'ORGANIZATION'; name: string }) {
  return request<LivestockOwner>('/owners', {
    method: 'POST', headers: bearer(accessToken), body: JSON.stringify(input),
  });
}
export function updateBrandOwners(accessToken: string, id: string, ownerIds: string[]) {
  return request<{ ownerIds: string[] }>(`/animal-brands/${encodeURIComponent(id)}/owners`, {
    method: 'PUT', headers: bearer(accessToken), body: JSON.stringify({ ownerIds }),
  });
}
export function updateAnimalOwners(accessToken: string, id: string, input: {
  owners: Array<{ partyId: string; percent: number; isPrimary: boolean }>;
  expectedVersion: number;
}) {
  return request<Animal>(`/animals/${encodeURIComponent(id)}/owners`, {
    method: 'PUT', headers: bearer(accessToken), body: JSON.stringify(input),
  });
}
export function listBrands(accessToken: string) {
  return request<LivestockBrand[]>('/animal-brands', { headers: bearer(accessToken) });
}

export function createBrand(accessToken: string, name: string, ownerIds: string[]) {
  return request<LivestockBrand>('/animal-brands', {
    method: 'POST', headers: bearer(accessToken), body: JSON.stringify({ name, ownerIds }),
  });
}

export function setBrandActive(accessToken: string, id: string, active: boolean) {
  return request<LivestockBrand>(`/animal-brands/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: bearer(accessToken), body: JSON.stringify({ active }),
  });
}

export function updateAnimalBrands(accessToken: string, id: string, input: {
  brandIds: string[]; expectedVersion: number;
}) {
  return request<Animal>(`/animals/${encodeURIComponent(id)}/brands`, {
    method: 'PATCH', headers: bearer(accessToken), body: JSON.stringify(input),
  });
}

export type ParentSelection = { animalId: string } | { reportedName: string } | null;

export function updateAnimalParents(accessToken: string, id: string, input: {
  mother: ParentSelection; father: ParentSelection; expectedVersion: number;
}) {
  return request<Animal>(`/animals/${encodeURIComponent(id)}/parents`, {
    method: 'PATCH', headers: bearer(accessToken), body: JSON.stringify(input),
  });
}

export function listCatalogItems(accessToken: string, code: EditableCatalogCode) {
  return request<CatalogItem[]>(`/catalogs/${code}/items`, { headers: bearer(accessToken) });
}

export function createCatalogItem(accessToken: string, code: EditableCatalogCode, name: string) {
  return request<CatalogItem>(`/catalogs/${code}/items`, {
    method: 'POST', headers: bearer(accessToken), body: JSON.stringify({ name, speciesCode: 'BOVINE' }),
  });
}

export function setCatalogItemActive(accessToken: string, code: EditableCatalogCode, id: string, active: boolean) {
  return request<CatalogItem>(`/catalogs/${code}/items/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: bearer(accessToken), body: JSON.stringify({ active }),
  });
}

export interface ReproductionHeat {
  id: string; cowId: string; cowName: string; bullId: string | null;
  startsOn: string; endsOn: string | null; isFalse: boolean;
  notes: string | null; cancelled: boolean;
}
export interface ReproductionPregnancy {
  id: string; cowId: string; cowName: string; heatId: string | null;
  serviceId: string | null;
  fatherId: string | null; externalFather: string | null;
  conceptionMethod: string; confirmationMethod: string;
  confirmedOn: string; expectedBirthOn: string | null;
  gestationDays: number | null; status: 'CONFIRMED' | 'BORN' | 'LOST' | 'CANCELLED';
  notes: string | null;
}
export interface ReproductionBirth {
  id: string; pregnancyId: string; motherId: string; motherName: string;
  occurredOn: string; liveCount: number; stillbornCount: number; notes: string | null;
  calves: Array<{ id: string; name: string; sex: Animal['sex'] }>;
}
export interface ReproductionLoss {
  id: string; pregnancyId: string; cowId: string; cowName: string;
  occurredOn: string; notes: string;
}
export interface ReproductionRecords {
  heats: ReproductionHeat[]; pregnancies: ReproductionPregnancy[];
  births: ReproductionBirth[]; losses: ReproductionLoss[];
  services: ReproductionService[];
}
export interface ReproductionService {
  id: string; cowId: string; cowName: string; heatId: string | null;
  fatherId: string | null; externalFather: string | null;
  donorId: string | null; externalDonor: string | null;
  kind: 'INSEMINATION' | 'EMBRYO_TRANSFER'; occurredOn: string;
  materialCode: string | null; quality: string | null; technician: string | null;
  supplier: string | null; notes: string | null; cancelled: boolean; hasPregnancy: boolean;
}
export interface ReproductionCandidate { id: string; name: string; sex: Animal['sex'] }
export interface ReproductionSettings {
  daysAfterBirthHeat: number; daysAfterBirthPregnancy: number;
  daysAfterLossHeat: number; daysAfterLossPregnancy: number;
  minimumCowMonths: number; minimumBullMonths: number;
  allowSecondHeat: boolean; allowFalseHeatInPregnancy: boolean;
  useLastValidHeat: boolean;
  maxMilkingDays: number;
}
export function getReproductionSettings(accessToken: string) {
  return request<ReproductionSettings>('/reproduction/settings', { headers: bearer(accessToken) });
}
export function updateReproductionSettings(accessToken: string, input: ReproductionSettings) {
  return request<ReproductionSettings>('/reproduction/settings', {
    method: 'PUT', headers: bearer(accessToken), body: JSON.stringify(input),
  });
}
export function getReproduction(accessToken: string) {
  return request<ReproductionRecords>('/reproduction', { headers: bearer(accessToken) });
}
export function getReproductionCandidates(accessToken: string) {
  return request<ReproductionCandidate[]>('/reproduction/candidates', { headers: bearer(accessToken) });
}
export function createHeat(accessToken: string, input: {
  cowId: string; bullId?: string | null; startsOn: string; endsOn?: string | null;
  isFalse: boolean; notes?: string | null;
}) {
  return request<ReproductionHeat>('/reproduction/heats', {
    method: 'POST', headers: bearer(accessToken), body: JSON.stringify(input),
  });
}
export function createService(accessToken: string, input: {
  cowId: string; heatId?: string | null; fatherId?: string | null;
  externalFather?: string | null; donorId?: string | null; externalDonor?: string | null;
  kind: 'INSEMINATION' | 'EMBRYO_TRANSFER'; occurredOn: string;
  materialCode?: string | null; quality?: string | null; technician?: string | null;
  supplier?: string | null; notes?: string | null;
}) {
  return request<ReproductionService>('/reproduction/services', {
    method: 'POST', headers: bearer(accessToken), body: JSON.stringify(input),
  });
}
export function cancelService(accessToken: string, id: string) {
  return request<{ id: string; cancelled: boolean }>(`/reproduction/services/${encodeURIComponent(id)}/cancel`, {
    method: 'POST', headers: bearer(accessToken),
  });
}
export function createPregnancy(accessToken: string, input: {
  cowId: string; heatId?: string | null; fatherId?: string | null;
  serviceId?: string | null;
  externalFather?: string | null; conceptionMethod: string; confirmationMethod: string;
  confirmedOn: string; gestationDays?: number | null; notes?: string | null;
}) {
  return request<ReproductionPregnancy>('/reproduction/pregnancies', {
    method: 'POST', headers: bearer(accessToken), body: JSON.stringify(input),
  });
}
export function recordBirth(accessToken: string, input: {
  pregnancyId: string; occurredOn: string;
  calves: Array<{ name: string; sex: Animal['sex']; earTagCode?: string }>;
  stillbornCount: number; notes?: string | null;
}) {
  return request<ReproductionBirth>('/reproduction/births', {
    method: 'POST', headers: bearer(accessToken), body: JSON.stringify(input),
  });
}
export function recordLoss(accessToken: string, input: {
  pregnancyId: string; occurredOn: string; notes: string;
}) {
  return request<ReproductionLoss>('/reproduction/losses', {
    method: 'POST', headers: bearer(accessToken), body: JSON.stringify(input),
  });
}
export function cancelPregnancy(accessToken: string, id: string) {
  return request<{ id: string; status: string }>(`/reproduction/pregnancies/${encodeURIComponent(id)}/cancel`, {
    method: 'POST', headers: bearer(accessToken),
  });
}
export function cancelHeat(accessToken: string, id: string) {
  return request<{ id: string; cancelled: boolean }>(`/reproduction/heats/${encodeURIComponent(id)}/cancel`, {
    method: 'POST', headers: bearer(accessToken),
  });
}

export interface MilkLactation {
  id:string; cowId:string; cowName:string; birthId:string; startedOn:string;
  endedOn:string|null; inMilking:boolean; notes:string|null;
}
export interface MilkRecord {
  id:string; cowId:string; cowName:string; lactationId:string|null;
  producedOn:string; shift:string; liters:number; source:string;
  externalReference:string|null; notes:string|null;
}
export interface TankRecord {
  id:string; producedOn:string; shift:string; liters:number; source:string;
  externalReference:string|null; notes:string|null;
}
export interface ProductionRecords {
  lactations:MilkLactation[]; milk:MilkRecord[]; tanks:TankRecord[];
  births:Array<{id:string;cowId:string;cowName:string;occurredOn:string}>;
  cows:Array<{id:string;name:string;inMilking:boolean;lactationId:string|null}>;
}
export function getProduction(accessToken:string) {
  return request<ProductionRecords>('/production',{headers:bearer(accessToken)});
}
export function createLactation(accessToken:string,input:{birthId:string;endedOn?:string|null;
  inMilking:boolean;notes?:string|null}) {
  return request<MilkLactation>('/production/lactations',{
    method:'POST',headers:bearer(accessToken),body:JSON.stringify(input),
  });
}
export function finishLactation(accessToken:string,id:string,endedOn:string) {
  return request<MilkLactation>(`/production/lactations/${encodeURIComponent(id)}/finish`,{
    method:'POST',headers:bearer(accessToken),body:JSON.stringify({endedOn}),
  });
}
export function setLactationMilking(accessToken:string,id:string,inMilking:boolean) {
  return request<MilkLactation>(`/production/lactations/${encodeURIComponent(id)}/milking`,{
    method:'PUT',headers:bearer(accessToken),body:JSON.stringify({inMilking}),
  });
}
export function setCowMilking(accessToken:string,id:string,inMilking:boolean) {
  return request<{cowId:string;inMilking:boolean}>(`/production/cows/${encodeURIComponent(id)}/milking`,{
    method:'PUT',headers:bearer(accessToken),body:JSON.stringify({inMilking}),
  });
}
export type MilkShift='MORNING'|'AFTERNOON'|'NIGHT'|'SINGLE';
export function recordMilk(accessToken:string,input:{cowId?:string;lactationId?:string;producedOn:string;
  shift:MilkShift;liters:number;source:'MANUAL'|'SENSOR';externalReference?:string|null;
  notes?:string|null}) {
  return request<MilkRecord>('/production/milk',{
    method:'POST',headers:bearer(accessToken),body:JSON.stringify(input),
  });
}
export function recordTank(accessToken:string,input:{producedOn:string;
  shift:MilkShift;liters:number;source:'MANUAL'|'SENSOR';externalReference?:string|null;
  notes?:string|null}) {
  return request<TankRecord>('/production/tanks',{
    method:'POST',headers:bearer(accessToken),body:JSON.stringify(input),
  });
}

export interface MovementRecord {
  id:string;kind:'UBICACION'|'GRUPO'|'PROPIEDAD'|'COMBINADO';
  selectionMode:'GRUPO'|'MANUAL';status:'BORRADOR'|'COMPLETADO'|'CANCELADO';version:number;
  sourcePropertyId:string;sourcePropertyName:string;destinationPropertyId:string;destinationPropertyName:string;
  sourceGroupId:string;sourceGroupName:string;destinationGroupId:string;destinationGroupName:string;
  sourceLocationId:string|null;sourceLocationName:string|null;
  destinationLocationId:string|null;destinationLocationName:string|null;
  movementOn:string;reason:string;notes:string|null;createdAt:string;
  appliedAt:string|null;cancelledAt:string|null;
  animals:Array<{id:string;name:string;sourceGroupId:string;sourceLocationId:string|null;
    destinationGroupId:string;destinationLocationId:string|null}>;
}
export interface MovementOptions {
  properties:Array<{id:string;name:string}>;
  groups:Array<{id:string;name:string;propertyId:string;locationId:string|null;locationName:string|null}>;
  locations:Array<{id:string;name:string;kind:'PASTURE'|'CORRAL';propertyId:string}>;
  animals:Array<{id:string;name:string;earTagCode:string|null;groupId:string|null;locationId:string|null}>;
}
export interface MovementInput {
  kind:MovementRecord['kind'];selectionMode:MovementRecord['selectionMode'];
  sourceGroupId:string;destinationPropertyId:string;destinationGroupId:string;
  destinationLocationId?:string|null;movementOn:string;reason:string;notes?:string|null;
  animalIds:string[];expectedVersion?:number;
}
export function getMovements(accessToken:string){
  return request<MovementRecord[]>('/movements',{headers:bearer(accessToken)});
}
export function getMovementOptions(accessToken:string){
  return request<MovementOptions>('/movements/options',{headers:bearer(accessToken)});
}
export function createMovement(accessToken:string,input:MovementInput){
  return request<MovementRecord>('/movements',{
    method:'POST',headers:bearer(accessToken),body:JSON.stringify(input),
  });
}
export function updateMovement(accessToken:string,id:string,input:MovementInput){
  return request<MovementRecord>(`/movements/${encodeURIComponent(id)}`,{
    method:'PUT',headers:bearer(accessToken),body:JSON.stringify(input),
  });
}
export function applyMovement(accessToken:string,id:string){
  return request<MovementRecord>(`/movements/${encodeURIComponent(id)}/apply`,{
    method:'POST',headers:bearer(accessToken),
  });
}
export function cancelMovement(accessToken:string,id:string){
  return request<MovementRecord>(`/movements/${encodeURIComponent(id)}/cancel`,{
    method:'POST',headers:bearer(accessToken),
  });
}

export interface HealthMedicine {
  id:string;name:string;kind:'VACUNA'|'DESPARASITACION'|'ENFERMEDAD'|'OTRO';
  treatmentCatalogItemId?:string|null;
  activeIngredient:string|null;defaultUnitCode:string;suggestedDose:string|null;
  indications:string|null;withdrawalMilkDays:number;withdrawalMeatDays:number;active:boolean;
}
export interface HealthOptions {
  animals:Array<{id:string;name:string;earTagCode:string|null;groupId:string|null}>;
  groups:Array<{id:string;name:string}>;
  units:Array<{code:string;name:string;symbol:string}>;
}
export interface HealthAnimalInput {
  animalId:string;selected:boolean;dose:number;unitCode:string;notes?:string|null;conditionId?:string|null;
}
export interface HealthCondition {
  id:string;animalId:string;animalName:string;kind:string|null;detectedOn:string;
  description:string;status:'POR_RESOLVER'|'EN_TRATAMIENTO'|'RESUELTA';
  resolvedOn:string|null;version:number;treatmentCount:number;
}
export interface HealthConditionInput {
  animalId:string;kind:string;detectedOn:string;description:string;expectedVersion?:number;
}
export function getHealthConditions(accessToken:string){return request<HealthCondition[]>(
  '/health-records/conditions',{headers:bearer(accessToken)});}
export function createHealthCondition(accessToken:string,input:HealthConditionInput){
  return request<HealthCondition>('/health-records/conditions',{
    method:'POST',headers:{...bearer(accessToken),'Content-Type':'application/json'},body:JSON.stringify(input)});}
export function updateHealthCondition(accessToken:string,id:string,input:HealthConditionInput){
  return request<HealthCondition>(`/health-records/conditions/${encodeURIComponent(id)}`,{
    method:'PUT',headers:{...bearer(accessToken),'Content-Type':'application/json'},body:JSON.stringify(input)});}
export function resolveHealthCondition(accessToken:string,id:string,input:{resolvedOn:string;expectedVersion:number}){
  return request<HealthCondition>(`/health-records/conditions/${encodeURIComponent(id)}/resolve`,{
    method:'POST',headers:{...bearer(accessToken),'Content-Type':'application/json'},body:JSON.stringify(input)});}
export interface HealthCampaignInput {
  medicineId:string;administrationRoute:'ORAL'|'INTRAMUSCULAR'|'SUBCUTANEA'|'INTRAVENOSA'|'TOPICA'|'OTRA';
  selectionMode:'TODOS'|'GRUPO'|'MANUAL';groupId?:string|null;appliedOn:string;
  responsible?:string|null;notes?:string|null;animals:HealthAnimalInput[];expectedVersion?:number;
}
export interface HealthCampaign extends Omit<HealthCampaignInput,'animals'> {
  id:string;medicineName:string;kind:HealthMedicine['kind'];groupName:string|null;
  status:'BORRADOR'|'COMPLETADO'|'CANCELADO';version:number;
  animals:Array<HealthAnimalInput&{name:string}>;createdAt:string;appliedAt:string|null;
  cancelledAt:string|null;
}
export function getHealthMedicines(accessToken:string){return request<HealthMedicine[]>(
  '/health-records/medicines',{headers:bearer(accessToken)});}
export function createHealthMedicine(accessToken:string,input:Omit<HealthMedicine,'id'|'active'>){
  return request<HealthMedicine>('/health-records/medicines',{
    method:'POST',headers:{...bearer(accessToken),'Content-Type':'application/json'},body:JSON.stringify(input)});}
export function getHealthOptions(accessToken:string){return request<HealthOptions>(
  '/health-records/options',{headers:bearer(accessToken)});}
export function getHealthCampaigns(accessToken:string){return request<HealthCampaign[]>(
  '/health-records/campaigns',{headers:bearer(accessToken)});}
export function createHealthCampaign(accessToken:string,input:HealthCampaignInput){
  return request<HealthCampaign>('/health-records/campaigns',{
    method:'POST',headers:{...bearer(accessToken),'Content-Type':'application/json'},body:JSON.stringify(input)});}
export function updateHealthCampaign(accessToken:string,id:string,input:HealthCampaignInput){
  return request<HealthCampaign>(`/health-records/campaigns/${encodeURIComponent(id)}`,{
    method:'PUT',headers:{...bearer(accessToken),'Content-Type':'application/json'},body:JSON.stringify(input)});}
export function applyHealthCampaign(accessToken:string,id:string){
  return request<HealthCampaign>(`/health-records/campaigns/${encodeURIComponent(id)}/apply`,{
    method:'POST',headers:bearer(accessToken)});}
export function cancelHealthCampaign(accessToken:string,id:string){
  return request<HealthCampaign>(`/health-records/campaigns/${encodeURIComponent(id)}/cancel`,{
    method:'POST',headers:bearer(accessToken)});}

export interface CleaningProduct {id:string;name:string;category:string|null;active:boolean;
  activeIngredient:string|null;formulatedBy:string|null;description:string|null}
export interface CleaningOptions {
  locations:Array<{id:string;name:string;areaValue:number|null;areaUnitCode:string|null}>;
  units:Array<{code:string;name:string;symbol:string}>;
}
export interface CleaningInput {
  locationId:string;startedOn:string;finishedOn?:string|null;
  activities:Array<'FUMIGACION'|'TALA_SELECTIVA'|'DESBROCE'|'OTRA'>;
  applicationUnit?:'TANQUES'|'BOMBADAS'|null;applicationCount?:number|null;
  tankCapacityLiters?:number|null;areaType:'TOTAL'|'PARCIAL';partialPercent?:number|null;
  notes?:string|null;
  products:Array<{productId:string;unitCode:string;quantityPerApplication:number;notes?:string|null}>;
  operators:Array<{name:string;function?:string|null;notes?:string|null}>;
  expectedVersion?:number;
}
export interface CleaningRecord extends CleaningInput {
  id:string;locationName:string;areaValue:number|null;areaUnitCode:string|null;
  status:'BORRADOR'|'COMPLETADO'|'CANCELADO';version:number;
  products:Array<CleaningInput['products'][number]&{productName:string;totalQuantity:number}>;
  createdAt:string;completedAt:string|null;cancelledAt:string|null;
}
export function getCleanings(accessToken:string){return request<CleaningRecord[]>(
  '/cleanings',{headers:bearer(accessToken)});}
export function getCleaningOptions(accessToken:string){return request<CleaningOptions>(
  '/cleanings/options',{headers:bearer(accessToken)});}
export function getCleaningProducts(accessToken:string){return request<CleaningProduct[]>(
  '/cleanings/products',{headers:bearer(accessToken)});}
export function createCleaningProduct(accessToken:string,input:{name:string;category?:string|null;
  activeIngredient?:string|null;formulatedBy?:string|null;description?:string|null}){
  return request<CleaningProduct>('/cleanings/products',{
    method:'POST',headers:{...bearer(accessToken),'Content-Type':'application/json'},body:JSON.stringify(input)});}
export function createCleaning(accessToken:string,input:CleaningInput){return request<CleaningRecord>(
  '/cleanings',{method:'POST',headers:{...bearer(accessToken),'Content-Type':'application/json'},
    body:JSON.stringify(input)});}
export function updateCleaning(accessToken:string,id:string,input:CleaningInput){
  return request<CleaningRecord>(`/cleanings/${encodeURIComponent(id)}`,{
    method:'PUT',headers:{...bearer(accessToken),'Content-Type':'application/json'},body:JSON.stringify(input)});}
export function applyCleaning(accessToken:string,id:string){return request<CleaningRecord>(
  `/cleanings/${encodeURIComponent(id)}/apply`,{method:'POST',headers:bearer(accessToken)});}
export function cancelCleaning(accessToken:string,id:string){return request<CleaningRecord>(
  `/cleanings/${encodeURIComponent(id)}/cancel`,{method:'POST',headers:bearer(accessToken)});}

export interface ActivityInput {
  kind:'HERRAJE'|'DESCORNE'|'OTRA';title:string;occurredOn:string;
  description?:string|null;brandId?:string|null;animalIds:string[];expectedVersion?:number;
}
export interface ActivityRecord extends Omit<ActivityInput,'animalIds'> {
  id:string;brandName:string|null;status:'BORRADOR'|'COMPLETADA'|'CANCELADA';
  version:number;animals:Array<{id:string;name:string;earTagCode:string|null}>;
  createdAt:string;appliedAt:string|null;cancelledAt:string|null;
}
export interface ActivityOptions {
  animals:Array<{id:string;name:string;earTagCode:string|null}>;
  brands:Array<{id:string;name:string}>;
}
export function getActivities(accessToken:string){return request<ActivityRecord[]>(
  '/activities',{headers:bearer(accessToken)});}
export function getActivityOptions(accessToken:string){return request<ActivityOptions>(
  '/activities/options',{headers:bearer(accessToken)});}
export function createActivity(accessToken:string,input:ActivityInput){return request<ActivityRecord>(
  '/activities',{method:'POST',headers:{...bearer(accessToken),'Content-Type':'application/json'},
    body:JSON.stringify(input)});}
export function updateActivity(accessToken:string,id:string,input:ActivityInput){
  return request<ActivityRecord>(`/activities/${encodeURIComponent(id)}`,{
    method:'PUT',headers:{...bearer(accessToken),'Content-Type':'application/json'},
    body:JSON.stringify(input)});}
export function applyActivity(accessToken:string,id:string){return request<ActivityRecord>(
  `/activities/${encodeURIComponent(id)}/apply`,{method:'POST',headers:bearer(accessToken)});}
export function cancelActivity(accessToken:string,id:string){return request<ActivityRecord>(
  `/activities/${encodeURIComponent(id)}/cancel`,{method:'POST',headers:bearer(accessToken)});}

export function createAccountProperty(accessToken: string, name: string) {
  return request<{ accountId: string; propertyId: string; roleId: string }>('/property-settings/properties', {
    method: 'POST', headers: bearer(accessToken), body: JSON.stringify({ name }),
  });
}

export function createOwnAccount(accessToken: string, name: string) {
  return request<{ accountId: string; propertyId: string; roleId: string }>('/my-account', {
    method: 'POST', headers: bearer(accessToken), body: JSON.stringify({ name }),
  });
}

export function updatePropertyModule(accessToken: string, moduleCode: string, enabled: boolean) {
  return request<{ code: string; enabled: boolean }>(
    `/property-settings/modules/${encodeURIComponent(moduleCode)}`, {
      method: 'PUT', headers: bearer(accessToken), body: JSON.stringify({ enabled }),
    },
  );
}

export function createPropertyInvitation(accessToken: string, input: {
  email: string;
  roleIds: string[];
  jobTitle?: string;
  payAmount?: number | null;
  payFrequency?: 'HOURLY' | 'DAILY' | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'OTHER' | null;
  employmentNotes?: string;
}) {
  return request<{ id: string; expiresAt: string; delivery: 'SENT' | 'UNAVAILABLE' | 'FAILED' }>(
    '/property-team/invitations', {
      method: 'POST', headers: bearer(accessToken), body: JSON.stringify(input),
    },
  );
}

export function revokePropertyInvitation(accessToken: string, invitationId: string) {
  return request<{ revoked: true }>(`/property-team/invitations/${invitationId}`, {
    method: 'DELETE', headers: bearer(accessToken),
  });
}

export function updateMembershipStatus(
  accessToken: string,
  membershipId: string,
  status: 'ACTIVE' | 'SUSPENDED' | 'ENDED',
) {
  return request<{ status: string }>(`/property-team/members/${membershipId}/status`, {
    method: 'PATCH', headers: bearer(accessToken), body: JSON.stringify({ status }),
  });
}

export function getPlatformOverview(accessToken: string) {
  return request<PlatformOverview>('/superadmin/overview', { headers: bearer(accessToken) });
}

export function getAdministrativeAccount(accessToken: string, accountId: string) {
  return request<AccountDetails>(`/superadmin/accounts/${accountId}`, { headers: bearer(accessToken) });
}

export function updateAdministrativeAccount(
  accessToken: string,
  accountId: string,
  input: { status?: AdministrativeAccountSummary['status']; maxProperties?: number },
) {
  return request<{ status: string; maxProperties: number }>(`/superadmin/accounts/${accountId}`, {
    method: 'PATCH',
    headers: bearer(accessToken),
    body: JSON.stringify(input),
  });
}

export function updateAdministrativeQuota(
  accessToken: string,
  accountId: string,
  quotaCode: string,
  limitValue: number | null,
) {
  return request(`/superadmin/accounts/${accountId}/quotas/${quotaCode}`, {
    method: 'PUT',
    headers: bearer(accessToken),
    body: JSON.stringify({ limitValue }),
  });
}

export function updateAdministrativeModule(
  accessToken: string,
  accountId: string,
  moduleCode: string,
  enabled: boolean,
) {
  return request(`/superadmin/accounts/${accountId}/modules/${moduleCode}`, {
    method: 'PUT',
    headers: bearer(accessToken),
    body: JSON.stringify({ enabled }),
  });
}

export interface MediaItem {
  id:string;storage_object_id:string;entity_type:string;entity_id:string;entity_name:string|null;
  relation_code:string;description:string|null;captured_on:string|null;
  tags:Array<{id:string;name:string}>;
  kind:'IMAGE'|'VIDEO';byteSize:number;created_at:string;url:string;thumbnailUrl:string|null;
}
export interface MediaUsage {storedBytes:number;reservedBytes:number;limitBytes:number}
export function getMedia(accessToken:string,entityType?:string,entityId?:string){
  const params=entityType&&entityId?`?${new URLSearchParams({entityType,entityId})}`:'';
  return request<MediaItem[]>(`/media${params}`,{
  headers:bearer(accessToken)});}
export function getMediaUsage(accessToken:string){return request<MediaUsage>('/media/usage',{
  headers:bearer(accessToken)});}
export function deleteMedia(accessToken:string,id:string){return request<void>(`/media/${id}`,{
  method:'DELETE',headers:bearer(accessToken)});}
export function deleteMediaObject(accessToken:string,id:string){return request<{deletedFromProvider:boolean}>(
  `/media/objects/${id}`,{method:'DELETE',headers:bearer(accessToken)});}
export async function uploadMedia(accessToken:string,input:{file:File;animalIds?:string[];
  entityType?:string;entityId?:string;relationCode?:'GENERAL'|'PROFILE'|'COVER';
  tagIds?:string[];description?:string;capturedOn?:string}){
  const {file}=input;const first=input.animalIds?.[0];
  const params=new URLSearchParams({entityType:input.entityType??'ANIMAL',
    entityId:input.entityId??first??'',relationCode:input.relationCode??'GENERAL'});
  if(input.animalIds?.length)params.set('animalIds',input.animalIds.join(','));
  if(input.tagIds?.length)params.set('tagIds',input.tagIds.join(','));
  if(input.description)params.set('description',input.description);
  if(input.capturedOn)params.set('capturedOn',input.capturedOn);
  let response:Response;
  try{response=await fetch(`${API_URL}/media?${params}`,{
    method:'POST',credentials:'include',headers:{authorization:`Bearer ${accessToken}`,
      'content-type':file.type||'application/octet-stream',
      'x-media-kind':file.type.startsWith('video/')?'VIDEO':'IMAGE'},body:file});}
  catch{throw new ApiRequestError('No fue posible enviar el archivo.',0,'NETWORK_ERROR');}
  const body=await response.json() as ApiEnvelope<{id:string;attachmentIds:string[]}>|ApiErrorEnvelope;
  if(!response.ok)throw new ApiRequestError((body as ApiErrorEnvelope).error?.message||
    'No se pudo cargar el archivo.',response.status,(body as ApiErrorEnvelope).error?.code||'UPLOAD_FAILED');
  return (body as ApiEnvelope<{id:string;attachmentIds:string[]}>).data;
}
