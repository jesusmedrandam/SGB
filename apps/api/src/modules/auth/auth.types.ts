export interface AuthState {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  isSuperadmin: boolean;
  activePropertyId: string | null;
  activeRoleId: string | null;
}

export interface PropertyContext {
  propertyId: string;
  propertyName: string;
  roleId: string;
  roleCode: string;
  roleName: string;
  permissions: ReadonlySet<string>;
  enabledModules: ReadonlySet<string>;
  enabledSpecies: ReadonlySet<string>;
}

export interface RequestMetadata {
  ipAddress: string | null;
  userAgent: string | null;
}
