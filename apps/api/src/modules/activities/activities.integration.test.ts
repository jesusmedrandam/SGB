import {inTransaction} from '../../database/transaction.js';
import {expireDrafts} from '../../core/drafts.js';
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

    const expires=await createActivity(auth,context,{kind:'DESCORNE',title:'Borrador temporal',occurredOn:today,animalIds:[other.id]},metadata);
    // Test clock fixture: creation timestamps are immutable through normal application writes.
    await inTransaction(async client=>{await client.query('SET LOCAL session_replication_role=replica');await client.query("UPDATE livestock_activity SET created_at=now()-interval '24 hours' WHERE id=$1",[expires.id]);});
    assert.equal((await listActivities(context)).some(row=>row.id===expires.id),false,'Expired drafts disappear at the 24-hour boundary');
    await assert.rejects(()=>applyActivity(auth,context,expires.id,metadata),(error:{code?:string})=>error.code==='DRAFT_EXPIRED');
    assert.ok(await expireDrafts()>=1);
    assert.ok((await pool.query('SELECT expired_at FROM livestock_activity WHERE id=$1',[expires.id])).rows[0].expired_at);
    assert.equal((await pool.query("SELECT count(*)::int AS total FROM audit_event WHERE entity_id=$1 AND action LIKE '%DRAFT_EXPIRED'",[expires.id])).rows[0].total,1);
    assert.equal(await expireDrafts(),0,'Expiration is idempotent');
    assert.equal((await pool.query('SELECT expired_at FROM livestock_activity WHERE id=$1',[applied.id])).rows[0].expired_at,null,'Applied records survive');
  }finally{await pool.end();}
});
