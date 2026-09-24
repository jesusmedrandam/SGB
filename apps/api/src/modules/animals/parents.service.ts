import { ApiError, conflict, forbidden, invalidRequest } from '../../core/errors.js';
import { inTransaction } from '../../database/transaction.js';
import type {PoolClient} from 'pg';
import type { AuthState, PropertyContext, RequestMetadata } from '../auth/auth.types.js';
import type { ParentSelection } from './animals.schemas.js';
import { readAnimal } from './animals.service.js';

export async function insertInitialParents(client:PoolClient,context:PropertyContext,childId:string,
  birthDate:string|null,mother:ParentSelection,father:ParentSelection,userId:string){
  for(const [role,selection] of [['MOTHER',mother],['FATHER',father]] as const){
    if(!selection)continue;
    if('animalId' in selection){
      const parent=await client.query(`SELECT 1 FROM animal WHERE id=$1 AND property_id=$2
        AND record_status='CURRENT' AND sex=$3 AND id<>$4
        AND ($5::date IS NULL OR birth_date IS NULL OR birth_date<$5::date) FOR SHARE`,
        [selection.animalId,context.propertyId,role==='MOTHER'?'FEMALE':'MALE',childId,birthDate]);
      if(!parent.rowCount)throw invalidRequest('INVALID_ANIMAL_PARENT','El padre o la madre no es válido para este animal.');
    }
    await client.query(`INSERT INTO animal_parentage(property_id,child_animal_id,role,
      parent_animal_id,reported_parent_name,created_by) VALUES($1,$2,$3,$4,$5,$6)`,
      [context.propertyId,childId,role,'animalId' in selection?selection.animalId:null,
        'reportedName' in selection?selection.reportedName:null,userId]);
  }
}

export async function updateAnimalParents(auth: AuthState, context: PropertyContext, id: string,
  input: { mother: ParentSelection; father: ParentSelection; expectedVersion: number },
  metadata: RequestMetadata) {
  return inTransaction(async (client) => {
    const grant = await client.query(
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
    // Serializa las genealogías de la propiedad antes de comprobar ciclos.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('animal_parentage'), hashtext($1::text))`,
      [context.propertyId]);
    const locked = await client.query<{ version: string; species_code: string; birth_date: string | null }>(
      `SELECT version::text AS version, species_code, birth_date::text AS birth_date FROM animal
       WHERE id = $1 AND property_id = $2 AND record_status = 'CURRENT' FOR UPDATE`,
      [id, context.propertyId],
    );
    const child = locked.rows[0];
    if (!child) throw new ApiError(404, 'ANIMAL_NOT_FOUND', 'El animal no está disponible en esta propiedad.');
    if (Number(child.version) !== input.expectedVersion) {
      throw conflict('ANIMAL_VERSION_CONFLICT', 'El animal cambió. Actualiza su ficha antes de guardar.');
    }
    const before = await readAnimal(client, context, id);
    const requested = [['MOTHER', input.mother], ['FATHER', input.father]] as const;
    const unchanged = (role: 'MOTHER' | 'FATHER', chosen: ParentSelection) => {
      const current = role === 'MOTHER' ? before.mother : before.father;
      return !chosen ? !current : 'animalId' in chosen
        ? current?.animalId === chosen.animalId
        : current?.animalId === null && current.name === chosen.reportedName;
    };
    if (requested.every(([role, chosen]) => unchanged(role, chosen))) return before;
    for (const [role, chosen] of requested) {
      if (!chosen || !('animalId' in chosen) || unchanged(role, chosen)) continue;
      const parent = await client.query<{ id: string }>(
        `SELECT id FROM animal WHERE id = $1 AND property_id = $2
         AND species_code = $3 AND sex = $4 AND record_status = 'CURRENT'
         AND id <> $5 AND ($6::date IS NULL OR birth_date IS NULL OR birth_date < $6::date)
         FOR SHARE`,
        [chosen.animalId, context.propertyId, child.species_code,
          role === 'MOTHER' ? 'FEMALE' : 'MALE', id, child.birth_date],
      );
      if (!parent.rowCount) throw invalidRequest('INVALID_ANIMAL_PARENT',
        `El ${role === 'MOTHER' ? 'animal madre' : 'animal padre'} no es válido para esta cría.`);
    }
    for (const [role, chosen] of requested) {
      if (unchanged(role, chosen)) continue;
      await client.query(
        `UPDATE animal_parentage SET removed_at = now(), removed_by = $3,
           removal_reason = 'Corrección de parentesco'
         WHERE child_animal_id = $1 AND property_id = $2 AND role = $4 AND removed_at IS NULL`,
        [id, context.propertyId, auth.userId, role],
      );
      if (chosen) {
        await client.query(
          `INSERT INTO animal_parentage(property_id, child_animal_id, role,
             parent_animal_id, reported_parent_name, created_by)
           VALUES($1,$2,$3,$4,$5,$6)`,
          [context.propertyId, id, role, 'animalId' in chosen ? chosen.animalId : null,
            'reportedName' in chosen ? chosen.reportedName : null, auth.userId],
        );
      }
    }
    await client.query(`UPDATE animal SET updated_by = $2 WHERE id = $1`, [id, auth.userId]);
    const after = await readAnimal(client, context, id);
    await client.query(
      `INSERT INTO audit_event(actor_user_id, property_id, active_role_id, action, entity_type,
         entity_id, before_data, after_data, ip_address, user_agent)
       VALUES($1,$2,$3,'ANIMAL_PARENTS_UPDATED','ANIMAL',$4,$5::jsonb,$6::jsonb,$7,$8)`,
      [auth.userId, context.propertyId, context.roleId, id, JSON.stringify(before),
        JSON.stringify(after), metadata.ipAddress, metadata.userAgent],
    );
    return after;
  }).catch((error: unknown) => {
    if ((error as { code?: string }).code === '23514') {
      throw invalidRequest('INVALID_ANIMAL_PARENT', 'El parentesco no es válido o crearía un ciclo.');
    }
    throw error;
  });
}
