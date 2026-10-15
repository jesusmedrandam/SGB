import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {once} from 'node:events';
import {app} from '../../app.js';
import {pool} from '../../database/pool.js';
import {register,login,getSessionOverview,resendEmailVerification,verifyEmail} from '../auth/auth.service.js';
import {createAnimal,getAnimal,listAnimals} from '../animals/animals.service.js';
import {createOwner} from '../animals/owners.service.js';
import {getAnimalSummary} from '../animals/classification.service.js';
import {createGroup,updateGroup,listGroups,setGroupState,createLocation,listLocations,assignAnimalToGroup} from './groups.service.js';
import {createGroupSchema} from './groups.schemas.js';
import {createMovement,applyMovement,listMovementOptions,listMovements} from '../movements/movements.service.js';
import {createPregnancy,recordBirth,listReproduction} from '../reproduction/reproduction.service.js';
import {createLactation,recordMilk,listProduction} from '../production/production.service.js';
import {createWeighing} from '../weighings/weighings.service.js';
import {createCondition} from '../health/conditions.service.js';

const metadata={ipAddress:'127.0.0.1',userAgent:'outside-groups-test'};
const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Guayaquil'}).format(new Date());
const fails=(code:string)=>(error:{code?:string})=>error.code===code;
test('grupos externos: animales activos, crías, operaciones, ida y regreso, permisos y ocupación',async()=>{
 const server=app.listen(0,'127.0.0.1');
 try{
  await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address==='object');
  const url=`http://127.0.0.1:${address.port}`;
  const ready=await (await fetch(url+'/health/ready')).json();
  assert.equal(ready.outsidePropertyGroupsReady,true);assert.equal(ready.database,'ready');
  assert.equal((await fetch(url+'/groups')).status,401);
  const email=`outside-${randomUUID()}@example.test`;
  const registration=await register({email,password:'Clave-segura-2026',displayName:'Dueño',propertyName:'Mi propiedad'},metadata);
  await pool.query("UPDATE email_verification_token SET created_at=now()-interval '2 minutes' WHERE user_id=$1",[registration.userId]);
  await verifyEmail((await resendEmailVerification(email,metadata)).verificationToken!,metadata);
  const session=await login({email,password:'Clave-segura-2026',deviceId:randomUUID()},metadata);
  const auth={sessionId:session.sessionId,userId:session.user.id,email,displayName:session.user.displayName,isSuperadmin:false,
    activePropertyId:session.activePropertyId,activeRoleId:session.activeRoleId};
  const property=(await getSessionOverview(auth)).properties[0]!,role=property.roles.find(row=>row.code==='OWNER')!;
  const context={propertyId:property.id,propertyName:property.name,roleId:role.id,roleCode:role.code,roleName:role.name,
    permissions:new Set(role.permissions),enabledModules:new Set(property.enabledModules),enabledSpecies:new Set(property.enabledSpecies)};
  assert.equal(createGroupSchema.safeParse({name:'Sin lugar',kind:'EXTERNAL'}).success,false);
  assert.equal(createGroupSchema.safeParse({name:'Sin potrero'}).success,false);
  const outside=await createGroup(auth,context,{name:'Vacas con Carlos',kind:'EXTERNAL',externalPlace:'Finca El Paraíso',externalContact:'Don Carlos'},metadata);
  assert.equal(outside.location,null);assert.equal(outside.kind,'EXTERNAL');assert.equal((await listLocations(context)).length,0);
  assert.equal((await getSessionOverview(auth)).properties.length,1,'No additional property or outside user account is created');
  const place=await createLocation(auth,context,{name:'Potrero propio',kind:'PASTURE'},metadata);
  const inside=await createGroup(auth,context,{name:'Vacas dentro',locationId:place.id},metadata);
  await assert.rejects(()=>createGroup(auth,context,{name:'Inválido',kind:'EXTERNAL',externalPlace:'Otro',locationId:place.id},metadata),fails('GROUP_EXTERNAL_INVALID'));
  const owner=await createOwner(auth,context,{kind:'USER',userId:auth.userId},metadata);
  const cow=await createAnimal(auth,context,{name:'Lucera',sex:'FEMALE',speciesCode:'BOVINE',groupId:outside.id,owners:[{partyId:owner.id,percent:100,isPrimary:true}]},metadata);
  assert.equal(cow.availabilityStatusCode,'ACTIVE');assert.equal(cow.location,null);assert.deepEqual(cow.externalStay,{place:'Finca El Paraíso',contact:'Don Carlos'});
  await createWeighing(auth,context,{animalId:cow.id,weighedOn:today(),weight:400,unitCode:'KILOGRAM',method:null,notes:null},metadata);
  await createCondition(auth,context,{animalId:cow.id,kind:'Herida',detectedOn:today(),description:'Consulta fuera de propiedad'},metadata);
  const pregnancy=await createPregnancy(auth,context,{cowId:cow.id,confirmedOn:'2026-01-01',conceptionMethod:'UNKNOWN',confirmationMethod:'OBSERVATION',useLastHeat:false},metadata);
  const birth=await recordBirth(auth,context,{pregnancyId:pregnancy.id,occurredOn:today(),calves:[{name:'Luna',sex:'FEMALE',groupId:outside.id}],stillbornCount:0},metadata);
  assert.equal((await getAnimal(context,birth.calves[0]!.id)).externalStay?.place,'Finca El Paraíso');
  await createLactation(auth,context,{birthId:birth.id,inMilking:true},metadata);
  await recordMilk(auth,context,{cowId:cow.id,producedOn:today(),shift:'MORNING',liters:8,source:'MANUAL'},metadata);
  assert.equal((await getAnimalSummary(context)).activeOutside,2);assert.equal((await getAnimalSummary(context)).activeInside,0);
  const options=await listMovementOptions(auth,context);assert.equal(options.groups.find(group=>group.id===outside.id)!.kind,'EXTERNAL');
  const move=async(source:string,destination:string)=>{
    const draft=await createMovement(auth,context,{kind:'GRUPO',selectionMode:'MANUAL',sourceGroupId:source,destinationGroupId:destination,
      destinationPropertyId:property.id,animalIds:[cow.id],movementOn:today(),reason:'Cambio de cuidado'},metadata);
    await applyMovement(auth,context,draft.id,metadata);
  };
  await move(outside.id,inside.id);
  let current=await getAnimal(context,cow.id);assert.equal(current.id,cow.id);assert.equal(current.externalStay,null);assert.equal(current.location?.id,place.id);
  assert.equal((await getAnimalSummary(context)).activeInside,1);assert.equal((await getAnimalSummary(context)).activeOutside,1);
  assert.equal((await listLocations(context)).find(row=>row.id===place.id)!.currentAnimalCount,1);
  await move(inside.id,outside.id);
  current=await getAnimal(context,cow.id);assert.equal(current.availabilityStatusCode,'ACTIVE');assert.equal(current.location,null);assert.equal(current.externalStay?.contact,'Don Carlos');
  assert.equal((await listLocations(context)).find(row=>row.id===place.id)!.currentAnimalCount,0);
  assert.equal((await listAnimals(context,{page:1,search:''})).total,2);
  assert.equal((await listProduction(context)).milk.length,1);assert.equal((await listReproduction(context)).births.length,1);
  assert.equal((await listMovements(context)).filter(row=>row.status==='COMPLETADO').length,2);
  const occupiedGroup=(await listGroups(context)).find(row=>row.id===outside.id)!;
  await assert.rejects(()=>setGroupState(auth,context,outside.id,{active:false,expectedVersion:occupiedGroup.version},metadata),fails('GROUP_HAS_ANIMALS'));
  await assert.rejects(()=>createMovement(auth,context,{kind:'UBICACION',selectionMode:'GRUPO',sourceGroupId:outside.id,destinationGroupId:outside.id,
    destinationPropertyId:property.id,destinationLocationId:place.id,animalIds:[],movementOn:today(),reason:'Inválido'},metadata),fails('GROUP_EXTERNAL_INVALID'));
  const empty=await createGroup(auth,context,{name:'Lugar temporal',kind:'EXTERNAL',externalPlace:'Don Pedro'},metadata);
  const archived=await setGroupState(auth,context,empty.id,{active:false,expectedVersion:empty.version},metadata);
  const restored=await setGroupState(auth,context,empty.id,{active:true,expectedVersion:archived.version},metadata);assert.equal(restored.location,null);
  const updated=await updateGroup(auth,context,restored.id,{name:restored.name,externalPlace:'Finca corregida',externalContact:'Pedro',expectedVersion:restored.version},metadata);
  assert.equal(updated.externalPlace,'Finca corregida');
  await assignAnimalToGroup(auth,context,inside.id,{animalId:cow.id,expectedAnimalVersion:current.version},metadata);
  assert.equal((await getAnimal(context,cow.id)).externalStay,null,'The shared assignment helper also returns an external animal');
  await assert.rejects(()=>pool.query('INSERT INTO group_location_assignment(property_id,group_id,location_id,started_at,start_reason,created_by) VALUES($1,$2,$3,now(),$4,$5)',
    [property.id,outside.id,place.id,'Inválido',auth.userId]));
  const viewer=(await pool.query("SELECT id FROM property_role WHERE property_id=$1 AND code='VIEWER'",[property.id])).rows[0];
  await assert.rejects(()=>createGroup(auth,{...context,roleId:viewer.id},{name:'Sin permiso',kind:'EXTERNAL',externalPlace:'Ajeno'},metadata),fails('GROUP_ACCESS_DENIED'));
  const admin=(await pool.query("SELECT id FROM property_role WHERE property_id=$1 AND code='ADMINISTRATOR'",[property.id])).rows[0];
  await pool.query(`INSERT INTO membership_role(membership_id,property_id,role_id,assigned_by)
    SELECT id,property_id,$3,$2 FROM property_membership WHERE property_id=$1 AND user_id=$2 ON CONFLICT DO NOTHING`,[property.id,auth.userId,admin.id]);
  const adminGroup=await createGroup({...auth,activeRoleId:admin.id},{...context,roleId:admin.id,roleCode:'ADMINISTRATOR'},
    {name:'Grupo externo por administrador',kind:'EXTERNAL',externalPlace:'Finca del vecino'},metadata);
  assert.equal(adminGroup.kind,'EXTERNAL','Administrators can also manage outside groups');
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await pool.end();}
});
