import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {app} from '../../app.js';
import {pool} from '../../database/pool.js';
import {register,login,getSessionOverview,resendEmailVerification,verifyEmail} from '../auth/auth.service.js';
import {createGroup} from '../groups/groups.service.js';
import {createAnimal} from '../animals/animals.service.js';
import {createOwner} from '../animals/owners.service.js';
import {searchExternalDestinations,setExternalTransferVisibility,createExternalTransfer,decideExternalTransfer} from '../movements/external-transfers.service.js';
import {createPropertyInvitation,acceptPropertyInvitation,getPropertyTeam,getPropertyRoles,updatePropertyRole,
  updatePropertyMembershipRoles,updatePropertyMembershipStatus} from './collaboration.service.js';

const metadata={ipAddress:'127.0.0.1',userAgent:'shared-ownership-test'};
const fails=(code:string)=>(error:{code?:string})=>error.code===code;
test('copropietarios con cuenta propia, invitaciones, roles editables, permisos inmediatos y aislamiento',async()=>{
 const server=app.listen(0,'127.0.0.1');
 try{
  await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
  const url=`http://127.0.0.1:${address.port}`;
  async function user(){
    const email=`owners-${randomUUID()}@example.test`;
    const registered=await register({email,password:'Clave-segura-2026',displayName:'Dueño',propertyName:'Propiedad '+randomUUID()},metadata);
    await pool.query("UPDATE email_verification_token SET created_at=now()-interval '2 minutes' WHERE user_id=$1",[registered.userId]);
    await verifyEmail((await resendEmailVerification(email,metadata)).verificationToken!,metadata);
    const session=await login({email,deviceId:randomUUID(),password:'Clave-segura-2026'},metadata);
    const auth={sessionId:session.sessionId,userId:session.user.id,email,displayName:session.user.displayName,isSuperadmin:false,
      activePropertyId:session.activePropertyId,activeRoleId:session.activeRoleId};
    const property=(await getSessionOverview(auth)).properties[0]!;const role=property.roles.find(row=>row.code==='OWNER')!;
    const context={propertyId:property.id,propertyName:property.name,roleId:role.id,roleCode:role.code,roleName:role.name,
      permissions:new Set(role.permissions),enabledModules:new Set(property.enabledModules),enabledSpecies:new Set(property.enabledSpecies)};
    return {auth,context,session};
  }
  const [a,b,c,d]=await Promise.all([user(),user(),user(),user()]);
  const originalRoles=await getPropertyRoles(a.context);const ownerRole=originalRoles.roles.find(role=>role.code==='OWNER')!;
  const adminRole=originalRoles.roles.find(role=>role.code==='ADMINISTRATOR')!;
  const viewerRole=originalRoles.roles.find(role=>role.code==='VIEWER')!;
  assert.ok((await getPropertyTeam(a.auth,a.context)).assignableRoles.some(role=>role.code==='OWNER'));
  const invite=await createPropertyInvitation(a.auth,a.context,{email:b.auth.email,roleIds:[ownerRole.id]},metadata);
  const accepted=await acceptPropertyInvitation(b.auth,invite.invitationToken,metadata);
  const shared={...a.context,roleId:ownerRole.id};
  const overview=await getSessionOverview(b.auth);
  assert.equal(overview.properties.find(property=>property.id===a.context.propertyId)!.isOwner,true);
  assert.equal(overview.properties.find(property=>property.id===b.context.propertyId)!.isOwner,true);
  assert.equal((await pool.query('SELECT owner_user_id FROM property WHERE id=$1',[a.context.propertyId])).rows[0].owner_user_id,a.auth.userId);
  await createGroup(b.auth,shared,{name:'Gestionado por copropietario',kind:'EXTERNAL',externalPlace:'Vecino'},metadata);
  const adminInvite=await createPropertyInvitation(b.auth,shared,{email:c.auth.email,roleIds:[adminRole.id]},metadata);
  const adminAccepted=await acceptPropertyInvitation(c.auth,adminInvite.invitationToken,metadata);
  const admin={...a.context,roleId:adminRole.id,roleCode:'ADMINISTRATOR'};
  await assert.rejects(()=>createPropertyInvitation(c.auth,admin,{email:d.auth.email,roleIds:[ownerRole.id]},metadata),fails('PROPERTY_OWNER_REQUIRED'));
  const update={name:'Consulta con edición',description:'Definido por los propietarios',permissions:['ANIMAL_VIEW','ANIMAL_UPDATE'],expectedVersion:viewerRole.version};
  await assert.rejects(()=>updatePropertyRole(c.auth,{...admin,roleCode:'OWNER'},viewerRole.id,update,metadata),fails('PROPERTY_OWNER_REQUIRED'));
  await updatePropertyRole(b.auth,shared,viewerRole.id,update,metadata);
  await assert.rejects(()=>updatePropertyRole(a.auth,a.context,viewerRole.id,update,metadata),fails('ROLE_CHANGED'));
  await assert.rejects(()=>updatePropertyRole(a.auth,a.context,ownerRole.id,{...update,expectedVersion:ownerRole.version},metadata),fails('OWNER_ROLE_PROTECTED'));
  await assert.rejects(()=>updatePropertyRole(a.auth,a.context,viewerRole.id,{...update,expectedVersion:viewerRole.version+1,permissions:['MADE_UP']},metadata),fails('INVALID_PERMISSIONS'));
  const foreignViewer=(await getPropertyRoles(b.context)).roles.find(role=>role.code==='VIEWER')!;
  await assert.rejects(()=>updatePropertyRole(a.auth,a.context,foreignViewer.id,update,metadata),fails('NOT_FOUND'));
  assert.ok(!foreignViewer.permissions.includes('ANIMAL_UPDATE'));
  await updatePropertyRole(b.auth,shared,adminRole.id,{name:adminRole.name,description:adminRole.description,
    permissions:adminRole.permissions.filter((permission:string)=>permission!=='GROUP_MANAGE'),expectedVersion:adminRole.version},metadata);
  assert.equal((await fetch(url+'/groups',{method:'POST',headers:{authorization:`Bearer ${c.session.accessToken}`,'content-type':'application/json'},
    body:JSON.stringify({name:'No permitido',kind:'EXTERNAL',externalPlace:'Vecino'})})).status,403,'Permission removal takes effect on the next request');
  await updatePropertyMembershipRoles(b.auth,shared,adminAccepted.membershipId,{roleIds:[ownerRole.id],expectedRoleIds:[adminRole.id]},metadata);
  assert.equal((await getSessionOverview(c.auth)).properties.find(property=>property.id===a.context.propertyId)!.isOwner,true);
  const team=await getPropertyTeam(a.auth,a.context);const primary=team.members.find(member=>member.userId===a.auth.userId)!;
  assert.equal(primary.isPrimaryOwner,true);assert.equal(team.members.filter(member=>member.isOwner).length,3);
  await assert.rejects(()=>updatePropertyMembershipRoles(c.auth,shared,primary.id,{roleIds:[viewerRole.id],expectedRoleIds:[ownerRole.id]},metadata),fails('OWNER_MEMBERSHIP_PROTECTED'));
  await assert.rejects(()=>updatePropertyMembershipStatus(c.auth,shared,primary.id,'SUSPENDED',metadata),fails('OWNER_MEMBERSHIP_PROTECTED'));
  const pending=await createPropertyInvitation(b.auth,shared,{email:d.auth.email,roleIds:[ownerRole.id]},metadata);
  const dViewer=await createPropertyInvitation(b.auth,b.context,{email:d.auth.email,roleIds:[foreignViewer.id]},metadata);
  await acceptPropertyInvitation(d.auth,dViewer.invitationToken,metadata);
  await setExternalTransferVisibility(a.auth,a.context,{visibility:'HIDDEN'},metadata);
  assert.equal((await searchExternalDestinations(d.auth,d.context,b.auth.email)).length,0);
  await setExternalTransferVisibility(b.auth,shared,{visibility:'COLLABORATORS'},metadata);
  const found=await searchExternalDestinations(d.auth,d.context,b.auth.email);
  assert.ok(found.some(property=>property.id===a.context.propertyId),'Lookup and collaborator privacy recognize every active co-owner');
  const group=await createGroup(d.auth,d.context,{name:'Origen',kind:'EXTERNAL',externalPlace:'Vecino'},metadata);
  const party=await createOwner(d.auth,d.context,{kind:'USER',userId:d.auth.userId},metadata);
  const animal=await createAnimal(d.auth,d.context,{name:'Solicitud',sex:'FEMALE',speciesCode:'BOVINE',groupId:group.id,owners:[{partyId:party.id,percent:100,isPrimary:true}]},metadata);
  const movementOn=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Guayaquil'}).format(new Date());
  const transfer=await createExternalTransfer(d.auth,d.context,{destinationPropertyId:a.context.propertyId,animalIds:[animal.id],movementOn,reason:'Prueba de copropiedad'},metadata);
  await decideExternalTransfer(d.auth,d.context,transfer.id,{expectedVersion:transfer.version},'CANCELLED',metadata);
  await assert.rejects(()=>updatePropertyMembershipRoles(a.auth,a.context,accepted.membershipId,{roleIds:[viewerRole.id],expectedRoleIds:[adminRole.id]},metadata),fails('MEMBERSHIP_ROLES_CHANGED'));
  await updatePropertyMembershipRoles(a.auth,a.context,accepted.membershipId,{roleIds:[viewerRole.id],expectedRoleIds:[ownerRole.id]},metadata);
  assert.equal((await getSessionOverview(b.auth)).properties.find(property=>property.id===a.context.propertyId)!.isOwner,false);
  assert.equal((await pool.query('SELECT active_property_id FROM user_session WHERE id=$1',[b.auth.sessionId])).rows[0].active_property_id,null);
  assert.ok(!(await searchExternalDestinations(d.auth,d.context,b.auth.email)).some(property=>property.id===a.context.propertyId));
  await assert.rejects(()=>acceptPropertyInvitation(d.auth,pending.invitationToken,metadata),fails('INVITATION_AUTHORITY_REVOKED'));
  await assert.rejects(()=>updatePropertyRole(b.auth,shared,viewerRole.id,{...update,expectedVersion:viewerRole.version+1},metadata),fails('PROPERTY_OWNER_REQUIRED'));
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await pool.end();}
});
