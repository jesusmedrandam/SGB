import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {pool} from '../../database/pool.js';
import {register,login,getSessionOverview,resendEmailVerification,verifyEmail} from '../auth/auth.service.js';
import {createAccountProperty} from '../properties/properties.service.js';
import {createAnimal,getAnimal} from '../animals/animals.service.js';
import {createGroup,createLocation} from '../groups/groups.service.js';
import {applyMovement,createMovement,listMovementOptions} from './movements.service.js';
import {getExternalTransferSettings,setExternalTransferSettings,setExternalTransferVisibility,searchExternalDestinations,
  createExternalTransfer,acceptExternalTransfer,decideExternalTransfer} from './external-transfers.service.js';
import {externalTransferSchema,externalVisibilitySchema} from './external-transfers.schemas.js';

const metadata={ipAddress:'127.0.0.1',userAgent:'transfer-discovery-test'};
const fails=(code:string)=>(error:{code?:string})=>error.code===code;
const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Guayaquil'}).format(new Date());

test('correo, visibilidad temporal, colaboradores compartidos y administradores en traslados internos/externos',async()=>{
 try{
  async function owner(){
   const email=`discovery-${randomUUID()}@example.test`;
   const registration=await register({email,password:'Clave-segura-2026',displayName:'Dueño',propertyName:`Propiedad ${randomUUID()}`},metadata);
   await pool.query("UPDATE email_verification_token SET created_at=now()-interval '2 minutes' WHERE user_id=$1",[registration.userId]);
   await verifyEmail((await resendEmailVerification(email,metadata)).verificationToken!,metadata);
   const session=await login({email,password:'Clave-segura-2026',deviceId:randomUUID()},metadata);
   const auth={sessionId:session.sessionId,userId:session.user.id,email,displayName:session.user.displayName,isSuperadmin:false,
    activePropertyId:session.activePropertyId,activeRoleId:session.activeRoleId};
   const property=(await getSessionOverview(auth)).properties[0]!,role=property.roles.find(row=>row.code==='OWNER')!;
   const context={propertyId:property.id,propertyName:property.name,roleId:role.id,roleName:role.name,roleCode:role.code,
    permissions:new Set(role.permissions),enabledModules:new Set(property.enabledModules),enabledSpecies:new Set(property.enabledSpecies)};
   const location=await createLocation(auth,context,{kind:'PASTURE',name:'Potrero'},metadata);
   const group=await createGroup(auth,context,{name:'Grupo',locationId:location.id},metadata);
   await pool.query('UPDATE administrative_account SET max_properties=3 WHERE id=$1',[registration.accountId]);
   await setExternalTransferSettings(auth,context,true,metadata);
   return {auth,context,group};
  }
  const a=await owner(),b=await owner(),c=await owner();
  async function member(user:typeof a,target:typeof a,code='ADMINISTRATOR'){
   const role=(await pool.query('SELECT id,name FROM property_role WHERE property_id=$1 AND code=$2',[target.context.propertyId,code])).rows[0];
   const membership=(await pool.query(`INSERT INTO property_membership(property_id,user_id,status,created_by) VALUES($1,$2,'ACTIVE',$3)
     ON CONFLICT(property_id,user_id) DO UPDATE SET status='ACTIVE' RETURNING id`,[target.context.propertyId,user.auth.userId,target.auth.userId])).rows[0];
   await pool.query(`INSERT INTO membership_role(membership_id,property_id,role_id,assigned_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [membership.id,target.context.propertyId,role.id,target.auth.userId]);
   const permissions=(await pool.query('SELECT permission_code FROM role_permission WHERE role_id=$1',[role.id])).rows.map(row=>row.permission_code as string);
   return {...target.context,roleId:role.id,roleName:role.name,roleCode:code,permissions:new Set(permissions)};
  }
  const sourceAdmin=await member(c,a);
  assert.equal((await getExternalTransferSettings(c.auth,sourceAdmin)).canRequest,true);
  assert.equal((await getExternalTransferSettings(c.auth,sourceAdmin)).canManageVisibility,true);
  assert.equal((await getExternalTransferSettings(c.auth,sourceAdmin)).canManage,false);
  assert.deepEqual(await searchExternalDestinations(c.auth,sourceAdmin,b.auth.email),[],'Hidden properties do not reveal account existence');
  assert.deepEqual(await searchExternalDestinations(c.auth,sourceAdmin,'absent@example.test'),[]);
  await setExternalTransferVisibility(b.auth,b.context,{visibility:'PUBLIC'},metadata);
  await setExternalTransferSettings(a.auth,a.context,false,metadata);
  await setExternalTransferSettings(b.auth,b.context,false,metadata);
  assert.equal((await searchExternalDestinations(c.auth,sourceAdmin,b.auth.email.toUpperCase()))[0]?.id,b.context.propertyId,'Unrelated administrators can discover public properties');
  assert.deepEqual(await searchExternalDestinations(c.auth,sourceAdmin,a.auth.email),[],'Same-owner destinations use the internal flow');
  const second=await createAccountProperty(b.auth,b.context,'Segunda propiedad visible',metadata);
  const secondContext={...b.context,propertyId:second.propertyId,roleId:second.roleId};
  await setExternalTransferVisibility(b.auth,secondContext,{visibility:'PUBLIC'},metadata);
  assert.equal((await searchExternalDestinations(c.auth,sourceAdmin,b.auth.email)).length,2,'Each visible property can be selected');
  await setExternalTransferVisibility(b.auth,b.context,{visibility:'COLLABORATORS'},metadata);
  assert.equal((await searchExternalDestinations(c.auth,sourceAdmin,b.auth.email)).length,1);
  await member(c,b,'VIEWER');
  assert.equal((await searchExternalDestinations(c.auth,sourceAdmin,b.auth.email)).length,2,'Members of the owner property see collaborator visibility');
  await pool.query("UPDATE property_membership SET status='SUSPENDED' WHERE user_id=$1 AND property_id=$2",[c.auth.userId,b.context.propertyId]);
  assert.equal((await searchExternalDestinations(c.auth,sourceAdmin,b.auth.email)).length,1,'Suspended collaboration grants no visibility');
  await member(b,a,'VIEWER');
  assert.equal((await searchExternalDestinations(c.auth,sourceAdmin,b.auth.email)).length,2,'Coworkers on a third-owner property share collaborator visibility');
  await pool.query("UPDATE property_membership SET status='SUSPENDED' WHERE user_id=$1 AND property_id=$2",[b.auth.userId,a.context.propertyId]);
  const limited=await member(c,a,'VIEWER');
  await assert.rejects(()=>searchExternalDestinations(c.auth,limited,b.auth.email),fails('EXTERNAL_TRANSFER_ADMIN_REQUIRED'));
  await assert.rejects(()=>setExternalTransferVisibility(c.auth,limited,{visibility:'PUBLIC'},metadata),fails('EXTERNAL_TRANSFER_ADMIN_REQUIRED'));
  await assert.rejects(()=>setExternalTransferSettings(c.auth,sourceAdmin,false,metadata),fails('EXTERNAL_TRANSFER_OWNER_REQUIRED'));
  await setExternalTransferVisibility(c.auth,sourceAdmin,{visibility:'PUBLIC',durationDays:2},metadata);
  const settings=await getExternalTransferSettings(c.auth,sourceAdmin);
  assert.ok(settings.visibleUntil&&settings.visibleUntil.getTime()>Date.now()+47*60*60*1000);
  assert.equal(externalVisibilitySchema.safeParse({visibility:'HIDDEN',durationDays:2}).success,false);
  assert.equal(externalVisibilitySchema.safeParse({visibility:'PUBLIC',durationDays:0}).success,false);
  assert.equal(externalTransferSchema.safeParse({destinationPropertyId:b.context.propertyId,animalIds:[],movementOn:today(),reason:'Traslado'}).success,false);
  const animal=await createAnimal(a.auth,a.context,{name:'Animal a recibir',sex:'FEMALE',speciesCode:'BOVINE',groupId:a.group.id},metadata);
  const input={destinationPropertyId:b.context.propertyId,animalIds:[animal.id],movementOn:today(),reason:'Traslado por correo'};
  await setExternalTransferVisibility(b.auth,b.context,{visibility:'PUBLIC',durationDays:1},metadata);
  await pool.query("UPDATE property SET external_transfer_visible_until=now()-interval '1 minute' WHERE id=$1",[b.context.propertyId]);
  assert.equal((await getExternalTransferSettings(b.auth,b.context)).effectiveVisibility,'HIDDEN');
  assert.equal((await searchExternalDestinations(c.auth,sourceAdmin,b.auth.email)).length,1);
  await assert.rejects(()=>createExternalTransfer(c.auth,sourceAdmin,input,metadata),fails('EXTERNAL_DESTINATION_UNAVAILABLE'));
  await setExternalTransferVisibility(b.auth,b.context,{visibility:'PUBLIC'},metadata);
  const receiverAdmin=await member(a,b);
  const rejected=await createExternalTransfer(c.auth,sourceAdmin,input,metadata);
  assert.equal(rejected.status,'PENDING');assert.equal((await getAnimal(a.context,animal.id)).availabilityStatusCode,'ACTIVE');
  await decideExternalTransfer(a.auth,receiverAdmin,rejected.id,{expectedVersion:rejected.version},'REJECTED',metadata);
  assert.equal((await getAnimal(a.context,animal.id)).availabilityStatusCode,'ACTIVE');
  const pending=await createExternalTransfer(c.auth,sourceAdmin,input,metadata);
  await setExternalTransferVisibility(a.auth,receiverAdmin,{visibility:'HIDDEN'},metadata);
  const accepted=await acceptExternalTransfer(a.auth,receiverAdmin,pending.id,{expectedVersion:pending.version,groupId:b.group.id},metadata);
  assert.equal(accepted.status,'ACCEPTED','A receiver administrator can approve an existing request after hiding discovery');
  assert.equal((await getAnimal(a.context,animal.id)).availabilityStatusCode,'INACTIVE');
  const internalProperty=await createAccountProperty(a.auth,a.context,'Destino del mismo dueño',metadata);
  const internalContext={...a.context,propertyId:internalProperty.propertyId,roleId:internalProperty.roleId};
  const internalTarget={...a,context:internalContext};
  await member(c,internalTarget);
  const place=await createLocation(a.auth,internalContext,{kind:'PASTURE',name:'Potrero interno'},metadata);
  const group=await createGroup(a.auth,internalContext,{name:'Grupo interno',locationId:place.id},metadata);
  const internalAnimal=await createAnimal(a.auth,a.context,{name:'Animal interno',sex:'MALE',speciesCode:'BOVINE',groupId:a.group.id},metadata);
  assert.ok((await listMovementOptions(c.auth,sourceAdmin)).properties.some(row=>row.id===internalProperty.propertyId));
  const draft=await createMovement(c.auth,sourceAdmin,{kind:'PROPIEDAD',selectionMode:'MANUAL',sourceGroupId:a.group.id,
    destinationPropertyId:internalProperty.propertyId,destinationGroupId:group.id,animalIds:[internalAnimal.id],movementOn:today(),reason:'Traslado interno por administrador'},metadata);
  await applyMovement(c.auth,sourceAdmin,draft.id,metadata);
  assert.equal((await getAnimal(internalContext,internalAnimal.id)).group?.id,group.id);
 }finally{await pool.end();}
});
