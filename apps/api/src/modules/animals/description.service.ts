import {superadminPropertyAccess} from '../auth/superadmin-access.js';
import { ApiError, conflict, forbidden, invalidRequest } from '../../core/errors.js';
import { inTransaction } from '../../database/transaction.js';
import type { AuthState, PropertyContext, RequestMetadata } from '../auth/auth.types.js';
import { readAnimal } from './animals.service.js';
import type {UpdateAnimalDetailsInput} from './animals.schemas.js';
import {validateParentAge} from '../reproduction/reproduction.rules.js';

export async function updateAnimalDescription(auth: AuthState, context: PropertyContext, id: string,
  input: { description: string | null; expectedVersion: number }, metadata: RequestMetadata) {
  return updateAnimalDetails(auth,context,id,input,metadata);
}

export async function updateAnimalDetails(auth: AuthState, context: PropertyContext, id: string,
  input: UpdateAnimalDetailsInput | {description:string|null;expectedVersion:number}, metadata: RequestMetadata) {
  return inTransaction(async (client) => {
    const supportGrant=await superadminPropertyAccess(client,auth,context);
    const grant=supportGrant?{rows:[supportGrant],rowCount:1}:await client.query(
      `SELECT 1 FROM property p
       JOIN administrative_account aa ON aa.id = p.account_id AND aa.status = 'ACTIVE'
       JOIN property_membership pm ON pm.property_id = p.id AND pm.user_id = $2 AND pm.status = 'ACTIVE'
       JOIN membership_role mr ON mr.membership_id = pm.id AND mr.property_id = p.id
       JOIN property_role pr ON pr.id = mr.role_id AND pr.property_id = p.id AND pr.active
       JOIN role_permission rp ON rp.role_id = pr.id AND rp.permission_code = 'ANIMAL_UPDATE'
       WHERE p.id = $1 AND pr.id = $3 AND p.deleted_at IS NULL AND p.status = 'ACTIVE'
       FOR SHARE OF p, pm, pr`,
      [context.propertyId, auth.userId, context.roleId],
    );
    if (!grant.rowCount) throw forbidden('ANIMAL_UPDATE_DENIED', 'El rol activo no permite modificar este animal.');
    const locked = await client.query<{ version: string }>(
      `SELECT version::text AS version FROM animal WHERE property_id = $1 AND id = $2
       AND record_status = 'CURRENT' FOR UPDATE`, [context.propertyId, id],
    );
    if (!locked.rows[0]) throw new ApiError(404, 'ANIMAL_NOT_FOUND', 'El animal no está disponible en esta propiedad.');
    if (Number(locked.rows[0].version) !== input.expectedVersion) {
      throw conflict('ANIMAL_VERSION_CONFLICT', 'El animal cambió. Actualiza su ficha antes de guardar.');
    }
    const before = await readAnimal(client, context, id);
    if(before.transferredOutAt)throw conflict('ANIMAL_TRANSFERRED','La ficha de origen queda conservada. Edita el animal en la propiedad donde está activo.');
    const description = input.description || null;
    if ('name' in input) {
      const today=(await client.query<{today:string}>(`SELECT (now() AT TIME ZONE timezone)::date::text AS today
        FROM property WHERE id=$1`,[context.propertyId])).rows[0]!.today;
      if(input.entryDate>today||input.birthDate&&(input.birthDate>today||input.birthDate>input.entryDate))
        throw invalidRequest('ANIMAL_DATES_INVALID','El nacimiento debe ser anterior al ingreso y las fechas no pueden ser futuras.');
      if(input.sex!==before.sex){
        if(before.hasReproductiveHistory)throw invalidRequest('ANIMAL_SEX_HAS_HISTORY','El historial de reproducción recibido impide cambiar el sexo.');
        const related=await client.query(`SELECT 1 WHERE
          EXISTS(SELECT 1 FROM animal_parentage WHERE parent_animal_id=$1 AND removed_at IS NULL)
          OR EXISTS(SELECT 1 FROM reproduction_heat WHERE cow_id=$1 OR bull_id=$1)
          OR EXISTS(SELECT 1 FROM reproduction_service WHERE cow_id=$1 OR father_id=$1 OR donor_id=$1)
          OR EXISTS(SELECT 1 FROM reproduction_pregnancy WHERE cow_id=$1 OR father_id=$1)`,[id]);
        if(related.rowCount)throw invalidRequest('ANIMAL_SEX_HAS_HISTORY','No se puede cambiar el sexo mientras existan registros de reproducción o crías vinculadas.');
      }
      if(input.birthDate!==before.birthDate){
        if(before.registeredBirthDate&&input.birthDate!==before.registeredBirthDate)throw invalidRequest('ANIMAL_BIRTH_HAS_HISTORY','La fecha de nacimiento debe coincidir con el parto en el que nació.');
        const birth=await client.query(`SELECT 1 FROM reproduction_birth_calf calf
          JOIN reproduction_birth birth ON birth.id=calf.birth_id
          WHERE calf.animal_id=$1 AND birth.occurred_on IS DISTINCT FROM $2::date`,[id,input.birthDate]);
        if(birth.rowCount)throw invalidRequest('ANIMAL_BIRTH_HAS_HISTORY','La fecha de nacimiento debe coincidir con el parto en el que nació.');
        for(const [role,parent] of [['MOTHER',before.mother],['FATHER',before.father]] as const)
          if(parent?.animalId)await validateParentAge(client,context.propertyId,parent.animalId,role,input.birthDate);
      }
      if(input.groupId!==before.group?.id){
        const group=(await client.query<{location_id:string|null}>(`SELECT gla.location_id FROM livestock_group g
          LEFT JOIN group_location_assignment gla ON gla.group_id=g.id AND gla.ended_at IS NULL
          LEFT JOIN physical_location pl ON pl.id=gla.location_id AND pl.active
          WHERE g.id=$1 AND g.property_id=$2 AND g.active AND (g.kind='EXTERNAL' OR pl.id IS NOT NULL) FOR UPDATE OF g`,
          [input.groupId,context.propertyId])).rows[0];
        if(!group)throw invalidRequest('GROUP_UNAVAILABLE','Selecciona un grupo activo con potrero o corral de esta propiedad.');
        // Preserve the assignments when correcting the animal's current group.
        for(const table of ['animal_group_assignment','animal_location_assignment'])
          await client.query(`UPDATE ${table} SET ended_at=GREATEST(now(),started_at),end_reason='Corrección de ficha'
            WHERE animal_id=$1 AND ended_at IS NULL`,[id]);
        await client.query(`INSERT INTO animal_group_assignment(property_id,animal_id,group_id,started_at,start_reason,created_by)
          VALUES($1,$2,$3,now(),'Corrección de ficha',$4)`,[context.propertyId,id,input.groupId,auth.userId]);
        if(group.location_id)await client.query(`INSERT INTO animal_location_assignment(property_id,animal_id,location_id,started_at,start_reason,created_by)
          VALUES($1,$2,$3,now(),'Corrección de ficha',$4)`,[context.propertyId,id,group.location_id,auth.userId]);
      }
      await client.query(`UPDATE animal SET name=$2,description=$3,sex=$4,ear_tag_code=$5,
        birth_date=$6,entry_date=$7,initial_weight=$8,initial_weight_unit_code=$9,updated_by=$10 WHERE id=$1`,
        [id,input.name,description,input.sex,input.earTagCode,input.birthDate,input.entryDate,input.initialWeight,input.initialWeightUnitCode,auth.userId]);
    } else {
      if (before.description === description) return before;
      await client.query(`UPDATE animal SET description = $2, updated_by = $3 WHERE id = $1`,
        [id, description, auth.userId]);
    }
    const after = await readAnimal(client, context, id);
    await client.query(
      `INSERT INTO audit_event(actor_user_id, property_id, active_role_id, action, entity_type,
         entity_id, before_data, after_data, ip_address, user_agent)
       VALUES($1,$2,$3,$9,'ANIMAL',$4,$5::jsonb,$6::jsonb,$7,$8)`,
      [auth.userId, context.propertyId, context.roleId, id, JSON.stringify(before),
        JSON.stringify(after), metadata.ipAddress, metadata.userAgent,'name' in input?'ANIMAL_DETAILS_UPDATED':'ANIMAL_DESCRIPTION_UPDATED'],
    );
    return after;
  }).catch((error:unknown)=>{
    const db=error as {code?:string;constraint?:string};
    if(db.code==='23505'&&db.constraint==='animal_tag_per_property_unique')
      throw conflict('ANIMAL_TAG_TAKEN','Ya existe un animal con ese arete individual en la propiedad.');
    if(db.code==='23514'||db.code==='23503')throw invalidRequest('ANIMAL_DETAILS_INVALID','Revisa las fechas, la unidad de peso y las relaciones del animal.');
    throw error;
  });
}
