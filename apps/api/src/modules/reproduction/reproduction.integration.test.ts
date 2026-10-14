import {createLocation} from '../groups/groups.service.js';
import {createGroup} from '../groups/groups.service.js';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {env} from '../../config.js';
import {addMedia,listMedia,updateMediaDetails} from '../media/media.service.js';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { pool } from '../../database/pool.js';
import { createAnimal, getAnimal } from '../animals/animals.service.js';
import { createOwner } from '../animals/owners.service.js';
import { getSessionOverview, login, register, resendEmailVerification, verifyEmail } from '../auth/auth.service.js';
import { finishHeat, createHeat, createPregnancy, createService, getReproductionSettings, listReproduction,
  recordBirth, recordLoss, updateReproductionSettings } from './reproduction.service.js';
import { createLactation, finishLactation, listProduction, recordMilk,
  recordTank, setLactationMilking, setCowMilking } from '../production/production.service.js';

const metadata = { ipAddress: '127.0.0.1', userAgent: 'sgb-reproduction-test' };

test('la reproducción conserva propiedad, parentesco, espera y auditoría', async () => {
  const suffix = randomUUID();
  const email = `reproduction-${suffix}@example.test`;
  try {
    const registration = await register({ email, password: 'Clave-segura-2026',
      displayName: 'Reproducción', propertyName: `Finca reproductiva ${suffix}` }, metadata);
    await pool.query(`UPDATE email_verification_token SET created_at = now() - interval '2 minutes'
      WHERE user_id = $1`, [registration.userId]);
    const resend = await resendEmailVerification(email, metadata);
    await verifyEmail(resend.verificationToken!, metadata);
    const session = await login({ email, password: 'Clave-segura-2026',
      deviceId: `reproduction-${suffix}`, deviceName: 'GitHub Actions' }, metadata);
    const overview = await getSessionOverview({ sessionId: session.sessionId,
      userId: session.user.id, email: session.user.email,
      displayName: session.user.displayName, isSuperadmin: false,
      activePropertyId: session.activePropertyId, activeRoleId: session.activeRoleId });
    const property = overview.properties[0]!;
    const role = property.roles.find((entry) => entry.code === 'OWNER')!;
    assert.ok(role.permissions.includes('REPRODUCTION_MANAGE'));
    const auth = { sessionId: session.sessionId, userId: session.user.id,
      email: session.user.email, displayName: session.user.displayName,
      isSuperadmin: false, activePropertyId: property.id, activeRoleId: role.id };
    const context = { propertyId: property.id, propertyName: property.name,
      roleId: role.id, roleCode: role.code, roleName: role.name,
      permissions: new Set(role.permissions), enabledModules: new Set(property.enabledModules),
      enabledSpecies: new Set(property.enabledSpecies) };
    await pool.query(`INSERT INTO account_module(account_id, module_code, enabled, configured_by)
      VALUES($1,'REPRODUCTION',true,$2) ON CONFLICT(account_id,module_code)
      DO UPDATE SET enabled = true`, [registration.accountId, auth.userId]);
    await pool.query(`INSERT INTO property_module(property_id, module_code, enabled, configured_by)
      VALUES($1,'REPRODUCTION',true,$2) ON CONFLICT(property_id,module_code)
      DO UPDATE SET enabled = true`, [property.id, auth.userId]);
    await pool.query(`INSERT INTO account_module(account_id,module_code,enabled,configured_by)
      VALUES($1,'PRODUCTION',true,$2) ON CONFLICT(account_id,module_code)
      DO UPDATE SET enabled=true`,[registration.accountId,auth.userId]);
    await pool.query(`INSERT INTO property_module(property_id,module_code,enabled,configured_by)
      VALUES($1,'PRODUCTION',true,$2) ON CONFLICT(property_id,module_code)
      DO UPDATE SET enabled=true`,[property.id,auth.userId]);

    const owner = await createOwner(auth, context, { kind: 'USER', userId: auth.userId }, metadata);
    const groupPlace=await createLocation(auth,context,{kind:'PASTURE',name:'Grupo de prueba'},metadata);
    const group=await createGroup(auth,context,{name:'Grupo de prueba',locationId:groupPlace.id},metadata);
    const mother = await createAnimal(auth, context, { name: 'Madre de prueba', sex: 'FEMALE',
      groupId:group.id,speciesCode: 'BOVINE', birthDate: '2019-01-01', entryDate: '2022-01-01',
      owners: [{ partyId: owner.id, percent: 100, isPrimary: true }] }, metadata);
    const father = await createAnimal(auth, context, { name: 'Padre de prueba', sex: 'MALE',
      groupId:group.id,speciesCode: 'BOVINE', birthDate: '2018-01-01', entryDate: '2022-01-01',
      owners: [{ partyId: owner.id, percent: 100, isPrimary: true }] }, metadata);

    await assert.rejects(() => createHeat(auth, context, {
      cowId: father.id, startsOn: '2023-01-10', isFalse: false }, metadata),
    (error: { code?: string }) => error.code === 'REPRODUCTION_ANIMAL_UNAVAILABLE');
    const heat = await createHeat(auth, context, { cowId: mother.id, bullId: father.id,
      startsOn: '2023-01-10', isFalse: false }, metadata);
    await assert.rejects(()=>finishHeat(auth,context,heat.id,'2023-01-09',metadata),
      (error:{code?:string})=>error.code==='HEAT_END_INVALID');
    await assert.rejects(()=>finishHeat({...auth,userId:randomUUID()},context,heat.id,'2023-01-12',metadata));
    await finishHeat(auth,context,heat.id,'2023-01-12',metadata);
    assert.equal((await listReproduction(context)).heats.find(row=>row.id===heat.id)?.endsOn,'2023-01-12');
    await assert.rejects(()=>finishHeat(auth,context,heat.id,'2023-01-13',metadata),
      (error:{code?:string})=>error.code==='HEAT_FINISHED');
    await pool.query("UPDATE property_module SET enabled=false WHERE property_id=$1 AND module_code='REPRODUCTION_HEATS'",[property.id]);
    await assert.rejects(()=>createHeat(auth,context,{cowId:mother.id,startsOn:'2023-01-20',isFalse:false},metadata),
      (error:{code?:string})=>error.code==='REPRODUCTION_SECTION_DISABLED');
    assert.ok(!(await getReproductionSettings(context)).enabledSections.includes('REPRODUCTION_HEATS'));
    assert.ok((await getReproductionSettings(context)).enabledSections.includes('REPRODUCTION_INSEMINATION'));
    await pool.query("UPDATE property_module SET enabled=true WHERE property_id=$1 AND module_code='REPRODUCTION_HEATS'",[property.id]);
    const defaults = await getReproductionSettings(context);
    assert.equal(defaults.daysAfterBirthHeat, 30);
    await updateReproductionSettings(auth, context, { ...defaults, allowSecondHeat: false }, metadata);
    await assert.rejects(() => createHeat(auth, context,
      { cowId: mother.id, startsOn: '2023-01-20', isFalse: false }, metadata),
    (error: { code?: string }) => error.code === 'SECOND_HEAT_DISABLED');
    await updateReproductionSettings(auth, context, defaults, metadata);
    const pregnancy = await createPregnancy(auth, context, {
      cowId: mother.id, heatId: heat.id,
      conceptionMethod: 'NATURAL', confirmationMethod: 'PALPATION',
      confirmedOn: '2023-02-01' }, metadata);
    assert.equal(pregnancy.fatherId, father.id);
    assert.equal(pregnancy.gestationDays, 20);
    assert.equal(pregnancy.expectedBirthOn, '2023-10-22');
    await assert.rejects(() => createPregnancy(auth, context, {
      cowId: mother.id, conceptionMethod: 'NATURAL', confirmationMethod: 'PALPATION',
      confirmedOn: '2023-02-02' }, metadata),
    (error: { code?: string }) => error.code === 'PREGNANCY_CONFIRMED');
    const apparent=await createHeat(auth,context,{cowId:mother.id,startsOn:'2023-04-01',isFalse:false,trueHeatId:'NEW'},metadata);
    assert.equal(apparent.isFalse,true);assert.equal((await listReproduction(context)).heats.find(row=>row.id===heat.id)?.isFalse,false);
    await updateReproductionSettings(auth, context,
      { ...defaults, allowFalseHeatInPregnancy: false }, metadata);
    assert.equal((await createHeat(auth,context,{cowId:mother.id,startsOn:'2023-04-02',isFalse:true},metadata)).isFalse,true);
    await updateReproductionSettings(auth, context, defaults, metadata);

    const birth = await recordBirth(auth, context, { pregnancyId: pregnancy.id,
      occurredOn: '2023-10-20', stillbornCount: 1,
      calves: [{ name: 'Cría de prueba', groupId:group.id,sex: 'FEMALE' },{name:'Segunda cría',groupId:group.id,sex:'MALE'}] }, metadata);
    assert.equal(birth.liveCount, 2);
    assert.equal((await getAnimal(context,birth.calves[1]!.id)).mother?.animalId,mother.id);
    const calf = await getAnimal(context, birth.calves[0]!.id);
    assert.equal(calf.birthDate, '2023-10-20');
    assert.equal(calf.mother?.animalId, mother.id);
    assert.equal(calf.father?.animalId, father.id);
    assert.equal(calf.owners[0]?.id, owner.id);
    // Reuse one real, canonical image in storage; no external upload is needed.
    env.CLOUDINARY_CLOUD_NAME='sgb-test';env.CLOUDINARY_API_KEY='test';env.CLOUDINARY_API_SECRET='test';
    const image=await sharp({create:{width:16,height:16,channels:3,background:'#66aa44'}}).png().toBuffer();
    const canonical=await sharp(image,{limitInputPixels:40000000,failOn:'error'}).rotate()
      .resize({width:2560,height:2560,fit:'inside',withoutEnlargement:true}).webp({quality:82}).toBuffer();
    const object=(await pool.query<{id:string}>(`INSERT INTO storage_object(account_id,origin_property_id,
      provider,provider_asset_id,storage_key,sha256,kind,mime_type,byte_size,status,created_by)
      VALUES($1,$2,'CLOUDINARY',$3,$3,$4,'IMAGE','image/webp',$5,'AVAILABLE',$6) RETURNING id`,
      [registration.accountId,property.id,'birth-photo-'+suffix,createHash('sha256').update(canonical).digest('hex'),canonical.length,auth.userId])).rows[0]!.id;
    const photo=await addMedia(auth,context,'REPRODUCTION_BIRTH',birth.id,'GENERAL','IMAGE',image,{metadata});
    assert.equal(photo.attachmentIds.length,4,'One birth photo relates to the mother and both calves');
    for(const id of [mother.id,...birth.calves.map(row=>row.id)]){
      const gallery=await listMedia(context,'ANIMAL',id);assert.equal(gallery.length,1);assert.equal(gallery[0]!.storage_object_id,object);
      assert.equal(gallery[0]!.recordType,'REPRODUCTION_BIRTH');
      assert.equal(gallery[0]!.recordDetails?.title,'Parto');
      assert.ok(gallery[0]!.recordDetails?.lines.some(line=>line.includes('Segunda cría')),'Animal photo queries retain the birth and both calves');
    }
    assert.equal((await listMedia(context,'REPRODUCTION_BIRTH',birth.id)).length,1);
    const restrictedMedia=await listMedia({...context,permissions:new Set([...context.permissions].filter(permission=>permission!=='REPRODUCTION_VIEW'))},'ANIMAL',mother.id);
    assert.equal(restrictedMedia[0]!.recordDetails,null,'Birth details remain private when reproduction permission is missing');
    await updateMediaDetails(auth,context,object,{capturedOn:'2023-10-20',description:'Parto gemelar',
      tagIds:[],animalIds:[],expectedAttachmentIds:photo.attachmentIds},metadata);
    assert.equal((await listMedia(context,undefined,undefined,object)).length,4,'Birth relatives survive metadata editing');
    await pool.query("UPDATE property_module SET enabled=false WHERE property_id=$1 AND module_code='REPRODUCTION_INSEMINATION'",[property.id]);
    await assert.rejects(()=>createService(auth,context,{cowId:mother.id,kind:'INSEMINATION',occurredOn:'2024-01-01'},metadata),
      (error:{code?:string})=>error.code==='REPRODUCTION_SECTION_DISABLED');
    await assert.rejects(()=>createPregnancy(auth,context,{cowId:mother.id,conceptionMethod:'INSEMINATION',
      confirmationMethod:'PALPATION',confirmedOn:'2024-01-01'},metadata),
      (error:{code?:string})=>error.code==='REPRODUCTION_SECTION_DISABLED');
    await pool.query("UPDATE property_module SET enabled=true WHERE property_id=$1 AND module_code='REPRODUCTION_INSEMINATION'",[property.id]);

    await assert.rejects(() => recordBirth(auth, context, { pregnancyId: pregnancy.id,
      occurredOn: '2023-10-20', stillbornCount: 1, calves: [] }, metadata),
    (error: { code?: string }) => error.code === 'PREGNANCY_FINISHED');
    await assert.rejects(() => createHeat(auth, context,
      { cowId: mother.id, startsOn: '2023-10-30', isFalse: false }, metadata),
    (error: { code?: string }) => error.code === 'REPRODUCTION_WAITING_PERIOD');

    await createHeat(auth, context, { cowId: mother.id,
      startsOn: '2023-12-01', isFalse: false }, metadata);
    const nextPregnancy = await createPregnancy(auth, context, { cowId: mother.id,
      conceptionMethod: 'NATURAL', confirmationMethod: 'ULTRASOUND',
      confirmedOn: '2024-01-15' }, metadata);
    assert.equal(nextPregnancy.gestationDays, 45);
    await recordLoss(auth, context, { pregnancyId: nextPregnancy.id,
      occurredOn: '2024-05-01', notes: 'Pérdida registrada' }, metadata);
    await assert.rejects(() => createHeat(auth, context,
      { cowId: mother.id, startsOn: '2024-05-05', isFalse: false }, metadata),
    (error: { code?: string }) => error.code === 'REPRODUCTION_WAITING_PERIOD');
    const history = await listReproduction(context);
    assert.equal(history.births.length, 1);
    assert.equal(history.losses.length, 1);
    assert.equal(history.pregnancies.length, 2);
    assert.equal(history.pregnancies.find((row) => row.id === pregnancy.id)?.status, 'BORN');
    const wrongProperty = { ...context, propertyId: randomUUID() };
    assert.equal((await listReproduction(wrongProperty)).births.length, 0);
    await assert.rejects(() => createHeat(auth, wrongProperty,
      { cowId: mother.id, startsOn: '2024-06-01', isFalse: false }, metadata),
    (error: { code?: string }) => error.code === 'REPRODUCTION_DENIED');
    const audit = await pool.query<{ action: string }>(
      `SELECT action FROM audit_event WHERE actor_user_id = $1 AND action LIKE 'REPRODUCTION_%'`,
      [auth.userId]);
    assert.ok(audit.rows.some((row) => row.action === 'REPRODUCTION_BIRTH_REGISTERED'));
    assert.ok(audit.rows.some((row) => row.action === 'REPRODUCTION_LOSS_REGISTERED'));

    const today = (await pool.query<{ today: string }>(
      `SELECT to_char((now() AT TIME ZONE timezone)::date,'YYYY-MM-DD') AS today
       FROM property WHERE id=$1`,[property.id])).rows[0]!.today;
    const relative = (days:number) => {
      const date=new Date(`${today}T12:00:00Z`);
      date.setUTCDate(date.getUTCDate()+days);
      return date.toISOString().slice(0,10);
    };
    const service = await createService(auth,context,{cowId:mother.id,fatherId:father.id,
      kind:'INSEMINATION',occurredOn:relative(-220),technician:'Profesional de prueba'},metadata);
    const linked = await createPregnancy(auth,context,{cowId:mother.id,serviceId:service.id,
      conceptionMethod:'INSEMINATION',confirmationMethod:'ULTRASOUND',
      confirmedOn:relative(-190)},metadata);
    assert.equal(linked.fatherId,father.id);
    assert.equal(linked.gestationDays,30);
    assert.equal((await listReproduction(context)).pregnancies.find((row)=>row.id===linked.id)?.serviceId,service.id);
    const recentBirth = await recordBirth(auth,context,{pregnancyId:linked.id,
      occurredOn:relative(-20),stillbornCount:1,calves:[]},metadata);
    const lactation = await createLactation(auth,context,{birthId:recentBirth.id,inMilking:true},metadata);
    assert.equal(lactation.cowId,mother.id);
    await assert.rejects(()=>createLactation(auth,wrongProperty,
      {birthId:recentBirth.id,inMilking:true},metadata),
    (error:{code?:string})=>error.code==='PRODUCTION_DENIED');
    await updateReproductionSettings(auth,context,{...defaults,maxMilkingDays:10},metadata);
    await assert.rejects(()=>recordMilk(auth,context,{lactationId:lactation.id,
      producedOn:today,shift:'MORNING',liters:2,source:'MANUAL'},metadata),
    (error:{code?:string})=>error.code==='MILKING_PERIOD_EXPIRED');
    await updateReproductionSettings(auth,context,defaults,metadata);
    await setLactationMilking(auth,context,lactation.id,false,metadata);
    await assert.rejects(()=>recordMilk(auth,context,{lactationId:lactation.id,
      producedOn:today,shift:'MORNING',liters:2,source:'MANUAL'},metadata),
    (error:{code?:string})=>error.code==='MILKING_UNAVAILABLE');
    await setLactationMilking(auth,context,lactation.id,true,metadata);
    const milk=await recordMilk(auth,context,{lactationId:lactation.id,
      producedOn:today,shift:'MORNING',liters:4.25,source:'MANUAL'},metadata);
    assert.equal(milk.cowId,mother.id);
    await assert.rejects(()=>recordMilk(auth,context,{lactationId:lactation.id,
      producedOn:today,shift:'MORNING',liters:1,source:'MANUAL'},metadata),
    (error:{code?:string})=>error.code==='PRODUCTION_DUPLICATE');
    await recordTank(auth,context,{producedOn:today,shift:'MORNING',liters:4,source:'MANUAL'},metadata);
    const production=await listProduction(context);
    assert.equal(production.milk.length,1);
    assert.equal(production.tanks.length,1);
    assert.equal((await listProduction(wrongProperty)).milk.length,0);
    await assert.rejects(()=>finishLactation(auth,context,lactation.id,relative(-1),metadata),
    (error:{code?:string})=>error.code==='LACTATION_DATES_INVALID');
    await finishLactation(auth,context,lactation.id,today,metadata);
    await assert.rejects(()=>recordMilk(auth,context,{lactationId:lactation.id,
      producedOn:today,shift:'AFTERNOON',liters:3,source:'MANUAL'},metadata),
    (error:{code?:string})=>error.code==='MILKING_UNAVAILABLE');
    await setCowMilking(auth,context,mother.id,true,metadata);
    const standalone=await recordMilk(auth,context,{cowId:mother.id,
      producedOn:today,shift:'AFTERNOON',liters:3,source:'MANUAL'},metadata);
    assert.equal(standalone.lactationId,null);
    assert.equal((await listProduction(context)).milk.find((row)=>row.id===standalone.id)?.lactationId,null);
    await setCowMilking(auth,context,mother.id,false,metadata);
    await assert.rejects(()=>recordMilk(auth,context,{cowId:mother.id,
      producedOn:today,shift:'NIGHT',liters:1,source:'MANUAL'},metadata),
    (error:{code?:string})=>error.code==='MILKING_UNAVAILABLE');
  } finally { await pool.end(); }
});
