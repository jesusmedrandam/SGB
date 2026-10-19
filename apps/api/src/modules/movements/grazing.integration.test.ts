import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {pool} from '../../database/pool.js';
import {register,login,resendEmailVerification,verifyEmail,getSessionOverview} from '../auth/auth.service.js';
import {createAnimal,getAnimal} from '../animals/animals.service.js';
import {createAnimalSchema} from '../animals/animals.schemas.js';
import {createGroup,createLocation,listLocations,assignAnimalToGroup} from '../groups/groups.service.js';
import {createMovement,applyMovement,listMovements} from './movements.service.js';
import {movementSchema,type MovementInput} from './movements.schemas.js';

const metadata={ipAddress:'127.0.0.1',userAgent:'grazing-test'};
test('separación temporal, reincorporación, ocupación opcional, potreros combinados y condiciones del pasto',async()=>{
 try{
  const email=`grazing-${randomUUID()}@example.test`;
  const registration=await register({email,password:'Clave-segura-2026',displayName:'Propietario',propertyName:'Predio de pastoreo'},metadata);
  await pool.query("UPDATE email_verification_token SET created_at=now()-interval '2 minutes' WHERE user_id=$1",[registration.userId]);
  await verifyEmail((await resendEmailVerification(email,metadata)).verificationToken!,metadata);
  const session=await login({email,password:'Clave-segura-2026',deviceId:randomUUID()},metadata);
  const auth={sessionId:session.sessionId,userId:session.user.id,email,displayName:'Propietario',isSuperadmin:false,activePropertyId:session.activePropertyId,activeRoleId:session.activeRoleId};
  const property=(await getSessionOverview(auth)).properties[0]!,role=property.roles.find(row=>row.code==='OWNER')!;
  const context={propertyId:property.id,propertyName:property.name,roleId:role.id,roleCode:role.code,roleName:role.name,
    permissions:new Set(role.permissions),enabledModules:new Set(property.enabledModules),enabledSpecies:new Set(property.enabledSpecies)};
  const [a,b,c,d]=await Promise.all(['Norte','Sur','Centro','Enfermería'].map(name=>createLocation(auth,context,{name,kind:'PASTURE'},metadata)));
  const group=await createGroup(auth,context,{name:'Vacas',locationId:a!.id},metadata);
  const destination=await createGroup(auth,context,{name:'Receptor',locationId:d!.id},metadata);
  const animal=await createAnimal(auth,context,createAnimalSchema.parse({name:'Lucera',sex:'FEMALE',speciesCode:'BOVINE',groupId:group.id}),metadata);
  const on=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Guayaquil'}).format(new Date());
  const base:MovementInput={kind:'SEPARACION',selectionMode:'MANUAL',sourceGroupId:group.id,destinationGroupId:null,
    destinationPropertyId:property.id,movementOn:on,reason:'Reposo por lesión',animalIds:[animal.id]};
  await assert.rejects(()=>createMovement(auth,context,base,metadata),(error:{code?:string})=>error.code==='PASTURE_EXIT_STATE_REQUIRED');
  const separation=await createMovement(auth,context,{...base,pastureConditions:[{locationId:a!.id,exitState:'REMAINS'}]},metadata);
  await applyMovement(auth,context,separation.id,metadata);
  let record=await getAnimal(context,animal.id);assert.equal(record.group,null);assert.equal(record.location?.id,a!.id);
  assert.equal(record.availabilityStatusCode,'ACTIVE');assert.equal(record.countsForOccupancy,false);assert.equal(record.separatedFromGroup,true);
  assert.equal((await listLocations(context)).find(place=>place.id===a!.id)!.currentAnimalCount,0);
  const joining=await createMovement(auth,context,{...base,kind:'GRUPO',sourceGroupId:null,destinationGroupId:group.id,countsForOccupancy:true},metadata);
  await applyMovement(auth,context,joining.id,metadata);record=await getAnimal(context,animal.id);assert.equal(record.group?.id,group.id);assert.equal(record.separatedFromGroup,false);
  const counted=await createMovement(auth,context,{...base,countsForOccupancy:true},metadata);await applyMovement(auth,context,counted.id,metadata);
  assert.equal((await listLocations(context)).find(place=>place.id===a!.id)!.currentAnimalCount,1);
  record=await getAnimal(context,animal.id);await assignAnimalToGroup(auth,context,group.id,{animalId:animal.id,expectedAnimalVersion:record.version},metadata);
  const rotation=await createMovement(auth,context,{...base,kind:'UBICACION',selectionMode:'GRUPO',destinationGroupId:group.id,
    destinationLocationId:b!.id,additionalDestinationLocationIds:[c!.id],pastureConditions:[{locationId:a!.id,exitState:'DEPLETED'},
      {locationId:b!.id,entryHeightCm:25},{locationId:c!.id,entryHeightCm:18}]},metadata);
  await applyMovement(auth,context,rotation.id,metadata);
  const savedRotation=(await listMovements(context)).find(row=>row.id===rotation.id)!;
  assert.ok(String(savedRotation.destinationLocationName).includes('Sur')&&String(savedRotation.destinationLocationName).includes('Centro'));
  const places=await listLocations(context);
  for(const place of places.filter(place=>[b!.id,c!.id].includes(place.id))){assert.equal(place.group?.id,group.id);assert.equal(place.currentAnimalCount,1);}
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM pasture_observation WHERE movement_batch_id=$1',[rotation.id])).rows[0].n,3);
  await assert.rejects(()=>createGroup(auth,context,{name:'No debe ocupar',locationId:c!.id},metadata));
  const movedSeparation=await createMovement(auth,context,{...base,destinationLocationId:d!.id,pastureConditions:[{locationId:b!.id,exitState:'REMAINS'},{locationId:c!.id,exitState:'DEPLETED'}]},metadata);
  await applyMovement(auth,context,movedSeparation.id,metadata);record=await getAnimal(context,animal.id);
  assert.equal(record.location?.id,d!.id);assert.equal(record.group,null);assert.equal(record.countsForOccupancy,false);
  const finalJoin=await createMovement(auth,context,{...base,kind:'GRUPO',sourceGroupId:null,destinationGroupId:destination.id},metadata);
  await applyMovement(auth,context,finalJoin.id,metadata);
  assert.equal((await listMovements(context)).filter(row=>row.kind==='SEPARACION').length,3);
  assert.equal(movementSchema.safeParse({...base,additionalDestinationLocationIds:[c!.id]}).success,false);
 }finally{await pool.end();}
});
