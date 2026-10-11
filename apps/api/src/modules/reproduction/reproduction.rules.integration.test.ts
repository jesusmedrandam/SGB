import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {pool} from '../../database/pool.js';
import {register,login,getSessionOverview,resendEmailVerification,verifyEmail} from '../auth/auth.service.js';
import {createAccountProperty,getPropertySettings} from '../properties/properties.service.js';
import {createAnimal,getAnimal} from '../animals/animals.service.js';
import {createOwner} from '../animals/owners.service.js';
import {updateAnimalParents} from '../animals/parents.service.js';
import {getClassificationPolicy,updateClassificationPolicy} from '../animals/classification.service.js';
import {createGroup} from '../groups/groups.service.js';
import {cancelPregnancy,createHeat,createService,createPregnancy,getReproductionSettings,recordBirth,recordLoss,updateReproductionSettings} from './reproduction.service.js';

const metadata={ipAddress:'127.0.0.1',userAgent:'account-reproduction-rules-test'};
test('reglas compartidas por dueño, administradores, edad de padres y ficha completa del parto',async()=>{
 try{
  async function owner(){
   const email=`rules-${randomUUID()}@example.test`;
   const registration=await register({email,password:'Clave-segura-2026',displayName:'Dueño',propertyName:`Finca ${randomUUID()}`},metadata);
   await pool.query("UPDATE email_verification_token SET created_at=now()-interval '2 minutes' WHERE user_id=$1",[registration.userId]);
   const verification=await resendEmailVerification(email,metadata);await verifyEmail(verification.verificationToken!,metadata);
   const session=await login({email,password:'Clave-segura-2026',deviceId:randomUUID()},metadata);
   const auth={sessionId:session.sessionId,userId:session.user.id,email,displayName:'Dueño',isSuperadmin:false,
    activePropertyId:session.activePropertyId,activeRoleId:session.activeRoleId};
   const overview=await getSessionOverview(auth);const property=overview.properties[0]!;
   const role=property.roles.find(x=>x.code==='OWNER')!;
   const context={propertyId:property.id,propertyName:property.name,roleId:role.id,roleCode:role.code,roleName:role.name,
    permissions:new Set(role.permissions),enabledModules:new Set(property.enabledModules),enabledSpecies:new Set(property.enabledSpecies)};
   return {auth,context,accountId:registration.accountId!};
  }
  const first=await owner(),other=await owner();const {auth,context,accountId}=first;
  await pool.query('UPDATE administrative_account SET max_properties=3 WHERE id=ANY($1::uuid[])',[[accountId,other.accountId]]);
  const second=await createAccountProperty(auth,context,'Segunda propiedad',metadata);
  const secondContext={...context,propertyId:second.propertyId,roleId:second.roleId};
  const config=await getReproductionSettings(context);
  await updateReproductionSettings(auth,context,{...config,minimumCowMonths:18,minimumBullMonths:24},metadata);
  assert.equal((await getReproductionSettings(secondContext)).minimumBullMonths,24);
  assert.equal((await getReproductionSettings(other.context)).minimumBullMonths,12);
  const classification=await getClassificationPolicy(context);
  await updateClassificationPolicy(auth,context,{...classification,femaleAdultMonths:20,maleAdultMonths:30},metadata);
  assert.equal((await getClassificationPolicy(secondContext)).femaleAdultMonths,20);
  assert.equal((await getClassificationPolicy(other.context)).femaleAdultMonths,12);
  const adminRole=(await pool.query("SELECT id FROM property_role WHERE property_id=$1 AND code='ADMINISTRATOR'",[context.propertyId])).rows[0].id;
  const membership=(await pool.query("INSERT INTO property_membership(property_id,user_id,status,created_by) VALUES($1,$2,'ACTIVE',$2) RETURNING id",[context.propertyId,other.auth.userId])).rows[0].id;
  await pool.query('INSERT INTO membership_role(membership_id,property_id,role_id,assigned_by) VALUES($1,$2,$3,$4)',[membership,context.propertyId,adminRole,auth.userId]);
  const collaborator={...context,roleId:adminRole,roleCode:'ADMINISTRATOR'};
  await updateReproductionSettings(other.auth,collaborator,{...config,minimumCowMonths:18,minimumBullMonths:24},metadata);
  assert.equal((await getPropertySettings(collaborator,other.auth)).canCreate,false);
  await assert.rejects(()=>createAccountProperty(other.auth,collaborator,'No es su cuenta',metadata),(e:{code?:string})=>e.code==='PROPERTY_OWNER_REQUIRED');
  const personal=await createAccountProperty(other.auth,other.context,'Propiedad personal',metadata);
  assert.equal((await pool.query('SELECT owner_user_id FROM property WHERE id=$1',[personal.propertyId])).rows[0].owner_user_id,other.auth.userId);
  const customRole=(await pool.query("INSERT INTO property_role(property_id,code,name,is_system,created_by) VALUES($1,'CUSTOM_VET','Veterinario',false,$2) RETURNING id",[context.propertyId,auth.userId])).rows[0].id;
  await pool.query('INSERT INTO membership_role(membership_id,property_id,role_id,assigned_by) VALUES($1,$2,$3,$4)',[membership,context.propertyId,customRole,auth.userId]);
  await pool.query("INSERT INTO role_permission(role_id,permission_code) VALUES($1,'REPRODUCTION_MANAGE'),($1,'CATALOG_MANAGE')",[customRole]);
  const customContext={...collaborator,roleId:customRole,roleCode:'CUSTOM_VET'};
  assert.equal((await getReproductionSettings(customContext,other.auth)).canManageRules,false);
  await assert.rejects(()=>updateReproductionSettings(other.auth,customContext,config,metadata),(e:{code?:string})=>e.code==='RULES_ADMINISTRATOR_REQUIRED');
  await assert.rejects(()=>updateClassificationPolicy(other.auth,customContext,classification,metadata),(e:{code?:string})=>e.code==='RULES_ADMINISTRATOR_REQUIRED');
  const party=await createOwner(auth,context,{kind:'USER',userId:auth.userId},metadata);
  const ownership=[{partyId:party.id,percent:100,isPrimary:true}];
  const youngCow=await createAnimal(auth,context,{name:'Hembra joven',sex:'FEMALE',speciesCode:'BOVINE',birthDate:'2023-01-31',owners:ownership},metadata);
  const youngBull=await createAnimal(auth,context,{name:'Macho joven',sex:'MALE',speciesCode:'BOVINE',birthDate:'2023-01-31',owners:ownership},metadata);
  async function classify(id:string,on:string){return (await pool.query('SELECT classify_animal($1,$2::date) AS code',[id,on])).rows[0].code;}
  assert.equal(await classify(youngCow.id,'2024-09-29'),'TERNERA');
  assert.equal(await classify(youngCow.id,'2024-09-30'),'VACONA');
  assert.equal(await classify(youngBull.id,'2025-07-30'),'TERNERO');
  assert.equal(await classify(youngBull.id,'2025-07-31'),'TORETE');
  const unknownCow=await createAnimal(auth,context,{name:'Hembra sin nacimiento',sex:'FEMALE',speciesCode:'BOVINE',owners:ownership},metadata);
  const unknownBull=await createAnimal(auth,secondContext,{name:'Macho sin nacimiento',sex:'MALE',speciesCode:'BOVINE',owners:ownership},metadata);
  assert.equal((await getAnimal(context,unknownCow.id)).classification?.code,'VACONA');
  assert.equal((await getAnimal(secondContext,unknownBull.id)).classification?.code,'TORETE');
  await createHeat(auth,context,{cowId:unknownCow.id,bullId:unknownBull.id,startsOn:'2024-01-01',endsOn:'2024-01-02',isFalse:false},metadata);
  const service=await createService(auth,context,{cowId:unknownCow.id,fatherId:unknownBull.id,donorId:unknownCow.id,kind:'EMBRYO_TRANSFER',occurredOn:'2024-01-03'},metadata);
  const unknownPregnancy=await createPregnancy(auth,context,{cowId:unknownCow.id,serviceId:service.id,conceptionMethod:'EMBRYO_TRANSFER',confirmationMethod:'PALPATION',confirmedOn:'2024-02-01'},metadata);
  assert.equal((await getAnimal(secondContext,unknownBull.id)).classification?.code,'TORO');
  await recordLoss(auth,context,{pregnancyId:unknownPregnancy.id,occurredOn:'2024-02-02',notes:'Pérdida confirmada'},metadata);
  assert.equal((await getAnimal(secondContext,unknownBull.id)).classification?.code,'TORO');
  assert.equal((await getAnimal(context,unknownCow.id)).classification?.code,'VACONA');
  const stillbornPregnancy=await createPregnancy(auth,context,{cowId:unknownCow.id,fatherId:unknownBull.id,conceptionMethod:'NATURAL',confirmationMethod:'PALPATION',confirmedOn:'2025-01-01'},metadata);
  await recordBirth(auth,context,{pregnancyId:stillbornPregnancy.id,occurredOn:'2025-10-01',calves:[],stillbornCount:1},metadata);
  assert.equal((await getAnimal(context,unknownCow.id)).classification?.code,'VACA');
  const cancelledBull=await createAnimal(auth,context,{name:'Padre de preñez anulada',sex:'MALE',speciesCode:'BOVINE'},metadata);
  const cancelledCow=await createAnimal(auth,context,{name:'Hembra de preñez anulada',sex:'FEMALE',speciesCode:'BOVINE'},metadata);
  const cancelled=await createPregnancy(auth,context,{cowId:cancelledCow.id,fatherId:cancelledBull.id,conceptionMethod:'NATURAL',confirmationMethod:'PALPATION',confirmedOn:'2024-01-01'},metadata);
  await cancelPregnancy(auth,context,cancelled.id,metadata);
  assert.equal((await getAnimal(context,cancelledBull.id)).classification?.code,'TORETE');
  const unknownChild=await createAnimal(auth,context,{name:'Cría de padres sin fecha',sex:'FEMALE',speciesCode:'BOVINE',birthDate:'2024-01-01',mother:{animalId:unknownCow.id},father:{animalId:cancelledBull.id}},metadata);
  assert.equal((await getAnimal(context,unknownChild.id)).father?.animalId,cancelledBull.id);
  const corrected=await updateAnimalParents(auth,context,unknownChild.id,{mother:{animalId:cancelledCow.id},father:{animalId:cancelledBull.id},expectedVersion:unknownChild.version},metadata);
  assert.equal(corrected.mother?.animalId,cancelledCow.id);
  await assert.rejects(()=>createHeat(auth,context,{cowId:youngCow.id,startsOn:'2024-07-30',isFalse:false},metadata),(e:{code?:string})=>e.code==='REPRODUCTION_MINIMUM_AGE');
  await createHeat(auth,context,{cowId:youngCow.id,startsOn:'2024-07-31',isFalse:false},metadata);
  await assert.rejects(()=>createHeat(auth,context,{cowId:youngCow.id,bullId:youngBull.id,startsOn:'2024-08-01',isFalse:false},metadata),(e:{code?:string})=>e.code==='REPRODUCTION_MINIMUM_AGE');
  await assert.rejects(()=>createAnimal(auth,context,{name:'Cría imposible',sex:'FEMALE',speciesCode:'BOVINE',birthDate:'2024-01-31',father:{animalId:youngBull.id}},metadata),(e:{code?:string})=>e.code==='REPRODUCTION_MINIMUM_AGE');
  const unrelated=await createAnimal(auth,context,{name:'Cría sin padre',sex:'FEMALE',speciesCode:'BOVINE',birthDate:'2024-01-31'},metadata);
  await assert.rejects(()=>updateAnimalParents(auth,context,unrelated.id,{mother:null,father:{animalId:youngBull.id},expectedVersion:unrelated.version},metadata),(e:{code?:string})=>e.code==='REPRODUCTION_MINIMUM_AGE');
  const mother=await createAnimal(auth,context,{name:'Madre',sex:'FEMALE',speciesCode:'BOVINE',birthDate:'2018-01-01',owners:ownership},metadata);
  const father=await createAnimal(auth,secondContext,{name:'Padre',sex:'MALE',speciesCode:'BOVINE',birthDate:'2018-01-01',owners:ownership},metadata);
  const pregnancy=await createPregnancy(auth,context,{cowId:mother.id,fatherId:father.id,conceptionMethod:'NATURAL',confirmationMethod:'PALPATION',confirmedOn:'2024-01-01'},metadata);
  const group=await createGroup(auth,context,{name:'Crías'},metadata);
  const alienGroup=await createGroup(other.auth,other.context,{name:'Otra cuenta'},metadata);
  await assert.rejects(()=>recordBirth(auth,context,{pregnancyId:pregnancy.id,occurredOn:'2024-07-31',stillbornCount:0,calves:[{name:'Cría',sex:'FEMALE',groupId:alienGroup.id}]},metadata),(e:{code?:string})=>e.code==='GROUP_UNAVAILABLE');
  assert.equal((await pool.query('SELECT 1 FROM reproduction_birth WHERE pregnancy_id=$1',[pregnancy.id])).rowCount,0);
  const birth=await recordBirth(auth,context,{pregnancyId:pregnancy.id,occurredOn:'2024-07-31',kind:'ASSISTED',stillbornCount:0,
    calves:[{name:'Cría completa',sex:'FEMALE',earTagCode:'CRIA-1',initialWeight:32.125,initialWeightUnitCode:'KILOGRAM',
      description:'Pequeña mancha blanca',birthCondition:'WEAK',groupId:group.id}]},metadata);
  const calf=await getAnimal(context,birth.calves[0]!.id);
  assert.equal(calf.description,'Pequeña mancha blanca');assert.equal(calf.initialWeight,32.125);
  assert.equal(calf.group?.id,group.id);assert.equal(calf.mother?.animalId,mother.id);assert.equal(calf.father?.animalId,father.id);
  assert.equal(calf.owners[0]?.id,party.id);
  assert.equal((await pool.query('SELECT kind FROM reproduction_birth WHERE id=$1',[birth.id])).rows[0].kind,'ASSISTED');
  assert.equal((await pool.query('SELECT birth_condition FROM reproduction_birth_calf WHERE animal_id=$1',[calf.id])).rows[0].birth_condition,'WEAK');
 }finally{await pool.end();}
});
