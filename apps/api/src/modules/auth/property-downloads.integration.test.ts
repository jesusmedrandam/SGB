import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {app} from '../../app.js';
import {pool} from '../../database/pool.js';
import {hashToken} from '../../security/tokens.js';
import {register,login,getSessionOverview,resendEmailVerification,verifyEmail,changeContext} from './auth.service.js';
import {createPropertyInvitation,acceptPropertyInvitation,createPropertyRole,getPropertyRoles} from '../collaboration/collaboration.service.js';

const metadata={ipAddress:'127.0.0.1',userAgent:'property-download-test'};
test('lecturas por propiedad y rol sin cambiar la sesión, permisos inmediatos y caché separada',async()=>{
 const server=app.listen(0,'127.0.0.1');
 try{
  await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}`;
  async function user(){
   const email=`property-download-${randomUUID()}@example.test`;
   const registration=await register({email,password:'Clave-segura-2026',displayName:'Dueño',propertyName:'Propiedad '+randomUUID()},metadata);
   await pool.query("UPDATE email_verification_token SET created_at=now()-interval '2 minutes' WHERE user_id=$1",[registration.userId]);
   await verifyEmail((await resendEmailVerification(email,metadata)).verificationToken!,metadata);
   const session=await login({email,password:'Clave-segura-2026',deviceId:randomUUID()},metadata);
   const auth={sessionId:session.sessionId,userId:session.user.id,email,displayName:'Dueño',isSuperadmin:false,activePropertyId:session.activePropertyId,activeRoleId:session.activeRoleId};
   const property=(await getSessionOverview(auth)).properties[0]!,role=property.roles.find(item=>item.code==='OWNER')!;
   const context={propertyId:property.id,propertyName:property.name,roleId:role.id,roleCode:role.code,roleName:role.name,permissions:new Set(role.permissions),enabledModules:new Set(property.enabledModules),enabledSpecies:new Set(property.enabledSpecies)};
   return {auth,context,session};
  }
  const [a,b,c]=await Promise.all([user(),user(),user()]);
  const viewer=(await getPropertyRoles(b.context)).roles.find(role=>role.code==='VIEWER')!;
  const limited=await createPropertyRole(b.auth,b.context,{name:'Solo grupos',description:null,permissions:['GROUP_VIEW']},metadata);
  const invite=await createPropertyInvitation(b.auth,b.context,{email:a.auth.email,roleIds:[viewer.id,limited.id]},metadata);
  const member=await acceptPropertyInvitation(a.auth,invite.invitationToken,metadata);
  await changeContext(a.auth,a.context.propertyId,a.context.roleId,metadata);
  const own={authorization:`Bearer ${a.session.accessToken}`};
  const target={...own,'x-sgb-property-id':b.context.propertyId,'x-sgb-role-id':viewer.id};
  const response=await fetch(url+'/animals?page=1&search=',{headers:target});assert.equal(response.status,200);
  assert.equal(response.headers.get('x-sgb-property-id'),b.context.propertyId);assert.equal(response.headers.get('x-sgb-role-id'),viewer.id);
  assert.match(response.headers.get('vary')!,/x-sgb-property-id/i);assert.match(response.headers.get('vary')!,/x-sgb-role-id/i);
  assert.match(response.headers.get('access-control-expose-headers')!,/x-sgb-property-id/i);
  const overview=(await(await fetch(url+'/auth/me',{headers:own})).json()).data;
  assert.equal(overview.activeContext.propertyId,a.context.propertyId);assert.equal(overview.activeContext.roleId,a.context.roleId);
  assert.equal((await fetch(url+'/animals',{headers:{...target,'x-sgb-role-id':limited.id}})).status,403,'Selected role does not inherit another assigned role permissions');
  assert.equal((await fetch(url+'/animals',{headers:{...target,'x-sgb-role-id':b.context.roleId}})).status,403,'Cannot select an unassigned owner role');
  assert.equal((await fetch(url+'/animals',{headers:{...target,'x-sgb-property-id':c.context.propertyId}})).status,403);
  assert.equal((await fetch(url+'/animals',{headers:{...own,'x-sgb-property-id':b.context.propertyId}})).status,400);
  assert.equal((await fetch(url+'/animals',{headers:{...target,'x-sgb-role-id':'invalid'}})).status,400);
  assert.equal((await fetch(url+'/animals',{method:'POST',headers:{...target,'content-type':'application/json'},body:'{}'})).status,403,'Read context cannot authorize writes');
  assert.equal((await fetch(url+'/animals',{headers:{'x-sgb-property-id':b.context.propertyId,'x-sgb-role-id':viewer.id}})).status,401);
  await pool.query("UPDATE property_membership SET access_until=current_date-2 WHERE id=$1",[member.membershipId]);
  assert.equal((await fetch(url+'/animals',{headers:target})).status,403,'Expired collaboration is rejected');
  await pool.query('UPDATE property_membership SET access_until=NULL WHERE id=$1',[member.membershipId]);
  await pool.query('DELETE FROM membership_role WHERE membership_id=$1 AND role_id=$2',[member.membershipId,viewer.id]);
  assert.equal((await fetch(url+'/animals',{headers:target})).status,403,'Removed role is rejected immediately');
  const saved=(await pool.query('SELECT active_property_id,active_role_id FROM user_session WHERE id=$1',[a.auth.sessionId])).rows[0];
  assert.equal(saved.active_property_id,a.context.propertyId);assert.equal(saved.active_role_id,a.context.roleId);
  const adminUser=(await pool.query<{id:string}>('SELECT id FROM app_user WHERE is_superadmin AND deleted_at IS NULL')).rows[0];
  assert.ok(adminUser,'Run the superadministrator bootstrap before integration tests');
  const accessToken='property-download-admin-'+randomUUID();
  const admin={accessToken,sessionId:(await pool.query<{id:string}>(`INSERT INTO user_session(user_id,access_token_hash,refresh_token_hash,device_id,access_expires_at,expires_at)
    VALUES($1,$2,$3,$4,now()+interval '15 minutes',now()+interval '1 day') RETURNING id`,
    [adminUser.id,hashToken(accessToken),hashToken(randomUUID()),randomUUID()])).rows[0]!.id};
  const adminTarget={...target,authorization:`Bearer ${admin.accessToken}`,'x-sgb-property-id':c.context.propertyId,'x-sgb-role-id':c.context.roleId};
  assert.equal((await fetch(url+'/animals',{headers:adminTarget})).status,403,'Superadmin user mode cannot download unassigned properties');
  await pool.query('UPDATE user_session SET support_mode=true,active_property_id=$2,active_role_id=$3 WHERE id=$1',[admin.sessionId,c.context.propertyId,c.context.roleId]);
  assert.equal((await fetch(url+'/animals',{headers:adminTarget})).status,403,'Support context cannot use membership download override');
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await pool.end();}
});
