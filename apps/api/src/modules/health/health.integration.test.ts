import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {pool} from '../../database/pool.js';
import {register,login,verifyEmail,resendEmailVerification,getSessionOverview} from '../auth/auth.service.js';
import {createAnimal} from '../animals/animals.service.js';
import {assignAnimalToGroup,createGroup} from '../groups/groups.service.js';
import {applyCampaign,cancelCampaign,createCampaign,createMedicine,listCampaigns,
  listHealthOptions,listMedicines,updateCampaign} from './health.service.js';

const metadata={ipAddress:'127.0.0.1',userAgent:'sgb-health-test'};
test('sanidad respeta propiedad, dosis, selección, borradores y aplicación única',async()=>{
  const suffix=randomUUID();const email=`health-${suffix}@example.test`;
  try{
    const registration=await register({email,password:'Clave-segura-2026',
      displayName:'Prueba sanidad',propertyName:`Finca sanitaria ${suffix}`},metadata);
    await pool.query(`UPDATE email_verification_token SET created_at=now()-interval '2 minutes'
      WHERE user_id=$1`,[registration.userId]);
    await verifyEmail((await resendEmailVerification(email,metadata)).verificationToken!,metadata);
    const session=await login({email,password:'Clave-segura-2026',deviceId:`health-${suffix}`},metadata);
    const overview=await getSessionOverview({sessionId:session.sessionId,userId:session.user.id,
      email:session.user.email,displayName:session.user.displayName,isSuperadmin:false,
      activePropertyId:session.activePropertyId,activeRoleId:session.activeRoleId});
    const property=overview.properties[0]!;
    const role=property.roles.find((item)=>item.code==='OWNER')!;
    assert.ok(role.permissions.includes('HEALTH_MANAGE'));
    const auth={sessionId:session.sessionId,userId:session.user.id,email:session.user.email,
      displayName:session.user.displayName,isSuperadmin:false,
      activePropertyId:property.id,activeRoleId:role.id};
    const context={propertyId:property.id,propertyName:property.name,roleId:role.id,
      roleCode:role.code,roleName:role.name,permissions:new Set(role.permissions),
      enabledModules:new Set(property.enabledModules),enabledSpecies:new Set(property.enabledSpecies)};
    const first=await createAnimal(auth,context,{name:'Vaca vacunada',sex:'FEMALE',
      speciesCode:'BOVINE'},metadata);
    const second=await createAnimal(auth,context,{name:'Vaca en grupo',sex:'FEMALE',
      speciesCode:'BOVINE'},metadata);
    const group=await createGroup(auth,context,{name:'Grupo sanitario'},metadata);
    await assignAnimalToGroup(auth,context,group.id,{animalId:first.id,
      expectedAnimalVersion:first.version},metadata);
    await assignAnimalToGroup(auth,context,group.id,{animalId:second.id,
      expectedAnimalVersion:second.version},metadata);
    const medicine=await createMedicine(auth,context,{name:'Vacuna de prueba',kind:'VACUNA',
      defaultUnitCode:'MILLILITER',withdrawalMilkDays:2,withdrawalMeatDays:7},metadata);
    assert.equal(medicine.withdrawalMilkDays,2);
    assert.equal((await listMedicines(context)).length,1);
    const options=await listHealthOptions(context);
    assert.equal(options.animals.length,2);
    const today=(await pool.query<{today:string}>(`SELECT (now() AT TIME ZONE timezone)::date::text
      AS today FROM property WHERE id=$1`,[property.id])).rows[0]!.today;
    const base={medicineId:medicine.id as string,administrationRoute:'INTRAMUSCULAR' as const,
      appliedOn:today,selectionMode:'GRUPO' as const,groupId:group.id,
      animals:[first.id,second.id].map((animalId)=>({animalId,selected:true,
        dose:2,unitCode:'MILLILITER' as const}))};
    await assert.rejects(()=>createCampaign(auth,context,{...base,
      animals:[{...base.animals[0]!,unitCode:'GRAM'}]},metadata),
      (error:{code?:string})=>error.code==='HEALTH_UNIT_INVALID');
    const created=await createCampaign(auth,context,base,metadata);
    assert.equal(created.status,'BORRADOR');
    assert.equal(created.animals.length,2);
    const updated=await updateCampaign(auth,context,created.id,{...base,
      expectedVersion:created.version,animals:[{...base.animals[0]!,dose:3},base.animals[1]!]},metadata);
    assert.equal(updated.version,created.version+1);
    const applied=await applyCampaign(auth,context,created.id,metadata);
    assert.equal(applied.status,'COMPLETADO');
    assert.equal(applied.animals[0]?.dose,3);
    await assert.rejects(()=>applyCampaign(auth,context,created.id,metadata),
      (error:{code?:string})=>error.code==='HEALTH_CAMPAIGN_FINAL');
    const cancelled=await createCampaign(auth,context,{...base,selectionMode:'MANUAL',
      groupId:null,animals:[base.animals[1]!]},metadata);
    await cancelCampaign(auth,context,cancelled.id,metadata);
    assert.equal((await listCampaigns(context)).length,2);
    assert.equal((await listCampaigns({...context,propertyId:randomUUID()})).length,0);
    const viewer=(await pool.query<{id:string}>(`SELECT id FROM property_role
      WHERE property_id=$1 AND code='VIEWER'`,[property.id])).rows[0]!;
    await assert.rejects(()=>createMedicine({...auth,activeRoleId:viewer.id},
      {...context,roleId:viewer.id},{name:'No permitida',kind:'OTRO',
        defaultUnitCode:'GRAM',withdrawalMilkDays:0,withdrawalMeatDays:0},metadata),
      (error:{code?:string})=>error.code==='HEALTH_DENIED');
  }finally{await pool.end();}
});
