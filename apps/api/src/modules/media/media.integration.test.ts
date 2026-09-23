import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {pool} from '../../database/pool.js';
import {inTransaction} from '../../database/transaction.js';
import {getSessionOverview,login,register,resendEmailVerification,verifyEmail} from '../auth/auth.service.js';
import {createAnimal} from '../animals/animals.service.js';
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
    const animal=await createAnimal(auth,context,{name:'Vaca multimedia',sex:'FEMALE',
      speciesCode:'BOVINE'},metadata);
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
