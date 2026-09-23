import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {pool} from '../../database/pool.js';
import {getSessionOverview,login,register,resendEmailVerification,verifyEmail} from '../auth/auth.service.js';
import {createAccountProperty} from '../properties/properties.service.js';
import {createAnimal,getAnimal} from '../animals/animals.service.js';
import {assignAnimalToGroup,createGroup,createLocation,listGroups} from '../groups/groups.service.js';
import {applyMovement,cancelMovement,createMovement,listMovementOptions,listMovements,
  updateMovement} from './movements.service.js';

const metadata={ipAddress:'127.0.0.1',userAgent:'sgb-movement-test'};
const date=()=>new Date().toISOString().slice(0,10);
test('borrador, rotación de grupo, selección manual y traslado conservan historia y permisos',async()=>{
  const suffix=randomUUID();
  try{
    const registration=await register({email:`movement-${suffix}@example.test`,
      password:'Clave-segura-2026',displayName:'Prueba movimientos',
      propertyName:`Finca origen ${suffix}`},metadata);
    await pool.query(`UPDATE email_verification_token SET created_at=now()-interval '2 minutes'
      WHERE user_id=$1`,[registration.userId]);
    await verifyEmail((await resendEmailVerification(`movement-${suffix}@example.test`,metadata))
      .verificationToken!,metadata);
    const session=await login({email:`movement-${suffix}@example.test`,
      password:'Clave-segura-2026',deviceId:`movement-${suffix}`},metadata);
    const overview=await getSessionOverview({sessionId:session.sessionId,userId:session.user.id,
      email:session.user.email,displayName:session.user.displayName,isSuperadmin:false,
      activePropertyId:session.activePropertyId,activeRoleId:session.activeRoleId});
    const property=overview.properties[0]!;
    const role=property.roles.find((entry)=>entry.code==='OWNER')!;
    assert.ok(role.permissions.includes('MOVEMENT_MANAGE'));
    const auth={sessionId:session.sessionId,userId:session.user.id,email:session.user.email,
      displayName:session.user.displayName,isSuperadmin:false,
      activePropertyId:property.id,activeRoleId:role.id};
    const context={propertyId:property.id,propertyName:property.name,roleId:role.id,
      roleCode:role.code,roleName:role.name,permissions:new Set(role.permissions),
      enabledModules:new Set(property.enabledModules),enabledSpecies:new Set(property.enabledSpecies)};
    await pool.query(`UPDATE administrative_account SET max_properties=2 WHERE id=$1`,
      [registration.accountId]);
    const second=await createAccountProperty(auth,context,`Finca destino ${suffix}`,metadata);
    const destinationContext={...context,propertyId:second.propertyId,roleId:second.roleId,
      propertyName:`Finca destino ${suffix}`};
    const sourcePasture=await createLocation(auth,context,{kind:'PASTURE',name:'Potrero primero'},metadata);
    const rotatedPasture=await createLocation(auth,context,{kind:'PASTURE',name:'Potrero segundo'},metadata);
    const groupPasture=await createLocation(auth,context,{kind:'PASTURE',name:'Potrero tercero'},metadata);
    const destPasture=await createLocation(auth,destinationContext,
      {kind:'PASTURE',name:'Potrero destino'},metadata);
    const group=await createGroup(auth,context,{name:'Grupo origen',locationId:sourcePasture.id},metadata);
    const groupTwo=await createGroup(auth,context,{name:'Grupo secundario',locationId:groupPasture.id},metadata);
    const destGroup=await createGroup(auth,destinationContext,
      {name:'Grupo de destino',locationId:destPasture.id},metadata);
    const first=await createAnimal(auth,context,{name:'Vaca a trasladar',sex:'FEMALE',
      speciesCode:'BOVINE'},metadata);
    const other=await createAnimal(auth,context,{name:'Vaca que permanece',sex:'FEMALE',
      speciesCode:'BOVINE'},metadata);
    await assignAnimalToGroup(auth,context,group.id,{animalId:first.id,
      expectedAnimalVersion:first.version},metadata);
    await assignAnimalToGroup(auth,context,group.id,{animalId:other.id,
      expectedAnimalVersion:other.version},metadata);
    const base={sourceGroupId:group.id,destinationPropertyId:property.id,
      destinationGroupId:group.id,movementOn:date(),reason:'Rotación de pastoreo',
      selectionMode:'GRUPO' as const,animalIds:[]};
    const rotation=await createMovement(auth,context,{...base,kind:'UBICACION',
      destinationLocationId:rotatedPasture.id},metadata);
    assert.equal(rotation.status,'BORRADOR');assert.equal(rotation.animals.length,2);
    assert.equal((await listMovementOptions(auth,context)).properties.length,2);
    await assert.rejects(()=>createMovement(auth,context,{...base,kind:'UBICACION',
      destinationLocationId:sourcePasture.id},metadata),
      (error:{code?:string})=>error.code==='MOVEMENT_LOCATION_INVALID');
    await applyMovement(auth,context,rotation.id,metadata);
    assert.equal((await listGroups(context)).find((entry)=>entry.id===group.id)?.location?.id,
      rotatedPasture.id);
    assert.equal((await getAnimal(context,other.id)).location?.id,rotatedPasture.id);
    await assert.rejects(()=>applyMovement(auth,context,rotation.id,metadata),
      (error:{code?:string})=>error.code==='MOVEMENT_ALREADY_FINAL');
    const change=await createMovement(auth,context,{...base,kind:'GRUPO',
      selectionMode:'MANUAL',animalIds:[first.id],destinationGroupId:groupTwo.id,
      reason:'Cambio de grupo'},metadata);
    await applyMovement(auth,context,change.id,metadata);
    assert.equal((await getAnimal(context,first.id)).group?.id,groupTwo.id);
    assert.equal((await getAnimal(context,other.id)).group?.id,group.id);
    const relocation=await createMovement(auth,context,{kind:'PROPIEDAD',
      selectionMode:'MANUAL',sourceGroupId:groupTwo.id,destinationGroupId:destGroup.id,
      destinationPropertyId:second.propertyId,movementOn:date(),reason:'Traslado a segunda finca',
      animalIds:[first.id]},metadata);
    await assert.rejects(()=>createMovement(auth,context,{kind:'PROPIEDAD',
      selectionMode:'MANUAL',sourceGroupId:groupTwo.id,destinationGroupId:destGroup.id,
      destinationPropertyId:randomUUID(),movementOn:date(),reason:'Destino ajeno',
      animalIds:[first.id]},metadata),
      (error:{code?:string})=>error.code==='MOVEMENT_DESTINATION_DENIED');
    const edited=await updateMovement(auth,context,relocation.id,{kind:'PROPIEDAD',
      selectionMode:'MANUAL',sourceGroupId:groupTwo.id,destinationGroupId:destGroup.id,
      destinationPropertyId:second.propertyId,movementOn:date(),reason:'Traslado definitivo',
      animalIds:[first.id],expectedVersion:relocation.version},metadata);
    assert.equal(edited.version,relocation.version+1);
    await applyMovement(auth,context,relocation.id,metadata);
    assert.equal((await getAnimal(destinationContext,first.id)).group?.id,destGroup.id);
    assert.equal((await getAnimal(destinationContext,first.id)).location?.id,destPasture.id);
    assert.equal((await listMovements(destinationContext)).find((entry)=>entry.id===relocation.id)?.status,
      'COMPLETADO');
    assert.equal((await listMovements(context)).find((entry)=>entry.id===rotation.id)?.status,
      'COMPLETADO');
    const intervals=await pool.query<{property_id:string;ended_at:Date|null}>(
      `SELECT property_id,ended_at FROM animal_group_assignment WHERE animal_id=$1
       ORDER BY started_at,created_at`,[first.id]);
    assert.equal(intervals.rows.length,3);
    assert.ok(intervals.rows[0]?.ended_at && intervals.rows[1]?.ended_at);
    assert.equal(intervals.rows[2]?.property_id,second.propertyId);
    const toCancel=await createMovement(auth,context,{...base,kind:'GRUPO',
      sourceGroupId:group.id,destinationGroupId:groupTwo.id,selectionMode:'MANUAL',
      animalIds:[other.id],reason:'Borrador cancelable'},metadata);
    await cancelMovement(auth,context,toCancel.id,metadata);
    await assert.rejects(()=>applyMovement(auth,context,toCancel.id,metadata),
      (error:{code?:string})=>error.code==='MOVEMENT_ALREADY_FINAL');
    const viewer=(await pool.query<{id:string}>(
      `SELECT id FROM property_role WHERE property_id=$1 AND code='VIEWER'`,[property.id])).rows[0]!;
    await assert.rejects(()=>createMovement({...auth,activeRoleId:viewer.id},
      {...context,roleId:viewer.id},{...base,kind:'UBICACION',
        destinationLocationId:sourcePasture.id},metadata),
    (error:{code?:string})=>error.code==='MOVEMENT_DENIED');
  }finally{await pool.end();}
});
