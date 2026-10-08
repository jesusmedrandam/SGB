import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';

// Fake delivery captures verification links without contacting an email provider.
process.env.BREVO_API_KEY='test-email-provider-key-2026';
process.env.BREVO_SENDER_EMAIL='sender@example.test';
const originalFetch=globalThis.fetch;
const deliveries:Array<{to:Array<{email:string}>;tags:string[];htmlContent:string}>=[];
globalThis.fetch=async(url,init)=>{
  if(String(url)==='https://api.brevo.com/v3/smtp/email'){
    deliveries.push(JSON.parse(String(init?.body)));return new Response('{}',{status:201});
  }
  return originalFetch(url,init);
};
const {app}=await import('../../app.js');
const {pool}=await import('../../database/pool.js');
const {login,register,verifyEmail,refreshSession}=await import('./auth.service.js');
const {requestEmailChange,confirmEmailChange}=await import('./account-security.service.js');
const {changePassword}=await import('./profile.service.js');
const {issueToken}=await import('../../security/tokens.js');

test('correo verificado y sesiones propias: enlaces únicos, aislamiento y revocación real',async()=>{
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`;
  const suffix=randomUUID(),password='Clave-segura-2026',email=`account-${suffix}@example.test`,newEmail=`new-${suffix}@example.test`;
  const metadata={ipAddress:'127.0.0.1',userAgent:'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.0.0'};
  const call=(path:string,method='GET',token?:string,body?:unknown)=>originalFetch(origin+'/auth/'+path,{method,
    headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const latestToken=()=>{
    const message=deliveries.filter(item=>item.tags.includes('sgb-email-change')).at(-1)!;
    const link=message.htmlContent.match(/href="([^"]+)"/)![1]!.replaceAll('&amp;','&');
    return new URL(link).searchParams.get('change-email')!;
  };
  try{
    const user=await register({email,password,displayName:'Ana sesiones',propertyName:`Cuenta ${suffix}`},metadata);
    await verifyEmail(user.verificationToken,metadata);
    const session=await login({email,password,deviceId:`current-${suffix}`},metadata);
    const other=await login({email,password,deviceId:`other-${suffix}`,deviceName:'Mi teléfono'},metadata);
    const foreignUser=await register({email:`foreign-${suffix}@example.test`,password,displayName:'Otra persona',propertyName:`Otra ${suffix}`},metadata);
    await verifyEmail(foreignUser.verificationToken,metadata);
    const foreign=await login({email:`foreign-${suffix}@example.test`,password,deviceId:`foreign-${suffix}`},metadata);
    const auth={sessionId:session.sessionId,userId:user.userId,email,displayName:'Ana sesiones',isSuperadmin:false,
      activePropertyId:session.activePropertyId,activeRoleId:session.activeRoleId};
    assert.equal((await call('sessions')).status,401);
    const sessions=await(await call('sessions','GET',session.accessToken)).json();
    assert.equal(sessions.data.length,2);assert.equal(sessions.data[0].current,true);
    assert.equal(sessions.data[0].deviceName,'Windows · Chrome');assert.equal(sessions.data[1].deviceName,'Mi teléfono');
    for(const field of ['token','user_agent','ip_address','device_id'])assert.ok(!JSON.stringify(sessions.data).includes(field));
    assert.equal((await call(`sessions/${foreign.sessionId}`,'DELETE',session.accessToken)).status,404);
    assert.equal((await call('me','GET',foreign.accessToken)).status,200);
    assert.equal((await call('email','POST',session.accessToken,{email:newEmail,currentPassword:'Incorrecta'})).status,400);
    assert.equal((await call('email','POST',session.accessToken,{email,currentPassword:password})).status,400);
    assert.equal((await call('email','POST',session.accessToken,{email:foreign.user.email,currentPassword:password})).status,409);
    assert.equal((await call('email','POST',session.accessToken,{email:newEmail,currentPassword:password})).status,202);
    const token=latestToken();assert.equal(deliveries.at(-1)!.to[0]!.email,newEmail);
    assert.equal((await(await call('me','GET',session.accessToken)).json()).data.user.email,email);
    assert.equal((await call('email/confirm','POST',undefined,{token:'sgb_ev_'+randomUUID()+randomUUID()})).status,401);
    await requestEmailChange(auth,{email:newEmail,currentPassword:password},metadata);const replacement=latestToken();
    await assert.rejects(()=>confirmEmailChange(token,metadata));
    await pool.query(`UPDATE email_change_token SET expires_at=now()-interval '1 second' WHERE user_id=$1 AND consumed_at IS NULL`,[user.userId]);
    await assert.rejects(()=>confirmEmailChange(replacement,metadata));
    const collisionEmail=`collision-${suffix}@example.test`;
    await requestEmailChange(auth,{email:collisionEmail,currentPassword:password},metadata);const collision=latestToken();
    await register({email:collisionEmail,password,displayName:'Correo ocupado',propertyName:`Colisión ${suffix}`},metadata);
    await assert.rejects(()=>confirmEmailChange(collision,metadata),(error:{code?:string})=>error.code==='EMAIL_UNAVAILABLE');
    assert.equal((await(await call('me','GET',session.accessToken)).json()).data.user.email,email);
    globalThis.fetch=async()=>new Response('{}',{status:503});
    await assert.rejects(()=>requestEmailChange(auth,{email:newEmail,currentPassword:password},metadata),
      (error:{code?:string})=>error.code==='EMAIL_DELIVERY_FAILED');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM email_change_token WHERE user_id=$1 AND consumed_at IS NULL',[user.userId])).rows[0].count,0);
    globalThis.fetch=async(url,init)=>{
      if(String(url)==='https://api.brevo.com/v3/smtp/email'){
        deliveries.push(JSON.parse(String(init?.body)));return new Response('{}',{status:201});
      }
      return originalFetch(url,init);
    };
    await requestEmailChange(auth,{email:newEmail,currentPassword:password},metadata);const cancelled=latestToken();
    await changePassword(auth,{currentPassword:password,newPassword:'Otra-clave-segura-2026'},metadata);
    await assert.rejects(()=>confirmEmailChange(cancelled,metadata));
    assert.equal((await call('me','GET',other.accessToken)).status,401);
    const reset=issueToken('reset');await pool.query(`INSERT INTO password_reset_token(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')`,[user.userId,reset.hash]);
    await requestEmailChange(auth,{email:newEmail,currentPassword:'Otra-clave-segura-2026'},metadata);
    const confirm=await call('email/confirm','POST',undefined,{token:latestToken()});assert.equal(confirm.status,200);
    assert.equal((await call('me','GET',session.accessToken)).status,401);
    await assert.rejects(()=>refreshSession(session.refreshToken,metadata));
    assert.equal((await pool.query('SELECT consumed_at IS NOT NULL AS consumed FROM password_reset_token WHERE token_hash=$1',[reset.hash])).rows[0].consumed,true);
    assert.equal(deliveries.at(-1)!.to[0]!.email,email);assert.ok(deliveries.at(-1)!.htmlContent.includes(newEmail));
    await assert.rejects(()=>confirmEmailChange(latestToken(),metadata));
    await assert.rejects(()=>login({email,password:'Otra-clave-segura-2026',deviceId:`old-${suffix}`},metadata));
    const renewed=await login({email:newEmail,password:'Otra-clave-segura-2026',deviceId:`new-${suffix}`},metadata);
    const second=await login({email:newEmail,password:'Otra-clave-segura-2026',deviceId:`second-${suffix}`},metadata);
    const revoked=await call(`sessions/${second.sessionId}`,'DELETE',renewed.accessToken);assert.equal(revoked.status,200);
    assert.equal((await call('me','GET',second.accessToken)).status,401);await assert.rejects(()=>refreshSession(second.refreshToken,metadata));
    const third=await login({email:newEmail,password:'Otra-clave-segura-2026',deviceId:`third-${suffix}`},metadata);
    assert.equal((await call('sessions/revoke-others','POST',renewed.accessToken)).status,200);
    assert.equal((await call('me','GET',renewed.accessToken)).status,200);assert.equal((await call('me','GET',third.accessToken)).status,401);
    assert.equal((await call(`sessions/${renewed.sessionId}`,'DELETE',renewed.accessToken)).status,200);
    assert.equal((await call('me','GET',renewed.accessToken)).status,401);
    const audit=(await pool.query('SELECT after_data FROM audit_event WHERE actor_user_id=$1',[user.userId])).rows;
    assert.ok(!JSON.stringify(audit).includes(password)&&!JSON.stringify(audit).includes('sgb_ev_')&&!JSON.stringify(audit).includes('token_hash'));
  }finally{globalThis.fetch=originalFetch;await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();}
});
