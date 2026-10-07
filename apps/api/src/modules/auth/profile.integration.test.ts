import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import {app} from '../../app.js';
import {pool} from '../../database/pool.js';
import {issueToken} from '../../security/tokens.js';
import {login,register,verifyEmail} from './auth.service.js';

test('el perfil personal valida fotos y el cambio de contraseña revoca las otras sesiones sin revelar claves',async()=>{
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const origin=`http://127.0.0.1:${address.port}`;const suffix=randomUUID();
  const email=`profile-${suffix}@example.test`,password='Clave-segura-2026',replacement='Nueva-clave-segura-2026';
  const metadata={ipAddress:'127.0.0.1',userAgent:'sgb-profile-test'};
  const call=async(path:string,token:string|null,body?:unknown)=>fetch(origin+'/auth/'+path,{
    method:body===undefined?'GET':path==='profile'?'PATCH':'POST',headers:{'content-type':'application/json',
      ...(token?{authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  try{
    const registration=await register({email,password,displayName:'Ana inicial',propertyName:`Finca ${suffix}`},metadata);
    await verifyEmail(registration.verificationToken,metadata);
    const session=await login({email,password,deviceId:`current-${suffix}`},metadata);
    const other=await login({email,password,deviceId:`other-${suffix}`},metadata);
    assert.equal((await call('profile',null,{displayName:'Otro nombre'})).status,401);
    assert.equal((await call('profile',session.accessToken,{displayName:'Otro nombre',userId:randomUUID()})).status,400);
    assert.equal((await call('profile',session.accessToken,{displayName:'Ana',isSuperadmin:true})).status,400);
    assert.equal((await call('profile',session.accessToken,{displayName:'Ana',profilePhoto:'data:image/jpeg;base64,SGVsbG8='})).status,400);
    const image=await sharp({create:{width:400,height:300,channels:3,background:'#16834f'}}).jpeg().toBuffer();
    const saved=await call('profile',session.accessToken,{displayName:'  Ana nueva  ',profilePhoto:`data:image/jpeg;base64,${image.toString('base64')}`});
    assert.equal(saved.status,200);const user=(await saved.json()).data;
    assert.equal(user.id,registration.userId);assert.equal(user.displayName,'Ana nueva');assert.equal(user.email,email);
    assert.match(user.profilePhoto,/^data:image\/webp;base64,/);assert.ok(!JSON.stringify(user).includes('password'));
    const resized=await sharp(Buffer.from(user.profilePhoto.split(',')[1],'base64')).metadata();
    assert.equal(resized.width,256);assert.equal(resized.height,256);
    assert.equal((await call('profile',session.accessToken,{displayName:'Ana final'})).status,200);
    assert.equal((await(await call('me',session.accessToken)).json()).data.user.profilePhoto,user.profilePhoto);
    const reset=issueToken('reset');await pool.query(`INSERT INTO password_reset_token(user_id,token_hash,expires_at)
      VALUES($1,$2,now()+interval '30 minutes')`,[registration.userId,reset.hash]);
    assert.equal((await call('password',session.accessToken,{currentPassword:'Incorrecta-2026',newPassword:replacement})).status,400);
    assert.equal((await call('me',other.accessToken)).status,200);
    assert.equal((await call('password',session.accessToken,{currentPassword:password,newPassword:'débil'})).status,400);
    const changed=await call('password',session.accessToken,{currentPassword:password,newPassword:replacement});
    assert.equal(changed.status,200);assert.deepEqual((await changed.json()).data,{changed:true});
    assert.equal((await call('me',session.accessToken)).status,200);assert.equal((await call('me',other.accessToken)).status,401);
    assert.equal((await pool.query(`SELECT consumed_at IS NOT NULL AS consumed FROM password_reset_token WHERE token_hash=$1`,[reset.hash])).rows[0].consumed,true);
    await assert.rejects(()=>login({email,password,deviceId:`old-${suffix}`},metadata));
    assert.equal((await login({email,password:replacement,deviceId:`new-${suffix}`},metadata)).user.displayName,'Ana final');
    const audit=(await pool.query(`SELECT action,before_data,after_data FROM audit_event WHERE actor_user_id=$1
      AND action IN ('USER_PROFILE_UPDATED','USER_PASSWORD_CHANGED')`,[registration.userId])).rows;
    assert.equal(audit.filter(row=>row.action==='USER_PASSWORD_CHANGED').length,1);
    assert.ok(!JSON.stringify(audit).includes(password)&&!JSON.stringify(audit).includes(replacement));
    assert.ok(!JSON.stringify(audit).includes('base64')&&!JSON.stringify(audit).includes('password_hash'));
    await pool.query(`UPDATE user_session SET active_property_id=NULL,active_role_id=NULL WHERE id=$1`,[session.sessionId]);
    assert.equal((await call('profile',session.accessToken,{displayName:'Ana sin propiedad',profilePhoto:null})).status,200);
    assert.equal((await(await call('me',session.accessToken)).json()).data.user.profilePhoto,null);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();}
});
