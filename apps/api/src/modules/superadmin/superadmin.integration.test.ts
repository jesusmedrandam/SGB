import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {app} from '../../app.js';
import {pool} from '../../database/pool.js';
import {hashToken} from '../../security/tokens.js';
import {login,register,resendEmailVerification,verifyEmail,refreshSession} from '../auth/auth.service.js';

const metadata={ipAddress:'127.0.0.1',userAgent:'superadmin-support-test'};
test('el soporte accede sin membresía, conserva aislamiento, contexto y autor real en la auditoría',async()=>{
  const server=app.listen(0,'127.0.0.1');
  let adminId='';
  try{
    await new Promise<void>(resolve=>server.once('listening',resolve));
    const address=server.address();assert.ok(address&&typeof address!=='string');
    const base=`http://127.0.0.1:${address.port}`;
    const request=async(token:string,method:string,path:string,body?:unknown,status=200)=>{
      const response=await fetch(base+path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
        ...(body===undefined?{}:{body:JSON.stringify(body)})});
      const data=response.status===204?null:await response.json() as {data:any;error?:unknown};
      assert.equal(response.status,status,`${method} ${path}: ${JSON.stringify(data)}`);
      return data?.data;
    };
    async function owner(){
      const suffix=randomUUID();const email=`support-${suffix}@example.test`;
      const registered=await register({email,password:'Clave-segura-2026',displayName:`Propietario ${suffix}`,propertyName:`Finca ${suffix}`},metadata);
      await pool.query("UPDATE email_verification_token SET created_at=now()-interval '2 minutes' WHERE user_id=$1",[registered.userId]);
      await verifyEmail((await resendEmailVerification(email,metadata)).verificationToken!,metadata);
      const session=await login({email,password:'Clave-segura-2026',deviceId:`support-${suffix}`},metadata);
      const overview=await request(session.accessToken,'GET','/auth/me');
      return {token:session.accessToken,id:session.user.id,accountId:registered.accountId!,propertyId:overview.properties[0].id,
        roleId:overview.properties[0].roles[0].id};
    }
    const first=await owner();const second=await owner();
    const admin=(await pool.query<{id:string;display_name:string}>(
      'SELECT id,display_name FROM app_user WHERE is_superadmin AND deleted_at IS NULL')).rows[0];
    assert.ok(admin,'Run the CI superadmin bootstrap before integration tests');adminId=admin.id;
    let token='support-access-'+randomUUID();let refresh='support-refresh-'+randomUUID();
    await pool.query(`INSERT INTO user_session(user_id,access_token_hash,refresh_token_hash,device_id,access_expires_at,expires_at)
      VALUES($1,$2,$3,$4,now()+interval '15 minutes',now()+interval '1 day')`,[admin.id,hashToken(token),hashToken(refresh),'support-'+randomUUID()]);
    const target={accountId:first.accountId,propertyId:first.propertyId};
    await request(first.token,'POST','/superadmin/support-context',target,403);
    await request(first.token,'GET','/superadmin/overview',undefined,403);
    await assert.rejects(pool.query('UPDATE user_session SET support_mode=true WHERE access_token_hash=$1',
      [hashToken(first.token)]),(error:{code?:string})=>error.code==='23514');
    await request(first.token,'POST','/auth/context',{propertyId:second.propertyId,roleId:second.roleId},403);
    await request(token,'POST','/superadmin/support-context',{...target,propertyId:second.propertyId},403);
    const normal=(await pool.query<{property_id:string;membership_id:string;owner_role:string;viewer_role:string}>(`
      SELECT pm.property_id,pm.id AS membership_id,owner.id AS owner_role,viewer.id AS viewer_role
      FROM property_membership pm
      JOIN property_role owner ON owner.property_id=pm.property_id AND owner.code='OWNER'
      JOIN property_role viewer ON viewer.property_id=pm.property_id AND viewer.code='VIEWER'
      WHERE pm.user_id=$1 AND pm.status='ACTIVE' ORDER BY pm.created_at LIMIT 1`,[admin.id])).rows[0];
    assert.ok(normal,'The auth integration creates the administrator own account');
    await pool.query(`INSERT INTO membership_role(membership_id,property_id,role_id,assigned_by)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[normal.membership_id,normal.property_id,normal.viewer_role,admin.id]);
    await request(token,'POST','/auth/context',{propertyId:first.propertyId,roleId:first.roleId},403);
    await request(token,'POST','/auth/context',{propertyId:normal.property_id,roleId:normal.viewer_role});
    let normalOverview=await request(token,'GET','/auth/me');
    assert.equal(normalOverview.supportMode,false);assert.equal(normalOverview.supportOwner,null);
    assert.equal(normalOverview.user.isSuperadmin,true);
    assert.equal(normalOverview.properties.find((p:any)=>p.id===normal.property_id).roles.find((r:any)=>r.id===normal.viewer_role).code,'VIEWER');
    await request(token,'POST','/groups',{name:'Viewer must not create'},403);
    const normalRefreshed=await refreshSession(refresh,metadata);token=normalRefreshed.accessToken;refresh=normalRefreshed.refreshToken;
    assert.equal((await request(token,'GET','/auth/me')).supportMode,false);
    await request(token,'POST','/auth/context',{propertyId:normal.property_id,roleId:normal.owner_role});
    const normalGroup=await request(token,'POST','/groups',{name:'Cambio de usuario normal'},201);
    const normalEvent=(await request(token,'GET','/audit')).items.find((event:any)=>event.entityId===normalGroup.id);
    assert.ok(normalEvent);assert.equal(normalEvent.superadminAccess,false);assert.equal(normalEvent.actorName,admin.display_name);
    // Support in a property where the administrator also belongs still preserves their normal roles.
    const normalAccount=(await pool.query<{account_id:string}>('SELECT account_id FROM property WHERE id=$1',[normal.property_id])).rows[0]!.account_id;
    await request(token,'POST','/superadmin/support-context',{accountId:normalAccount,propertyId:normal.property_id});
    normalOverview=await request(token,'GET','/auth/me');assert.equal(normalOverview.supportMode,true);
    assert(normalOverview.memberProperties.find((p:any)=>p.id===normal.property_id).roles.some((r:any)=>r.code==='VIEWER'));
    await request(token,'DELETE','/superadmin/support-context',undefined,204);
    normalOverview=await request(token,'GET','/auth/me');assert.equal(normalOverview.supportMode,false);
    assert.equal(normalOverview.activeContext.roleId,normal.owner_role);
    // Refresh may keep explicit support, but it must never infer it from superadministrator identity.
    const selected=await request(token,'POST','/superadmin/support-context',target);
    assert.equal(selected.roleCode,'SUPERADMIN');
    await assert.rejects(pool.query('UPDATE user_session SET support_mode=false WHERE access_token_hash=$1',
      [hashToken(token)]),(error:{code?:string})=>error.code==='23514');
    let overview=await request(token,'GET','/auth/me');
    assert.equal(overview.user.id,admin.id);assert.equal(overview.supportOwner.id,first.id);
    const property=overview.properties.find((item:any)=>item.id===first.propertyId);
    assert(property.roles[0].permissions.includes('ANIMAL_PURGE'));
    assert(property.roles[0].permissions.includes('MEMBERSHIP_MANAGE'));
    assert.equal((await pool.query('SELECT 1 FROM property_membership WHERE user_id=$1 AND property_id=$2',[admin.id,first.propertyId])).rowCount,0);
    const searched=await request(token,'GET',`/superadmin/overview?search=${encodeURIComponent(first.id)}`);
    assert.equal(searched.accounts.length,0);
    const ownerEmail=(await pool.query<{email:string}>('SELECT email FROM app_user WHERE id=$1',[first.id])).rows[0]!.email;
    assert.equal((await request(token,'GET',`/superadmin/overview?search=${encodeURIComponent(ownerEmail)}`)).accounts[0].owner.id,first.id);
    const group=await request(token,'POST','/groups',{name:'Grupo creado por soporte'},201);
    const animal=await request(token,'POST','/animals',{name:'Animal de soporte',sex:'FEMALE',speciesCode:'BOVINE',groupId:group.id},201);
    const changed=await request(token,'PATCH',`/animals/${animal.id}/description`,{description:'Corregido por soporte',expectedVersion:animal.version});
    assert.equal(changed.description,'Corregido por soporte');
    const otherGroup=await request(second.token,'POST','/groups',{name:'Grupo de otra cuenta'},201);
    const otherAnimal=await request(second.token,'POST','/animals',{name:'Otro animal',sex:'FEMALE',speciesCode:'BOVINE',groupId:otherGroup.id},201);
    await request(token,'PATCH',`/animals/${otherAnimal.id}/description`,{description:'No debe cambiar',expectedVersion:otherAnimal.version},404);
    await pool.query("UPDATE property_module SET enabled=false WHERE property_id=$1 AND module_code='WEIGHING'",[first.propertyId]);
    await request(first.token,'GET','/weighings',undefined,403);
    const today=(await pool.query<{today:string}>("SELECT (now() AT TIME ZONE timezone)::date::text AS today FROM property WHERE id=$1",[first.propertyId])).rows[0]!.today;
    await request(token,'POST','/weighings',{animalId:animal.id,weighedOn:today,weight:320,unitCode:'KILOGRAM',method:null,notes:null},201);
    await request(token,'POST','/finances/property/accounts',{name:'Caja de soporte',kind:'CASH',openingBalance:0},201);
    await request(token,'PUT','/property-settings/modules/WEIGHING',{enabled:true});
    for(const path of ['/reproduction','/production','/health-records/medicines','/cleanings/products',
      '/activities','/commerce','/property-team','/property-settings','/agenda','/audit'])await request(token,'GET',path);
    const team=await request(token,'GET','/property-team');
    assert.ok(team.assignableRoles.some((role:any)=>role.code==='ADMINISTRATOR'));
    const task=await request(first.token,'POST','/agenda',{kind:'TASK',activityType:'PERSONALIZADA',
      title:'Tarea del propietario',instructions:null,scheduledAt:new Date().toISOString(),reminderAt:null,
      visibility:'SELECTED',userIds:[first.id],animalIds:[]},201);
    assert.ok((await request(token,'GET','/agenda')).some((item:any)=>item.id===task.id));
    assert.equal((await request(token,'POST',`/agenda/${task.id}/action`,{action:'COMPLETE'})).status,'COMPLETED');
    const refreshed=await refreshSession(refresh,metadata);token=refreshed.accessToken;
    assert.equal(refreshed.activePropertyId,first.propertyId);
    await pool.query("UPDATE administrative_account SET status='SUSPENDED' WHERE id=$1",[first.accountId]);
    await pool.query("UPDATE property SET status='INACTIVE' WHERE id=$1",[first.propertyId]);
    await request(token,'GET','/property-settings');
    await request(token,'PATCH',`/animals/${animal.id}/description`,{description:'Soporte en cuenta suspendida',expectedVersion:changed.version});
    await pool.query("UPDATE administrative_account SET status='ACTIVE' WHERE id=$1",[first.accountId]);
    await pool.query("UPDATE property SET status='ACTIVE' WHERE id=$1",[first.propertyId]);
    const events=await request(first.token,'GET','/audit');
    const event=events.items.find((item:any)=>item.entityId===animal.id&&item.action==='ANIMAL_DESCRIPTION_UPDATED');
    assert.ok(event);assert.equal(event.actorName,'Sistema · soporte');assert.equal(event.actorDisplayName,admin.display_name);
    assert.equal(event.actorUserId,admin.id);assert.equal(event.superadminAccess,true);
    await request(token,'PUT',`/superadmin/accounts/${first.accountId}/modules/WEIGHING`,{enabled:false});
    await request(first.token,'GET','/weighings',undefined,403);
    await request(token,'GET','/weighings');
    await request(token,'PUT',`/superadmin/accounts/${first.accountId}/modules/WEIGHING`,{enabled:true});
    await request(token,'PATCH',`/superadmin/accounts/${first.accountId}`,{maxProperties:2});
    const newProperty=await request(token,'POST','/property-settings/properties',{name:'Propiedad creada por soporte',ownerName:'Dueño de prueba',areaValue:10,areaUnitCode:'HECTARE',address:'Sector de prueba'},201);
    assert.equal(newProperty.accountId,first.accountId);
    assert.equal((await pool.query('SELECT owner_user_id FROM property WHERE id=$1',[newProperty.propertyId])).rows[0].owner_user_id,first.id);
    assert.equal((await pool.query('SELECT 1 FROM property_membership WHERE user_id=$1 AND property_id=$2',[admin.id,newProperty.propertyId])).rowCount,0);
    await request(token,'POST','/superadmin/support-context',target);
    await request(token,'POST','/superadmin/support-context',{accountId:second.accountId,propertyId:second.propertyId});
    assert.equal((await request(token,'GET','/auth/me')).supportOwner.id,second.id);
    await request(token,'GET',`/animals/${animal.id}`,undefined,404);
    await request(token,'POST','/superadmin/support-context',target);
    await pool.query('UPDATE app_user SET is_superadmin=false WHERE id=$1',[admin.id]);
    await request(token,'GET','/animals',undefined,403);
    await request(token,'POST','/superadmin/support-context',target,403);
    await pool.query('UPDATE app_user SET is_superadmin=true WHERE id=$1',[admin.id]);
    await request(token,'DELETE','/superadmin/support-context',undefined,204);
    overview=await request(token,'GET','/auth/me');assert.equal(overview.activeContext.propertyId,normal.property_id);
    assert.equal(overview.activeContext.roleId,normal.owner_role);assert.equal(overview.supportOwner,null);assert.equal(overview.supportMode,false);
    await request(token,'POST','/groups',{name:'Usuario después de finalizar soporte'},201);
    await request(token,'POST','/auth/context',{propertyId:first.propertyId,roleId:first.roleId},403);
    await request(token,'DELETE','/superadmin/support-context',undefined,204);
    assert.equal((await request(token,'GET','/auth/me')).activeContext.roleId,normal.owner_role);
    await request(token,'POST','/superadmin/support-context',target);
    await request(token,'POST','/auth/context',{propertyId:normal.property_id,roleId:normal.viewer_role});
    assert.equal((await request(token,'GET','/auth/me')).supportMode,false);
    await request(token,'POST','/groups',{name:'Viewer after support'},403);
    assert.equal((await request(second.token,'GET',`/animals/${otherAnimal.id}`)).description,null);
  }finally{
    if(adminId)await pool.query('UPDATE app_user SET is_superadmin=true WHERE id=$1',[adminId]);
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await pool.end();
  }
});
