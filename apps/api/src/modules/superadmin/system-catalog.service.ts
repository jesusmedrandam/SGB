import {randomUUID} from 'node:crypto';
import {pool} from '../../database/pool.js';
import {inTransaction} from '../../database/transaction.js';
import {conflict,forbidden,invalidRequest} from '../../core/errors.js';
import type {AuthState,RequestMetadata} from '../auth/auth.types.js';

export const systemCatalogCodes=['BREEDS','COLORS','GRASS_TYPES','HEALTH_CONDITION_TYPES',
  'AGROCHEMICAL_CATEGORIES','MEDIA_TAGS','MOVEMENT_REASONS','TREATMENT_TYPES'] as const;
export type SystemCatalogCode=typeof systemCatalogCodes[number];
type Row={id:string;catalog_code:SystemCatalogCode;name:string;item_code:string|null;
  active:boolean;species_code:string|null};
const view=(row:Row)=>({id:row.id,catalogCode:row.catalog_code,name:row.name,
  itemCode:row.item_code,active:row.active,speciesCode:row.species_code,systemDefined:true});

async function assertSuperadmin(auth:AuthState){
  if(!auth.isSuperadmin)throw forbidden('SUPERADMIN_REQUIRED','Requiere el rol de superadministrador.');
  const result=await pool.query(`SELECT 1 FROM app_user WHERE id=$1 AND is_superadmin
    AND deleted_at IS NULL`,[auth.userId]);
  if(!result.rowCount)throw forbidden('SUPERADMIN_REQUIRED','Requiere el rol de superadministrador.');
}

export async function listSystemCatalog(auth:AuthState,code:SystemCatalogCode){
  await assertSuperadmin(auth);
  const result=await pool.query<Row>(`SELECT id,catalog_code,name,item_code,active,species_code
    FROM governed_catalog_item WHERE catalog_code=$1 AND system_defined AND deleted_at IS NULL
    ORDER BY lower(name),id`,[code]);
  return result.rows.map(view);
}

export async function saveSystemCatalogItem(auth:AuthState,code:SystemCatalogCode,
  input:{name:string},meta:RequestMetadata){
  await assertSuperadmin(auth);
  return inTransaction(async client=>{
    const definition=await client.query(`SELECT 1 FROM catalog_definition
      WHERE code=$1 AND active AND mutability='PROPERTY_EXTENSIBLE' FOR UPDATE`,[code]);
    if(!definition.rowCount)throw invalidRequest('SYSTEM_CATALOG_UNAVAILABLE',
      'Este catálogo no admite opciones globales.');
    const duplicate=await client.query(`SELECT 1 FROM governed_catalog_item
      WHERE catalog_code=$1 AND system_defined AND lower(name)=lower($2)
        AND deleted_at IS NULL`,[code,input.name]);
    if(duplicate.rowCount)throw conflict('SYSTEM_CATALOG_DUPLICATE','La opción global ya existe.');
    const itemCode=`SYSTEM_${randomUUID().replaceAll('-','').toUpperCase()}`;
    const created=(await client.query<Row>(`INSERT INTO governed_catalog_item
      (catalog_code,item_code,name,system_defined) VALUES($1,$2,$3,true)
      RETURNING id,catalog_code,name,item_code,active,species_code`,
      [code,itemCode,input.name])).rows[0]!;
    await client.query(`INSERT INTO audit_event(actor_user_id,action,entity_type,entity_id,
      after_data,superadmin_access,ip_address,user_agent)
      VALUES($1,'SYSTEM_CATALOG_CREATED','CATALOG_ITEM',$2,$3::jsonb,true,$4,$5)`,
      [auth.userId,created.id,JSON.stringify(view(created)),meta.ipAddress,meta.userAgent]);
    return view(created);
  });
}

export async function updateSystemCatalogItem(auth:AuthState,code:SystemCatalogCode,id:string,
  input:{name?:string|undefined;active?:boolean|undefined},meta:RequestMetadata){
  await assertSuperadmin(auth);
  return inTransaction(async client=>{
    await client.query('SELECT 1 FROM catalog_definition WHERE code=$1 FOR UPDATE',[code]);
    const before=(await client.query<Row>(`SELECT id,catalog_code,name,item_code,active,species_code
      FROM governed_catalog_item WHERE id=$1 AND catalog_code=$2 AND system_defined
        AND deleted_at IS NULL FOR UPDATE`,[id,code])).rows[0];
    if(!before)throw invalidRequest('SYSTEM_CATALOG_ITEM_UNAVAILABLE','Opción global no encontrada.');
    const name=input.name??before.name;
    const duplicate=await client.query(`SELECT 1 FROM governed_catalog_item WHERE catalog_code=$1
      AND system_defined AND lower(name)=lower($2) AND id<>$3 AND deleted_at IS NULL`,
      [code,name,id]);
    if(duplicate.rowCount)throw conflict('SYSTEM_CATALOG_DUPLICATE','La opción global ya existe.');
    const after=(await client.query<Row>(`UPDATE governed_catalog_item
      SET name=$2,active=$3 WHERE id=$1 RETURNING id,catalog_code,name,item_code,active,species_code`,
      [id,name,input.active??before.active])).rows[0]!;
    await client.query(`INSERT INTO audit_event(actor_user_id,action,entity_type,entity_id,
      before_data,after_data,superadmin_access,ip_address,user_agent)
      VALUES($1,'SYSTEM_CATALOG_UPDATED','CATALOG_ITEM',$2,$3::jsonb,$4::jsonb,true,$5,$6)`,
      [auth.userId,id,JSON.stringify(view(before)),JSON.stringify(view(after)),
        meta.ipAddress,meta.userAgent]);
    return view(after);
  });
}
