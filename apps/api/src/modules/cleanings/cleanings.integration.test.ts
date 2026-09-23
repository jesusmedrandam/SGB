import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {pool} from '../../database/pool.js';
import {getSessionOverview,login,register,resendEmailVerification,verifyEmail} from '../auth/auth.service.js';
import {createLocation} from '../groups/groups.service.js';
import {applyCleaning,cancelCleaning,createCleaning,createProduct,listCleanings,
  listCleaningOptions,listProducts,updateCleaning} from './cleanings.service.js';

const metadata={ipAddress:'127.0.0.1',userAgent:'sgb-cleaning-test'};
test('limpieza calcula área y consumo y preserva el historial por propiedad',async()=>{
  const suffix=randomUUID();const email=`cleaning-${suffix}@example.test`;
  try{
    const registration=await register({email,password:'Clave-segura-2026',
      displayName:'Prueba limpieza',propertyName:`Finca limpia ${suffix}`},metadata);
    await pool.query(`UPDATE email_verification_token SET created_at=now()-interval '2 minutes'
      WHERE user_id=$1`,[registration.userId]);
    await verifyEmail((await resendEmailVerification(email,metadata)).verificationToken!,metadata);
    const session=await login({email,password:'Clave-segura-2026',deviceId:`cleaning-${suffix}`},metadata);
    const overview=await getSessionOverview({sessionId:session.sessionId,userId:session.user.id,
      email:session.user.email,displayName:session.user.displayName,isSuperadmin:false,
      activePropertyId:session.activePropertyId,activeRoleId:session.activeRoleId});
    const property=overview.properties[0]!;
    const role=property.roles.find((item)=>item.code==='OWNER')!;
    assert.ok(role.permissions.includes('CLEANING_MANAGE'));
    const auth={sessionId:session.sessionId,userId:session.user.id,email:session.user.email,
      displayName:session.user.displayName,isSuperadmin:false,
      activePropertyId:property.id,activeRoleId:role.id};
    const context={propertyId:property.id,propertyName:property.name,roleId:role.id,
      roleCode:role.code,roleName:role.name,permissions:new Set(role.permissions),
      enabledModules:new Set(property.enabledModules),enabledSpecies:new Set(property.enabledSpecies)};
    await pool.query(`INSERT INTO account_module(account_id,module_code,enabled,configured_by)
      VALUES($1,'PASTURE_CLEANING',true,$2) ON CONFLICT(account_id,module_code)
      DO UPDATE SET enabled=true`,[registration.accountId,auth.userId]);
    await pool.query(`INSERT INTO property_module(property_id,module_code,enabled,configured_by)
      VALUES($1,'PASTURE_CLEANING',true,$2) ON CONFLICT(property_id,module_code)
      DO UPDATE SET enabled=true`,[property.id,auth.userId]);
    const pasture=await createLocation(auth,context,{kind:'PASTURE',name:'Potrero limpieza',
      area:2,areaUnitCode:'HECTARE'},metadata);
    const corral=await createLocation(auth,context,{kind:'CORRAL',name:'Corral excluido'},metadata);
    assert.equal((await listCleaningOptions(context)).locations.length,1);
    const product=await createProduct(auth,context,{name:'Producto fumigación',
      category:'Herbicida'},metadata);
    assert.equal((await listProducts(context))[0]?.id,product.id);
    const today=(await pool.query<{today:string}>(`SELECT (now() AT TIME ZONE timezone)::date::text
      AS today FROM property WHERE id=$1`,[property.id])).rows[0]!.today;
    const input={locationId:pasture.id,startedOn:today,activities:['FUMIGACION' as const,
      'TALA_SELECTIVA' as const],applicationUnit:'BOMBADAS' as const,applicationCount:3,
      tankCapacityLiters:20,areaType:'PARCIAL' as const,partialPercent:25,
      products:[{productId:product.id,unitCode:'MILLILITER' as const,quantityPerApplication:2}],
      operators:[{name:'Operador uno',function:'Fumigador'}]};
    await assert.rejects(()=>createCleaning(auth,context,{...input,locationId:corral.id},metadata),
      (error:{code?:string})=>error.code==='CLEANING_PASTURE_INVALID');
    const draft=await createCleaning(auth,context,input,metadata);
    assert.equal(Number(draft.areaValue),0.5);
    assert.equal(Number(draft.products[0]?.totalQuantity),6);
    const edited=await updateCleaning(auth,context,draft.id,{...input,applicationCount:4,
      expectedVersion:draft.version},metadata);
    assert.equal(edited.version,draft.version+1);
    assert.equal(Number(edited.products[0]?.totalQuantity),8);
    const completed=await applyCleaning(auth,context,draft.id,metadata);
    assert.equal(completed.status,'COMPLETADO');
    await assert.rejects(()=>applyCleaning(auth,context,draft.id,metadata),
      (error:{code?:string})=>error.code==='CLEANING_FINAL');
    const cancelled=await createCleaning(auth,context,{...input,areaType:'TOTAL',
      partialPercent:null,products:[],applicationCount:null},metadata);
    await cancelCleaning(auth,context,cancelled.id,metadata);
    assert.equal((await listCleanings(context)).length,2);
    assert.equal((await listCleanings({...context,propertyId:randomUUID()})).length,0);
    const viewer=(await pool.query<{id:string}>(`SELECT id FROM property_role
      WHERE property_id=$1 AND code='VIEWER'`,[property.id])).rows[0]!;
    await assert.rejects(()=>createProduct({...auth,activeRoleId:viewer.id},
      {...context,roleId:viewer.id},{name:'No permitido'},metadata),
      (error:{code?:string})=>error.code==='CLEANING_DENIED');
  }finally{await pool.end();}
});
