import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {pool} from '../../database/pool.js';
import {inTransaction} from '../../database/transaction.js';
import {getSessionOverview,login,register,resendEmailVerification,verifyEmail} from '../auth/auth.service.js';
import {createAnimal,getAnimal,listAnimals} from '../animals/animals.service.js';
import {createGroup} from '../groups/groups.service.js';
import {createAnimalSchema} from '../animals/animals.schemas.js';
import {getAnimalSummary,getClassificationPolicy,updateClassificationPolicy}
  from '../animals/classification.service.js';
import {addMedia,listMedia,validateTarget} from './media.service.js';
const metadata={ipAddress:'127.0.0.1',userAgent:'sgb-media-test'};
test('multimedia respeta propiedad, tipo de registro y permisos antes de cargar',async()=>{
  const suffix=randomUUID();const email='media-'+suffix+'@example.test';
  try{
    const registration=await register({email,password:'Clave-segura-2026',
      displayName:'Prueba multimedia',propertyName:'Finca multimedia '+suffix},metadata);
    await pool.query("UPDATE email_verification_token SET created_at=now()-interval '2 minutes' WHERE user_id=$1",[registration.userId]);
    await verifyEmail((await resendEmailVerification(email,metadata)).verificationToken!,metadata);
    const session=await login({email,password:'Clave-segura-2026',deviceId:'media-'+suffix},metadata);
    const overview=await getSessionOverview({sessionId:session.sessionId,userId:session.user.id,
      email:session.user.email,displayName:session.user.displayName,isSuperadmin:false,
      activePropertyId:session.activePropertyId,activeRoleId:session.activeRoleId});
    const property=overview.properties[0]!;
    const role=property.roles.find(entry=>entry.code==='OWNER')!;
    assert.ok(role.permissions.includes('MEDIA_MANAGE'));
    const auth={sessionId:session.sessionId,userId:session.user.id,email:session.user.email,
      displayName:session.user.displayName,isSuperadmin:false,
      activePropertyId:property.id,activeRoleId:role.id};
    const context={propertyId:property.id,propertyName:property.name,roleId:role.id,
      roleCode:role.code,roleName:role.name,permissions:new Set(role.permissions),
      enabledModules:new Set(property.enabledModules),enabledSpecies:new Set(property.enabledSpecies)};
    const group=await createGroup(auth,context,{name:'Grupo multimedia'},metadata);
    assert.equal(createAnimalSchema.safeParse({name:'Sin grupo',sex:'FEMALE',speciesCode:'BOVINE'}).success,false);
    const animal=await createAnimal(auth,context,{name:'Vaca multimedia',sex:'FEMALE',
      speciesCode:'BOVINE',groupId:group.id},metadata);
    const father=await createAnimal(auth,context,{name:'Padre multimedia',sex:'MALE',
      speciesCode:'BOVINE',groupId:group.id,birthDate:'2023-01-01'},metadata);
    const calf=await createAnimal(auth,context,{name:'Cría multimedia',sex:'MALE',
      speciesCode:'BOVINE',groupId:group.id,birthDate:'2025-04-01',mother:{animalId:animal.id},
      father:{animalId:father.id}},metadata);
    assert.equal((await getAnimal(context,animal.id)).classification?.code,'VACA');
    assert.equal((await getAnimal(context,father.id)).classification?.code,'TORO');
    assert.equal((await getAnimal(context,calf.id)).classification?.code,'TORETE');
    const defaults=await getClassificationPolicy(context);
    assert.equal(defaults.femaleAdultMonths,12);
    await updateClassificationPolicy(auth,context,{...defaults,maleAdultMonths:24,
      names:{...defaults.names,VACA:'Madres'}},metadata);
    assert.equal((await getAnimal(context,animal.id)).classification?.name,'Madres');
    assert.equal((await getAnimal(context,calf.id)).classification?.code,'TERNERO');
    assert.deepEqual((await listAnimals(context,1,'','TERNERO')).items.map(item=>item.id),[calf.id]);
    assert.equal((await getAnimalSummary(context)).classifications.find(row=>row.code==='VACA')?.count,1);
    const assigned=await pool.query<{group_id:string}>(`SELECT group_id FROM animal_group_assignment
      WHERE animal_id=$1 AND ended_at IS NULL`,[calf.id]);
    assert.equal(assigned.rows[0]?.group_id,group.id);
    const parent=await pool.query<{parent_animal_id:string}>(`SELECT parent_animal_id
      FROM animal_parentage WHERE child_animal_id=$1 AND role='MOTHER' AND removed_at IS NULL`,[calf.id]);
    assert.equal(parent.rows[0]?.parent_animal_id,animal.id);
    await inTransaction(client=>validateTarget(client,context,'ANIMAL',animal.id));
    await assert.rejects(()=>inTransaction(client=>validateTarget(client,
      {...context,propertyId:randomUUID()},'ANIMAL',animal.id)),
    (error:{code?:string})=>error.code==='MEDIA_TARGET_NOT_FOUND');
    await assert.rejects(()=>inTransaction(client=>validateTarget(client,context,'USER_PROFILE',animal.id)),
      (error:{code?:string})=>error.code==='MEDIA_TARGET_INVALID');
    await assert.rejects(()=>inTransaction(client=>validateTarget(client,
      {...context,permissions:new Set(['MEDIA_VIEW'])},'ANIMAL',animal.id)),
    (error:{code?:string})=>error.code==='PERMISSION_DENIED');
    await assert.rejects(()=>addMedia(auth,context,'ANIMAL',animal.id,'GENERAL','IMAGE',
      Buffer.from('no es una imagen')),(error:{code?:string})=>error.code==='INVALID_IMAGE');
    assert.deepEqual(await listMedia(context),[]);
  }finally{await pool.end();}
});
