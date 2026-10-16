import {Router} from 'express';
import {z} from 'zod';
import {asyncHandler} from '../../core/async-handler.js';
import {inTransaction} from '../../database/transaction.js';
import {ApiError,forbidden,conflict} from '../../core/errors.js';
import {animalProfilePhotoUrl} from './animals.service.js';
import {pool} from '../../database/pool.js';
import {authenticate} from '../auth/auth.middleware.js';
import type {AuthState} from '../auth/auth.types.js';

export const reviewFields=['photo','name','earTag','birthDate','entryDate','owners','location'] as const;
const reviewInput=z.object({fields:z.array(z.enum(reviewFields)).min(1).max(7).transform(fields=>[...new Set(fields)]),dismissed:z.boolean()});
export const inventoryFilters=z.object({page:z.coerce.number().int().min(1).max(100000).default(1),
  search:z.string().trim().max(160).default(''),propertyId:z.uuid().optional(),groupId:z.uuid().optional(),locationId:z.uuid().optional(),
  status:z.enum(['ACTIVE','INACTIVE','MISSING','DEAD']).optional(),stay:z.enum(['INSIDE','OUTSIDE','TRANSFERRED']).optional(),
  missing:z.enum(['any','identification',...reviewFields]).optional(),review:z.enum(['pending','dismissed']).optional()});

async function inventoryGrants(auth:AuthState){
  return (await pool.query(`SELECT DISTINCT ON(p.id) p.id,p.name,pr.id AS "roleId",
    ARRAY(SELECT permission_code FROM role_permission WHERE role_id=pr.id) AS permissions,
    ARRAY(SELECT module_code FROM effective_property_module WHERE property_id=p.id AND enabled) AS modules
    FROM property_membership pm JOIN property p ON p.id=pm.property_id AND p.status='ACTIVE' AND p.deleted_at IS NULL
    JOIN administrative_account aa ON aa.id=p.account_id AND aa.status='ACTIVE'
    JOIN membership_role mr ON mr.membership_id=pm.id AND mr.property_id=p.id
    JOIN property_role pr ON pr.id=mr.role_id AND pr.property_id=p.id AND pr.active
    WHERE pm.user_id=$1 AND membership_access_valid(pm)
      AND (p.id IS DISTINCT FROM $2::uuid OR pr.id=$3::uuid)
      AND EXISTS(SELECT 1 FROM role_permission WHERE role_id=pr.id AND permission_code='ANIMAL_VIEW')
    ORDER BY p.id,CASE pr.code WHEN 'OWNER' THEN 0 WHEN 'ADMINISTRATOR' THEN 1 ELSE 2 END,pr.id`,
    [auth.userId,auth.activePropertyId,auth.activeRoleId])).rows.map(row=>({...row,
      canGroups:row.permissions.includes('GROUP_VIEW')&&row.modules.some((module:string)=>['PASTURES','CORRALS'].includes(module)),
      canPhotos:row.permissions.includes('MEDIA_VIEW')&&row.modules.includes('MULTIMEDIA'),
      canPhotoEdit:row.permissions.includes('MEDIA_MANAGE')&&row.modules.includes('MULTIMEDIA'),canLocations:row.permissions.includes('LOCATION_VIEW'),canEdit:row.permissions.includes('ANIMAL_UPDATE')}));
}

export async function getInventory(auth:AuthState,filters:z.infer<typeof inventoryFilters>){
  // A selected role is respected for the active property; other properties use an explicitly returned eligible role.
  const grants=await inventoryGrants(auth);
  const selected=grants.filter(row=>!filters.propertyId||row.id===filters.propertyId);
  const options=(await pool.query(`SELECT p.id AS "propertyId",g.id AS "groupId",g.name AS "groupName",g.kind,
    pl.id AS "locationId",pl.name AS "locationName",pl.kind AS "locationKind"
    FROM property p LEFT JOIN livestock_group g ON g.property_id=p.id AND g.active
    LEFT JOIN group_location_assignment gla ON gla.group_id=g.id AND gla.ended_at IS NULL
    LEFT JOIN physical_location pl ON pl.id=gla.location_id AND pl.active WHERE p.id=ANY($1::uuid[])
    ORDER BY p.name,g.name`,[selected.map(row=>row.id)])).rows;
  const cte=`WITH allowed AS (SELECT * FROM jsonb_to_recordset($1::jsonb)
      AS r(id uuid,name text,"roleId" uuid,"canGroups" boolean,"canLocations" boolean,"canEdit" boolean,"canPhotos" boolean,"canPhotoEdit" boolean,modules jsonb)),
    principal AS (SELECT DISTINCT ON(a.identity_id) a.* FROM latest_property_animal a JOIN allowed p ON p.id=a.property_id
      ORDER BY a.identity_id,(a.transferred_out_at IS NULL) DESC,a.created_at DESC,a.id DESC),
    records AS (SELECT a.id,a.name,a.ear_tag_code AS "earTagCode",a.birth_date::text AS "birthDate",a.availability_status_code AS status,
      p.id AS "propertyId",p.name AS "propertyName",p."roleId",p."canEdit" AND a.transferred_out_at IS NULL AS "canEdit",p."canPhotoEdit" AND a.transferred_out_at IS NULL AS "canPhotoEdit",
      CASE WHEN p."canPhotos" THEN (SELECT so.provider_asset_id FROM media_attachment ma JOIN storage_object so ON so.id=ma.storage_object_id AND so.status='AVAILABLE'
        WHERE ma.entity_type='ANIMAL' AND ma.entity_id=a.id AND ma.relation_code='PROFILE' AND ma.deleted_at IS NULL AND so.kind='IMAGE' ORDER BY ma.created_at DESC LIMIT 1) END AS "profilePhotoAsset",
      ARRAY(SELECT field_code FROM animal_data_review WHERE property_id=p.id AND identity_id=a.identity_id AND dismissed) AS "dismissedFields",
      array_remove(ARRAY[CASE WHEN p."canPhotos" AND NOT EXISTS(SELECT 1 FROM media_attachment ma JOIN storage_object so ON so.id=ma.storage_object_id AND so.status='AVAILABLE' AND so.kind='IMAGE'
          WHERE ma.entity_type='ANIMAL' AND ma.entity_id=a.id AND ma.relation_code='PROFILE' AND ma.deleted_at IS NULL) THEN 'photo' END,
        CASE WHEN nullif(btrim(a.name),'') IS NULL THEN 'name' END,
        CASE WHEN a.ear_tag_code IS NULL THEN 'earTag' END,CASE WHEN a.birth_date IS NULL THEN 'birthDate' END,
        CASE WHEN a.entry_date IS NULL THEN 'entryDate' END,
        CASE WHEN NOT EXISTS(SELECT 1 FROM animal_ownership o WHERE o.animal_id=a.id AND o.valid_until IS NULL) THEN 'owners' END,
        CASE WHEN a.availability_status_code='ACTIVE' AND p."canGroups" AND p."canLocations" AND pos.location_id IS NULL AND g.kind IS DISTINCT FROM 'EXTERNAL' THEN 'location' END],NULL) AS "missingCandidates",
      CASE WHEN a.transferred_out_at IS NOT NULL THEN 'TRANSFERRED' WHEN NOT p."canGroups" THEN 'UNKNOWN' WHEN g.kind='EXTERNAL' THEN 'OUTSIDE' ELSE 'INSIDE' END AS stay,
      CASE WHEN p."canGroups" THEN g.name END AS "groupName",CASE WHEN p."canGroups" THEN g.id END AS "groupId",
      CASE WHEN p."canLocations" AND p.modules ? CASE pos.location_kind WHEN 'PASTURE' THEN 'PASTURES' ELSE 'CORRALS' END THEN pos.location_name END AS "locationName",
      CASE WHEN p."canLocations" AND p.modules ? CASE pos.location_kind WHEN 'PASTURE' THEN 'PASTURES' ELSE 'CORRALS' END THEN pos.location_id END AS "locationId",
      CASE WHEN p."canGroups" THEN g.external_place END AS "externalPlace",
      array_remove(ARRAY[CASE WHEN a.birth_date IS NULL THEN 'birthDate' END,
        CASE WHEN a.ear_tag_code IS NULL AND NOT EXISTS(SELECT 1 FROM animal_brand_assignment b WHERE b.animal_id=a.id AND b.ended_at IS NULL) THEN 'identification' END,
        CASE WHEN NOT EXISTS(SELECT 1 FROM animal_ownership o WHERE o.animal_id=a.id AND o.valid_until IS NULL) THEN 'owners' END,
        CASE WHEN a.availability_status_code='ACTIVE' AND p."canGroups" AND p."canLocations"
          AND pos.location_id IS NULL AND g.kind IS DISTINCT FROM 'EXTERNAL' THEN 'location' END],NULL) AS "legacyMissing"
    FROM principal a JOIN allowed p ON p.id=a.property_id
    LEFT JOIN animal_current_position pos ON pos.animal_id=a.id AND pos.property_id=p.id
    LEFT JOIN livestock_group g ON g.id=pos.group_id
    WHERE ($2='' OR strpos(lower(a.name),lower($2))>0 OR strpos(lower(coalesce(a.ear_tag_code::text,'')),lower($2))>0)
      AND ($3::varchar IS NULL OR a.availability_status_code=$3)),
    reviewed AS (SELECT *,ARRAY(SELECT field FROM unnest(CASE WHEN $9::text IS NULL THEN "legacyMissing" ELSE "missingCandidates" END) field
      WHERE CASE WHEN $9='dismissed' THEN field=ANY("dismissedFields") ELSE NOT(CASE field WHEN 'identification' THEN 'earTag' ELSE field END=ANY("dismissedFields")) END) AS missing FROM records),
    filtered AS (SELECT * FROM reviewed WHERE ($4::uuid IS NULL OR "groupId"=$4) AND ($5::uuid IS NULL OR "locationId"=$5)
      AND ($6::text IS NULL OR stay=$6)),
    pending AS (SELECT * FROM filtered WHERE $7::text IS NULL OR $7='any' AND cardinality(missing)>0 OR $7=ANY(missing))`;
  const result=(await pool.query(`${cte} SELECT (SELECT count(*)::int FROM pending) AS total,
    (SELECT count(*)::int FROM filtered WHERE cardinality(missing)>0) AS "pendingCount",
    COALESCE((SELECT json_agg(row) FROM (SELECT * FROM pending ORDER BY lower(name),id LIMIT 50 OFFSET $8) row),'[]'::json) AS items`,
    [JSON.stringify(selected),filters.search,filters.status??null,filters.groupId??null,filters.locationId??null,filters.stay??null,filters.missing??(filters.review?'any':null),(filters.page-1)*50,filters.review??null])).rows[0]!;
  const groups=options.filter(row=>selected.find(grant=>grant.id===row.propertyId)?.canGroups&&row.groupId).map(row=>({id:row.groupId,name:row.groupName,propertyId:row.propertyId}));
  const locations=options.filter(row=>{const grant=selected.find(grant=>grant.id===row.propertyId);return grant?.canLocations&&row.locationId&&grant.modules.includes(row.locationKind==='PASTURE'?'PASTURES':'CORRALS');})
    .filter((row,index,rows)=>rows.findIndex(other=>other.locationId===row.locationId)===index)
    .map(row=>({id:row.locationId,name:row.locationName,propertyId:row.propertyId}));
  const items=result.items.map((row:Record<string,any>)=>{const {profilePhotoAsset,missingCandidates,legacyMissing,...item}=row;
    return {...item,profilePhotoUrl:animalProfilePhotoUrl(profilePhotoAsset??null)};});
  return {...result,items,page:filters.page,pageSize:50,properties:grants.map(row=>({id:row.id,name:row.name,roleId:row.roleId})),groups,locations};
}
export const inventoryRouter=Router();inventoryRouter.use(authenticate);
inventoryRouter.get('/',asyncHandler(async(req,res)=>res.json({ok:true,data:await getInventory(req.auth!,inventoryFilters.parse(req.query))})));

export async function reviewAnimalData(auth:AuthState,id:string,input:z.infer<typeof reviewInput>,metadata:{ipAddress:string|null;userAgent:string|null}){
  const grants=await inventoryGrants(auth);
  return inTransaction(async client=>{
    const animal=(await client.query(`SELECT property_id,identity_id,transferred_out_at FROM animal WHERE id=$1 AND record_status='CURRENT' FOR UPDATE`,[id])).rows[0];
    const grant=grants.find(row=>row.id===animal?.property_id);
    if(!animal||!grant)throw new ApiError(404,'ANIMAL_NOT_FOUND','El animal no está disponible para este usuario.');
    const allowed=await client.query(`SELECT 1 FROM property_membership pm JOIN property p ON p.id=pm.property_id AND p.status='ACTIVE' AND p.deleted_at IS NULL
      JOIN administrative_account aa ON aa.id=p.account_id AND aa.status='ACTIVE'
      JOIN membership_role mr ON mr.membership_id=pm.id AND mr.property_id=p.id
      JOIN property_role pr ON pr.id=mr.role_id AND pr.active AND pr.property_id=p.id
      WHERE p.id=$1 AND pm.user_id=$2 AND pr.id=$3 AND membership_access_valid(pm)
        AND EXISTS(SELECT 1 FROM role_permission WHERE role_id=pr.id AND permission_code='ANIMAL_UPDATE')
        AND EXISTS(SELECT 1 FROM role_permission WHERE role_id=pr.id AND permission_code='ANIMAL_VIEW') FOR SHARE OF pm,pr,p,aa`,[animal.property_id,auth.userId,grant.roleId]);
    if(!allowed.rowCount)throw forbidden('ANIMAL_UPDATE_DENIED','Tu rol no permite descartar datos de este animal.');
    if(animal.transferred_out_at)throw conflict('ANIMAL_TRANSFERRED','La ficha de origen permanece archivada.');
    if(input.fields.includes('photo')&&!grant.canPhotos||input.fields.includes('location')&&(!grant.canGroups||!grant.canLocations))
      throw forbidden('PERMISSION_DENIED','Tu rol no permite revisar ese dato.');
    const before=(await client.query('SELECT field_code,dismissed FROM animal_data_review WHERE property_id=$1 AND identity_id=$2 AND field_code=ANY($3::varchar[])',
      [animal.property_id,animal.identity_id,input.fields])).rows;
    await client.query(`INSERT INTO animal_data_review(property_id,identity_id,field_code,dismissed,reviewed_by)
      SELECT $1,$2,unnest($3::varchar[]),$4,$5 ON CONFLICT(property_id,identity_id,field_code) DO UPDATE
      SET dismissed=excluded.dismissed,reviewed_by=excluded.reviewed_by,reviewed_at=now()`,[animal.property_id,animal.identity_id,input.fields,input.dismissed,auth.userId]);
    await client.query(`INSERT INTO audit_event(actor_user_id,property_id,active_role_id,action,entity_type,entity_id,before_data,after_data,ip_address,user_agent)
      VALUES($1,$2,$3,'ANIMAL_DATA_REVIEWED','ANIMAL',$4,$5::jsonb,$6::jsonb,$7,$8)`,
      [auth.userId,animal.property_id,grant.roleId,id,JSON.stringify(before),JSON.stringify(input),metadata.ipAddress,metadata.userAgent]);
    return {reviewed:true};
  });
}
inventoryRouter.patch('/:id/data-review',asyncHandler(async(req,res)=>{
  const {id}=z.object({id:z.uuid()}).parse(req.params);
  res.json({ok:true,data:await reviewAnimalData(req.auth!,id,reviewInput.parse(req.body),{ipAddress:req.ip??null,userAgent:req.header('user-agent')?.slice(0,1000)??null})});
}));
