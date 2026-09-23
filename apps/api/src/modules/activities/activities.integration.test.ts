import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {pool} from '../../database/pool.js';
import {getSessionOverview,login,register,resendEmailVerification,verifyEmail} from '../auth/auth.service.js';
import {createAnimal,getAnimal} from '../animals/animals.service.js';
import {createBrand} from '../animals/brands.service.js';
import {applyActivity,cancelActivity,createActivity,listActivities,listActivityOptions,
  updateActivity} from './activities.service.js';

const metadata={ipAddress:'127.0.0.1',userAgent:'sgb-activity-test'};
test('actividades aplican herraje una vez, conservan historial y respetan la propiedad',async()=>{
  const suffix=randomUUID();const email=`activity-${suffix}@example.test`;
  try{
    const registration=await register({email,password:'Clave-segura-2026',
      displayName:'Prueba actividades',propertyName:`Finca actividad ${suffix}`},metadata);
    await pool.query(`UPDATE email_verification_token SET created_at=now()-interval '2 minutes'
      WHERE user_id=$1`,[registration.userId]);
    await verifyEmail((await resendEmailVerification(email,metadata)).verificationToken!,metadata);
    const session=await login({email,password:'Clave-segura-2026',deviceId:`activity-${suffix}`},metadata);
    const overview=await getSessionOverview({sessionId:session.sessionId,userId:session.user.id,
      email:session.user.email,displayName:session.user.displayName,isSuperadmin:false,
      activePropertyId:session.activePropertyId,activeRoleId:session.activeRoleId});
    const property=overview.properties[0]!;
    const role=property.roles.find((entry)=>entry.code==='OWNER')!;
    assert.ok(role.permissions.includes('ACTIVITY_MANAGE'));
    const auth={sessionId:session.sessionId,userId:session.user.id,email:session.user.email,
      displayName:session.user.displayName,isSuperadmin:false,
      activePropertyId:property.id,activeRoleId:role.id};
    const context={propertyId:property.id,propertyName:property.name,roleId:role.id,
      roleCode:role.code,roleName:role.name,permissions:new Set(role.permissions),
      enabledModules:new Set(property.enabledModules),enabledSpecies:new Set(property.enabledSpecies)};
    await pool.query(`INSERT INTO account_module(account_id,module_code,enabled,configured_by)
      VALUES($1,'TASKS',true,$2) ON CONFLICT(account_id,module_code)
      DO UPDATE SET enabled=true`,[registration.accountId,auth.userId]);
    await pool.query(`INSERT INTO property_module(property_id,module_code,enabled,configured_by)
      VALUES($1,'TASKS',true,$2) ON CONFLICT(property_id,module_code)
      DO UPDATE SET enabled=true`,[property.id,auth.userId]);
    const first=await createAnimal(auth,context,{name:'Vaca herraje',sex:'FEMALE',
      speciesCode:'BOVINE'},metadata);
    const other=await createAnimal(auth,context,{name:'Becerro descorne',sex:'MALE',
      speciesCode:'BOVINE'},metadata);
    const brand=await createBrand(auth,context,`Fierro ${suffix}`,metadata);
    assert.equal((await listActivityOptions(context)).brands.length,1);
    const today=(await pool.query<{today:string}>(`SELECT (now() AT TIME ZONE timezone)::date::text
      AS today FROM property WHERE id=$1`,[property.id])).rows[0]!.today;
    const base={kind:'HERRAJE' as const,title:'Herraje del lote',occurredOn:today,
      brandId:brand.id,animalIds:[first.id,other.id]};
    await assert.rejects(()=>createActivity(auth,context,{...base,brandId:randomUUID()},metadata),
      (error:{code?:string})=>error.code==='ACTIVITY_BRAND_INVALID');
    const created=await createActivity(auth,context,base,metadata);
    assert.equal(created.status,'BORRADOR');
    assert.equal((await getAnimal(context,first.id)).brands.length,0);
    const updated=await updateActivity(auth,context,created.id,{...base,
      expectedVersion:created.version,description:'Fierro aplicado'},metadata);
    assert.equal(updated.version,created.version+1);
    const applied=await applyActivity(auth,context,created.id,metadata);
    assert.equal(applied.status,'COMPLETADA');
    assert.equal((await getAnimal(context,first.id)).brands[0]?.id,brand.id);
    assert.equal((await getAnimal(context,other.id)).brands[0]?.id,brand.id);
    await assert.rejects(()=>applyActivity(auth,context,created.id,metadata),
      (error:{code?:string})=>error.code==='ACTIVITY_FINAL');
    const second=await createActivity(auth,context,{kind:'DESCORNE',title:'Descorne',
      occurredOn:today,animalIds:[other.id]},metadata);
    await cancelActivity(auth,context,second.id,metadata);
    assert.equal((await listActivities(context)).length,2);
    assert.equal((await listActivities({...context,propertyId:randomUUID()})).length,0);
    const viewer=(await pool.query<{id:string}>(`SELECT id FROM property_role
      WHERE property_id=$1 AND code='VIEWER'`,[property.id])).rows[0]!;
    await assert.rejects(()=>createActivity({...auth,activeRoleId:viewer.id},
      {...context,roleId:viewer.id},base,metadata),
      (error:{code?:string})=>error.code==='ACTIVITY_DENIED');
  }finally{await pool.end();}
});
