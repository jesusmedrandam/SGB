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
import {addMedia,listMedia,updateMediaDetails,validateTarget} from './media.service.js';
import {env} from '../../config.js';
import {app} from '../../app.js';
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
    assert.deepEqual((await listAnimals(context,{page:1,search:'',classification:'TERNERO'})).items.map(item=>item.id),[calf.id]);
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
    // A storage fixture exercises metadata without uploading to an external provider.
    env.CLOUDINARY_CLOUD_NAME='sgb-test';env.CLOUDINARY_API_KEY='test';env.CLOUDINARY_API_SECRET='test';
    const accountId=(await pool.query<{account_id:string}>('SELECT account_id FROM property WHERE id=$1',[property.id])).rows[0]!.account_id;
    const object=(await pool.query<{id:string}>(`INSERT INTO storage_object(account_id,origin_property_id,
      provider,provider_asset_id,storage_key,sha256,kind,mime_type,byte_size,status,created_by)
      VALUES($1,$2,'CLOUDINARY',$3,$3,$4,'IMAGE','image/jpeg',16,'AVAILABLE',$5) RETURNING id`,
      [accountId,property.id,'metadata-'+suffix,suffix.replaceAll('-','').padEnd(64,'0'),auth.userId])).rows[0]!.id;
    let attachment=(await pool.query<{id:string}>(`INSERT INTO media_attachment(account_id,storage_object_id,
      property_id,entity_type,entity_id,relation_code,created_by) VALUES($1,$2,$3,'ANIMAL',$4,'GENERAL',$5) RETURNING id`,
      [accountId,object,property.id,animal.id,auth.userId])).rows[0]!.id;
    await pool.query("UPDATE storage_object SET created_at='2026-10-01T15:00:00Z' WHERE id=$1",[object]);
    const tag=(await pool.query<{id:string}>("SELECT id FROM governed_catalog_item WHERE catalog_code='MEDIA_TAGS' AND item_code='BIRTH'")).rows[0]!.id;
    const input={capturedOn:'2026-09-30',description:'Foto editada',animalIds:[father.id],tagIds:[tag],expectedAttachmentIds:[attachment]};
    const changed=await updateMediaDetails(auth,context,object,input);
    const photos=await listMedia(context,undefined,undefined,object);
    assert.equal(photos.length,1);assert.equal(photos[0]!.entity_id,father.id);
    assert.equal(photos[0]!.captured_on,input.capturedOn);assert.equal(photos[0]!.description,input.description);
    assert.equal(photos[0]!.tags[0]!.id,tag);assert.deepEqual(changed,[photos[0]!.id]);
    await assert.rejects(()=>updateMediaDetails(auth,context,object,input),(error:{code?:string})=>error.code==='MEDIA_RELATIONS_CHANGED');
    attachment=photos[0]!.id;
    await assert.rejects(()=>updateMediaDetails(auth,{...context,permissions:new Set(['MEDIA_VIEW'])},object,
      {...input,expectedAttachmentIds:[attachment]}),(error:{code?:string})=>error.code==='PERMISSION_DENIED');
    await assert.rejects(()=>updateMediaDetails(auth,{...context,propertyId:randomUUID()},object,
      {...input,expectedAttachmentIds:[attachment]}));
    await assert.rejects(()=>updateMediaDetails(auth,context,object,{...input,tagIds:[randomUUID()],expectedAttachmentIds:[attachment]}),
      (error:{code?:string})=>error.code==='MEDIA_TAG_INVALID');
    await updateMediaDetails(auth,context,object,{...input,capturedOn:null,description:null,tagIds:[],expectedAttachmentIds:[attachment]});
    const cleared=(await listMedia(context,undefined,undefined,object))[0]!;
    assert.equal(cleared.captured_on,null);assert.equal(cleared.description,null);assert.deepEqual(cleared.tags,[]);
    assert.equal(new Date(cleared.created_at).toISOString().slice(0,10),'2026-10-01','Fallback date is the original upload, even after relinking');
    await pool.query("UPDATE media_attachment SET relation_code='PROFILE' WHERE id=$1",[attachment]);
    await assert.rejects(()=>updateMediaDetails(auth,context,object,{...input,animalIds:[animal.id],expectedAttachmentIds:[attachment]}),
      (error:{code?:string})=>error.code==='MEDIA_ROLE_INVALID');
    assert.equal((await listMedia(context,undefined,undefined,object))[0]!.relation_code,'PROFILE');
    assert.equal((await pool.query<{byte_size:string}>('SELECT byte_size FROM storage_object WHERE id=$1',[object])).rows[0]!.byte_size,'16');
    const server=app.listen(0,'127.0.0.1');
    try{
      await new Promise<void>(resolve=>server.once('listening',resolve));
      const address=server.address();assert.ok(address&&typeof address!=='string');
      const endpoint=`http://127.0.0.1:${address.port}/media/objects/${object}`;
      assert.equal((await fetch(endpoint,{method:'PATCH'})).status,401);
      const request={method:'PATCH',headers:{authorization:`Bearer ${session.accessToken}`,'content-type':'application/json'},
        body:JSON.stringify({...input,capturedOn:'1900-01-01',expectedAttachmentIds:[attachment]})};
      const response=await fetch(endpoint,request);assert.equal(response.status,200);
      const saved=await response.json() as {data:{attachments:Array<{id:string;captured_on:string}>}};
      assert.equal(saved.data.attachments[0]!.id,attachment);assert.equal(saved.data.attachments[0]!.captured_on,'1900-01-01');
      request.body=JSON.stringify({...input,capturedOn:'2026-02-30',expectedAttachmentIds:[attachment]});
      assert.equal((await fetch(endpoint,request)).status,400);
    }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  }finally{await pool.end();}
});
