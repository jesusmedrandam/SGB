import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {pool} from '../../database/pool.js';
import {getSessionOverview,login,register,resendEmailVerification,verifyEmail} from '../auth/auth.service.js';
import {createAnimal} from '../animals/animals.service.js';
import {createGroup} from '../groups/groups.service.js';
import {createWeighing,listWeighingOptions,listWeighings,updateWeighing,voidWeighing}
  from './weighings.service.js';

const metadata={ipAddress:'127.0.0.1',userAgent:'sgb-weighing-test'};
test('pesajes respetan finca, versión, unidades, auditoría y retención',async()=>{
  const suffix=randomUUID();const email=`weighing-${suffix}@example.test`;
  try{
    const registered=await register({email,password:'Clave-segura-2026',
      displayName:'Prueba pesajes',propertyName:`Finca pesajes ${suffix}`},metadata);
    await pool.query(`UPDATE email_verification_token SET created_at=now()-interval '2 minutes'
      WHERE user_id=$1`,[registered.userId]);
    await verifyEmail((await resendEmailVerification(email,metadata)).verificationToken!,metadata);
    const session=await login({email,password:'Clave-segura-2026',deviceId:`pesaje-${suffix}`},metadata);
    const overview=await getSessionOverview({sessionId:session.sessionId,userId:session.user.id,
      email:session.user.email,displayName:session.user.displayName,isSuperadmin:false,
      activePropertyId:session.activePropertyId,activeRoleId:session.activeRoleId});
    const property=overview.properties[0]!;const role=property.roles.find(item=>item.code==='OWNER')!;
    assert.ok(role.permissions.includes('WEIGHING_MANAGE'));
    const auth={sessionId:session.sessionId,userId:session.user.id,email:session.user.email,
      displayName:session.user.displayName,isSuperadmin:false,
      activePropertyId:property.id,activeRoleId:role.id};
    const context={propertyId:property.id,propertyName:property.name,roleId:role.id,
      roleCode:role.code,roleName:role.name,permissions:new Set(role.permissions),
      enabledModules:new Set(property.enabledModules),enabledSpecies:new Set(property.enabledSpecies)};
    await pool.query(`INSERT INTO account_module(account_id,module_code,enabled,configured_by)
      VALUES($1,'WEIGHING',true,$2) ON CONFLICT(account_id,module_code)
      DO UPDATE SET enabled=true`,[registered.accountId,auth.userId]);
    await pool.query(`INSERT INTO property_module(property_id,module_code,enabled,configured_by)
      VALUES($1,'WEIGHING',true,$2) ON CONFLICT(property_id,module_code)
      DO UPDATE SET enabled=true`,[property.id,auth.userId]);
    const group=await createGroup(auth,context,{name:'Lote de prueba'},metadata);
    const animal=await createAnimal(auth,context,{name:'Vaca pesada',sex:'FEMALE',
      speciesCode:'BOVINE',groupId:group.id},metadata);
    const date=(await pool.query<{today:string}>(`SELECT (now() AT TIME ZONE timezone)::date::text
      AS today FROM property WHERE id=$1`,[property.id])).rows[0]!.today;
    const input={animalId:animal.id,weighedOn:date,weight:100,unitCode:'POUND' as const,
      method:'Báscula',notes:null};
    assert.ok((await listWeighingOptions(context)).some(item=>item.id===animal.id));
    const created=await createWeighing(auth,context,input,metadata);
    assert.equal(created.weightKg,45.359);
    assert.equal((await listWeighings(context,animal.id)).length,1);
    assert.equal((await listWeighings({...context,propertyId:randomUUID()})).length,0);
    await assert.rejects(()=>updateWeighing(auth,context,created.id,
      {...input,expectedVersion:created.version+1},metadata),
      (error:{code?:string})=>error.code==='WEIGHING_STALE');
    const updated=await updateWeighing(auth,context,created.id,
      {...input,weight:110,expectedVersion:created.version},metadata);
    assert.equal(updated.weight,110);
    await assert.rejects(()=>pool.query(`DELETE FROM animal_weighing WHERE id=$1`,[created.id]),
      (error:{code?:string})=>error.code==='23514');
    const voided=await voidWeighing(auth,context,created.id,updated.version,metadata);
    assert.ok(voided.voidedAt);
    await assert.rejects(()=>voidWeighing(auth,context,created.id,voided.version,metadata),
      (error:{code?:string})=>error.code==='WEIGHING_VOIDED');
    assert.equal((await listWeighings(context,animal.id)).length,1);
    const audited=(await pool.query<{count:number}>(`SELECT count(*)::int AS count
      FROM audit_event WHERE entity_type='ANIMAL_WEIGHING' AND entity_id=$1`,[created.id])).rows[0];
    assert.equal(audited?.count,3);
  }finally{await pool.end();}
});
