import type {PoolClient} from 'pg';
import {forbidden} from '../../core/errors.js';
import {pool} from '../../database/pool.js';
import {inTransaction} from '../../database/transaction.js';
import type {AuthState,PropertyContext,RequestMetadata} from '../auth/auth.types.js';

export type ClassificationInput={femaleAdultMonths:number;maleAdultMonths:number;
  names:Record<'VACA'|'VACONA'|'TERNERA'|'TORO'|'TORETE'|'TERNERO',string>};

async function policy(client:PoolClient,propertyId:string){
  const result=await client.query<{femaleAdultMonths:number;maleAdultMonths:number;
    names:ClassificationInput['names']}>(`SELECT COALESCE(policy.female_adult_months,12) AS "femaleAdultMonths",
    COALESCE(policy.male_adult_months,12) AS "maleAdultMonths",
    (SELECT json_object_agg(c.code,COALESCE(n.name,c.name)) FROM animal_classification_catalog c
      LEFT JOIN account_animal_classification_name n ON n.account_id=p.account_id AND n.code=c.code)
      AS names FROM property p
    LEFT JOIN account_animal_classification_policy policy ON policy.account_id=p.account_id
    WHERE p.id=$1 AND p.deleted_at IS NULL`,[propertyId]);
  return result.rows[0]!;
}
export async function getClassificationPolicy(context:PropertyContext){
  const client=await pool.connect();try{return await policy(client,context.propertyId);}
  finally{client.release();}
}
export async function updateClassificationPolicy(auth:AuthState,context:PropertyContext,
  input:ClassificationInput,metadata:RequestMetadata){
  return inTransaction(async client=>{
    const grant=await client.query<{account_id:string}>(`SELECT p.account_id FROM property p
      JOIN administrative_account aa ON aa.id=p.account_id AND aa.status='ACTIVE'
      JOIN property_membership pm ON pm.property_id=p.id AND pm.user_id=$2 AND pm.status='ACTIVE'
      JOIN membership_role mr ON mr.membership_id=pm.id AND mr.property_id=p.id
      JOIN property_role pr ON pr.id=mr.role_id AND pr.property_id=p.id AND pr.active
      JOIN role_permission rp ON rp.role_id=pr.id AND rp.permission_code='CATALOG_MANAGE'
      WHERE p.id=$1 AND pr.id=$3 AND p.deleted_at IS NULL AND p.status='ACTIVE'
      FOR SHARE OF p,pm,pr`,[context.propertyId,auth.userId,context.roleId]);
    if(!grant.rows[0])throw forbidden('CLASSIFICATION_MANAGE_DENIED',
      'Necesitas permiso para gestionar los catálogos de esta cuenta.');
    const accountId=grant.rows[0].account_id;
    await client.query('SELECT id FROM administrative_account WHERE id=$1 FOR UPDATE',[accountId]);
    const before=await policy(client,context.propertyId);
    await client.query(`INSERT INTO account_animal_classification_policy
      (account_id,female_adult_months,male_adult_months,updated_by)
      VALUES($1,$2,$3,$4) ON CONFLICT(account_id) DO UPDATE SET
      female_adult_months=excluded.female_adult_months,
      male_adult_months=excluded.male_adult_months,
      updated_by=excluded.updated_by,updated_at=now()`,
      [accountId,input.femaleAdultMonths,input.maleAdultMonths,auth.userId]);
    for(const [code,name] of Object.entries(input.names)){
      await client.query(`INSERT INTO account_animal_classification_name(account_id,code,name)
        VALUES($1,$2,$3) ON CONFLICT(account_id,code) DO UPDATE SET name=excluded.name`,
        [accountId,code,name]);
    }
    const after=await policy(client,context.propertyId);
    await client.query(`INSERT INTO audit_event(actor_user_id,property_id,active_role_id,action,
      entity_type,entity_id,before_data,after_data,ip_address,user_agent)
      VALUES($1,$2,$3,'CLASSIFICATION_POLICY_UPDATED','ACCOUNT',$4,$5::jsonb,$6::jsonb,$7,$8)`,
      [auth.userId,context.propertyId,context.roleId,accountId,JSON.stringify(before),
        JSON.stringify(after),metadata.ipAddress,metadata.userAgent]);
    return after;
  });
}

export async function getAnimalSummary(context:PropertyContext){
  const rows=await pool.query<{code:string;label:string;count:number}>(`SELECT classified.code,
    COALESCE(custom.name,catalog.name) AS label,count(*)::int AS count
    FROM animal a JOIN property p ON p.id=a.property_id
    CROSS JOIN LATERAL (SELECT classify_animal(a.id,(now() AT TIME ZONE p.timezone)::date)
      AS code) classified
    JOIN animal_classification_catalog catalog ON catalog.code=classified.code
    LEFT JOIN account_animal_classification_name custom
      ON custom.account_id=p.account_id AND custom.code=classified.code
    WHERE a.property_id=$1 AND a.record_status='CURRENT'
    GROUP BY classified.code,custom.name,catalog.name ORDER BY classified.code`,[context.propertyId]);
  const groups=await pool.query<{name:string;count:number}>(`SELECT g.name,count(a.id)::int AS count
    FROM livestock_group g LEFT JOIN animal_group_assignment aga
      ON aga.group_id=g.id AND aga.ended_at IS NULL
    LEFT JOIN animal a ON a.id=aga.animal_id AND a.record_status='CURRENT'
    WHERE g.property_id=$1 AND g.active GROUP BY g.id,g.name ORDER BY lower(g.name)`,[context.propertyId]);
  const sex=await pool.query<{sex:string;count:number}>(`SELECT sex,count(*)::int AS count FROM animal
    WHERE property_id=$1 AND record_status='CURRENT' GROUP BY sex`,[context.propertyId]);
  return {classifications:rows.rows,groups:groups.rows,sex:sex.rows,
    total:sex.rows.reduce((sum,item)=>sum+item.count,0)};
}
