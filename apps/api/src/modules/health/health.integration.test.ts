import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {pool} from '../../database/pool.js';
import {register,login,verifyEmail,resendEmailVerification,getSessionOverview} from '../auth/auth.service.js';
import {createAnimal} from '../animals/animals.service.js';
import {assignAnimalToGroup,createGroup} from '../groups/groups.service.js';
import {createCatalogItem,listCatalogItems} from '../catalogs/catalogs.service.js';
import {createAccountProperty} from '../properties/properties.service.js';
import {createWeighing,voidWeighing} from '../weighings/weighings.service.js';
import {medicineSchema} from './health.schemas.js';
import {applyCampaign,cancelCampaign,createCampaign,createMedicine,listCampaigns,
  listHealthOptions,listMedicines,updateCampaign,updateMedicine,listConditionTreatments} from './health.service.js';
import {createCondition,listConditions,resolveCondition,updateCondition} from './conditions.service.js';

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
    const condition=await createCondition(auth,context,{animalId:first.id,kind:'Herida',
      detectedOn:today,description:'Lesión en una extremidad'},metadata);
    await createCatalogItem(auth,context,'HEALTH_CONDITION_TYPES',{name:'Herida leve'},metadata);
    const changedCondition=await updateCondition(auth,context,condition.id,{animalId:first.id,
      kind:'Herida leve',detectedOn:today,description:'Herida revisada',
      expectedVersion:condition.version},metadata);
    await assert.rejects(()=>updateCondition(auth,context,condition.id,{animalId:second.id,
      kind:'Herida leve',detectedOn:today,description:'Otro animal'},metadata),
      (error:{code?:string})=>error.code==='HEALTH_ANIMAL_IMMUTABLE');
    const base={medicineId:medicine.id as string,administrationRoute:'INTRAMUSCULAR' as const,
      appliedOn:today,selectionMode:'GRUPO' as const,groupId:group.id,
      animals:[first.id,second.id].map((animalId)=>({animalId,selected:true,
        dose:2,unitCode:'MILLILITER' as const,
        conditionId:animalId===first.id?condition.id:null}))};
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
    assert.equal(applied.animals.find((animal:{animalId:string})=>animal.animalId===first.id)?.dose,3);
    assert.equal((await listConditions(context))[0]?.status,'EN_TRATAMIENTO');
    const resolved=await resolveCondition(auth,context,condition.id,{resolvedOn:today,
      expectedVersion:changedCondition.version+1},metadata);
    assert.equal(resolved.status,'RESUELTA');
    assert.equal(resolved.treatmentCount,1);
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
    const customRoute=await createCatalogItem(auth,context,'ADMINISTRATION_ROUTES',{name:'Intramamaria'},metadata);
    const reference={name:'Referencia por peso',kind:'OTRO' as const,defaultUnitCode:'MILLILITER' as const,
      administrationRoutes:['ORAL',customRoute.id],doseAmount:1,doseWeight:50,doseWeightUnitCode:'KILOGRAM' as const,
      withdrawalMilkDays:0,withdrawalMeatDays:0};
    assert.equal(medicineSchema.safeParse({...reference,doseAmount:null}).success,false);
    assert.equal(medicineSchema.safeParse({...reference,doseWeightUnitCode:null}).success,false);
    assert.equal(medicineSchema.safeParse({...reference,doseWeight:Infinity}).success,false);
    const weighted=await createMedicine(auth,context,reference,metadata,'CATALOG_MANAGE');
    assert.equal(weighted.doseAmount,1);assert.equal(weighted.doseWeight,50);
    assert.deepEqual(weighted.administrationRoutes,['ORAL',customRoute.id]);
    await assert.rejects(()=>createMedicine(auth,context,{...reference,name:'Referencia ajena',administrationRoutes:[randomUUID()]},metadata),
      (error:{code?:string})=>error.code==='HEALTH_ROUTE_INVALID');
    await assert.rejects(()=>createMedicine({...auth,activeRoleId:viewer.id},{...context,roleId:viewer.id},reference,metadata,'CATALOG_MANAGE'),
      (error:{code?:string})=>error.code==='CATALOG_MANAGE_DENIED');
    await assert.rejects(()=>createCampaign(auth,context,{...base,medicineId:weighted.id as string},metadata),
      (error:{code?:string})=>error.code==='HEALTH_MEDICINE_ROUTE_INVALID');
    const byRoute=await createCampaign(auth,context,{...base,medicineId:weighted.id as string,administrationRoute:customRoute.id,
      selectionMode:'MANUAL',groupId:null,animals:[base.animals[1]!]},metadata);
    assert.equal(byRoute.administrationRoute,customRoute.id);
    const weighing=await createWeighing(auth,context,{animalId:second.id,weighedOn:today,weight:1000,unitCode:'POUND',method:null,notes:null},metadata);
    assert.ok(weighing);
    let weightedAnimal=(await listHealthOptions(context)).animals.find(animal=>animal.id===second.id)!;
    assert.equal(weightedAnimal.weightKg,453.59237);assert.equal(weightedAnimal.weightSource,'WEIGHING');
    await voidWeighing(auth,context,weighing!.id,weighing!.version,metadata);
    weightedAnimal=(await listHealthOptions(context)).animals.find(animal=>animal.id===second.id)!;
    assert.equal(weightedAnimal.weightKg,null);
    assert.equal(medicineSchema.safeParse({...reference,defaultUnitCode:''}).success,false);
    const doseClassificationRanges=[{classificationCode:'VACA' as const,min:5,max:10},
      {classificationCode:'TERNERO' as const,min:3,max:5}];
    const classifiedInput={...reference,name:'Referencia por clasificación',doseAmount:null,doseWeight:null,
      doseWeightUnitCode:null,doseClassificationRanges};
    assert.equal(medicineSchema.safeParse(classifiedInput).success,true);
    for(const invalid of [
      {...classifiedInput,doseClassificationRanges:[{classificationCode:'VACA',min:10,max:5}]},
      {...classifiedInput,doseClassificationRanges:[doseClassificationRanges[0],doseClassificationRanges[0]]},
      {...classifiedInput,doseClassificationRanges:[{classificationCode:'UNKNOWN',min:1,max:2}]},
      {...classifiedInput,doseClassificationRanges:[{classificationCode:'VACA',min:0,max:2}]},
      {...classifiedInput,doseAmount:1},
    ])assert.equal(medicineSchema.safeParse(invalid).success,false);
    const classified=await createMedicine(auth,context,classifiedInput,metadata);
    assert.deepEqual(classified.doseClassificationRanges,doseClassificationRanges);
    assert.deepEqual((await listMedicines(context)).find(item=>item.id===classified.id)?.doseClassificationRanges,doseClassificationRanges);
    const classificationOptions=await listHealthOptions(context);
    assert.equal(classificationOptions.classifications.length,6);
    assert.ok(classificationOptions.animals.every(animal=>'classificationCode' in animal));
    assert.equal(classificationOptions.units.length,6);
    const referenceCampaign=await createCampaign(auth,context,{...base,medicineId:classified.id as string,
      administrationRoute:'ORAL',selectionMode:'MANUAL',groupId:null,animals:[{...base.animals[1]!,dose:12}]},metadata);
    assert.equal(referenceCampaign.animals[0].dose,12); // El rango es referencial: se admite otra cantidad.
    await pool.query(`UPDATE administrative_account SET max_properties=2 WHERE id=(SELECT account_id FROM property WHERE id=$1)`,[property.id]);
    const extra=await createAccountProperty(auth,context,`Otra finca ${suffix}`,metadata);
    const extraContext={...context,propertyId:extra.propertyId,roleId:extra.roleId};
    assert.ok((await listMedicines(extraContext)).some(item=>item.id===weighted.id));
    assert.ok((await listMedicines(extraContext)).some(item=>item.id===classified.id));
    assert.ok((await listCatalogItems(extraContext,'ADMINISTRATION_ROUTES')).some(item=>item.id===customRoute.id));
    assert.equal((await pool.query(`SELECT actor_user_id FROM audit_event WHERE entity_id=$1 AND action='HEALTH_MEDICINE_CREATED'`,[weighted.id])).rows[0]?.actor_user_id,auth.userId);
    const edit={medicine:medicineSchema.parse({name:'Vacuna corregida',kind:'OTRO',defaultUnitCode:'GRAM',
      administrationRoutes:['ORAL'],withdrawalMilkDays:5,withdrawalMeatDays:15,activeIngredient:'Ingrediente nuevo'}),active:false,expectedVersion:1};
    const updatedMedicine=await updateMedicine(auth,context,medicine.id as string,edit,metadata);
    assert.equal(updatedMedicine.version,2);assert.equal(updatedMedicine.active,false);
    await assert.rejects(()=>updateMedicine(auth,context,medicine.id as string,edit,metadata),
      (error:{code?:string})=>error.code==='MEDICINE_VERSION_CONFLICT');
    await assert.rejects(()=>updateMedicine(auth,context,medicine.id as string,{...edit,expectedVersion:2,
      medicine:{...edit.medicine,administrationRoutes:[randomUUID()]}},metadata),
      (error:{code?:string})=>error.code==='HEALTH_ROUTE_INVALID');
    const historical=(await listConditionTreatments(context,condition.id))[0]!;
    assert.equal(historical.medicineName,'Vacuna de prueba');assert.equal(historical.kind,'VACUNA');
    assert.equal(historical.withdrawalMilkDays,2);assert.equal(historical.withdrawalMeatDays,7);
    assert.equal(historical.animals[0].unitCode,'MILLILITER');assert.equal(historical.administrationRoute,'INTRAMUSCULAR');
    await assert.rejects(()=>listConditionTreatments(extraContext,condition.id),
      (error:{code?:string})=>error.code==='HEALTH_CONDITION_NOT_FOUND');
    const custom=(await pool.query(`INSERT INTO property_role(property_id,code,name,created_by)
      VALUES($1,'CUSTOM_MEDICINE','Colaborador de catálogos',$2) RETURNING id`,[property.id,auth.userId])).rows[0]!;
    await pool.query(`INSERT INTO membership_role(membership_id,property_id,role_id,assigned_by)
      SELECT id,property_id,$3,$2 FROM property_membership WHERE property_id=$1 AND user_id=$2`,[property.id,auth.userId,custom.id]);
    await pool.query(`INSERT INTO role_permission(role_id,permission_code) VALUES($1,'CATALOG_MANAGE')`,[custom.id]);
    await assert.rejects(()=>updateMedicine({...auth,activeRoleId:custom.id},
      {...context,roleId:custom.id,roleCode:'ADMINISTRATOR'},medicine.id as string,{...edit,expectedVersion:2},metadata),
      (error:{code?:string})=>error.code==='MEDICINE_ADMIN_REQUIRED');
    await pool.query(`INSERT INTO health_campaign(account_id,property_id,medicine_id,administration_route,
      selection_mode,applied_on,created_by,updated_by,created_at)
      SELECT $1,$2,$3,'ORAL','MANUAL',$4,$5,$5,now()+make_interval(secs=>n)
      FROM generate_series(1,251) n`,[registration.accountId,property.id,weighted.id,today,auth.userId]);
    assert.equal((await listCampaigns(context)).some(row=>row.id===historical.id),false);
    assert.equal((await listConditionTreatments(context,condition.id))[0]?.id,historical.id);
  }finally{await pool.end();}
});
