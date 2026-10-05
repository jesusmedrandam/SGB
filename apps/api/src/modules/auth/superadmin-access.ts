import type {PoolClient} from 'pg';
import {forbidden} from '../../core/errors.js';
import type {AuthState,PropertyContext} from './auth.types.js';

// Recheck the real actor inside each write transaction; never impersonate the owner.
export async function superadminPropertyAccess(client:Pick<PoolClient,'query'>,
  auth:Pick<AuthState,'userId'|'isSuperadmin'>,context:{propertyId:string;roleId?:string|null}){
  if(!auth.isSuperadmin)return null;
  const result=await client.query<{account_id:string;owner_user_id:string;owner_name:string;owner_email:string;
    property_name:string;timezone:string;role_id:string;today:string;max_days:number}>(`
    SELECT p.account_id,p.owner_user_id,owner.display_name AS owner_name,owner.email::text AS owner_email,
      p.name AS property_name,p.timezone,pr.id AS role_id,
      (now() AT TIME ZONE p.timezone)::date::text AS today,COALESCE(rs.max_milking_days,305) AS max_days
    FROM property p JOIN administrative_account aa ON aa.id=p.account_id
    JOIN app_user actor ON actor.id=$2 AND actor.is_superadmin AND actor.status='ACTIVE' AND actor.deleted_at IS NULL
    JOIN app_user owner ON owner.id=p.owner_user_id
    JOIN property_role pr ON pr.property_id=p.id AND (($3::uuid IS NULL AND pr.code='OWNER') OR pr.id=$3)
    LEFT JOIN reproduction_setting rs ON rs.property_id=p.id
    WHERE p.id=$1 AND p.deleted_at IS NULL FOR SHARE OF p,aa,actor,pr`,
    [context.propertyId,auth.userId,context.roleId??null]);
  if(!result.rows[0])throw forbidden('SUPPORT_CONTEXT_DENIED','La propiedad o el acceso de superadministrador ya no están disponibles.');
  return result.rows[0];
}

export async function superadminPropertyContext(client:Pick<PoolClient,'query'>,
  auth:Pick<AuthState,'userId'|'isSuperadmin'>,propertyId:string,roleId?:string|null){
  const property=await superadminPropertyAccess(client,auth,{propertyId,roleId:roleId??null});
  if(!property)throw forbidden('SUPERADMIN_REQUIRED','Esta operación requiere acceso de superadministrador.');
  const permissions=await client.query<{code:string}>('SELECT code FROM permission_catalog ORDER BY code');
  const modules=await client.query<{code:string}>("SELECT code FROM module_catalog WHERE scope='ACCOUNT_PROPERTY' ORDER BY code");
  const species=await client.query<{code:string}>('SELECT species_code AS code FROM effective_property_species WHERE property_id=$1 AND enabled',[propertyId]);
  const context:PropertyContext={propertyId,propertyName:property.property_name,roleId:property.role_id,
    roleCode:'SUPERADMIN',roleName:'Sistema · soporte',isSuperadmin:true,
    permissions:new Set(permissions.rows.map(row=>row.code)),enabledModules:new Set(modules.rows.map(row=>row.code)),
    enabledSpecies:new Set(species.rows.map(row=>row.code))};
  return {context,owner:{id:property.owner_user_id,name:property.owner_name,email:property.owner_email},timezone:property.timezone};
}
