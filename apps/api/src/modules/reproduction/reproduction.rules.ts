import type {PoolClient} from 'pg';
import {forbidden,invalidRequest} from '../../core/errors.js';
import type {AuthState,PropertyContext} from '../auth/auth.types.js';
import {superadminPropertyAccess} from '../auth/superadmin-access.js';

export async function cycleTrueHeats(client:PoolClient,cowId:string,on:string){
  return (await client.query<{id:string;is_false:boolean}>(`WITH boundaries AS (
    SELECT occurred_on FROM reproduction_birth WHERE mother_id=$1
    UNION SELECT occurred_on FROM reproduction_loss WHERE cow_id=$1
  ) SELECT id,is_false FROM reproduction_heat WHERE cow_id=$1 AND cancelled_at IS NULL AND NOT is_false
    AND starts_on>COALESCE((SELECT max(occurred_on) FROM boundaries WHERE occurred_on<=$2::date),'-infinity'::date)
    AND starts_on<COALESCE((SELECT min(occurred_on) FROM boundaries WHERE occurred_on>$2::date),'infinity'::date)
    ORDER BY starts_on DESC,created_at DESC`,[cowId,on])).rows;
}

export async function requireRulesAdministrator(client:PoolClient,auth:AuthState,context:PropertyContext){
  if(await superadminPropertyAccess(client,auth,context))return;
  const grant=await client.query(`SELECT 1 FROM property_membership pm
    JOIN membership_role mr ON mr.membership_id=pm.id AND mr.property_id=pm.property_id
    JOIN property_role pr ON pr.id=mr.role_id AND pr.property_id=pm.property_id
    WHERE pm.property_id=$1 AND pm.user_id=$2 AND pm.status='ACTIVE' AND pr.id=$3
      AND pr.active AND pr.is_system AND pr.code IN ('OWNER','ADMINISTRATOR') FOR SHARE OF pm,pr`,
    [context.propertyId,auth.userId,context.roleId]);
  if(!grant.rowCount)throw forbidden('RULES_ADMINISTRATOR_REQUIRED','Solo los administradores pueden modificar las reglas de la cuenta.');
}

export async function validateParentAge(client:PoolClient,propertyId:string,parentId:string,
  role:'MOTHER'|'FATHER',childBirthDate:string|null){
  const result=await client.query<{old_enough:boolean;months:number}>(`SELECT
    COALESCE(CASE WHEN $3='MOTHER' THEN s.minimum_cow_months ELSE s.minimum_bull_months END,12) AS months,
    a.birth_date IS NULL OR (a.birth_date+
      COALESCE(CASE WHEN $3='MOTHER' THEN s.minimum_cow_months ELSE s.minimum_bull_months END,12)*interval '1 month')::date
      <= COALESCE($4::date,(now() AT TIME ZONE p.timezone)::date) AS old_enough
    FROM animal a JOIN property p ON p.id=$1
    LEFT JOIN account_reproduction_setting s ON s.account_id=p.account_id WHERE a.id=$2`,
    [propertyId,parentId,role,childBirthDate]);
  if(!result.rows[0]?.old_enough)throw invalidRequest('REPRODUCTION_MINIMUM_AGE',
    `El ${role==='MOTHER'?'animal madre':'animal padre'} debe tener al menos ${result.rows[0]?.months??12} meses en la fecha de nacimiento de la cría.`);
}
