import {createLocation} from '../groups/groups.service.js';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {pool} from '../../database/pool.js';
import {getSessionOverview,login,register,resendEmailVerification,verifyEmail}
  from '../auth/auth.service.js';
import {createAnimal} from '../animals/animals.service.js';
import {createGroup} from '../groups/groups.service.js';
import {cancelCommerce,createCommerce,listCommerce} from './commerce.service.js';
import {createCatalogItem,listCatalogItems} from '../catalogs/catalogs.service.js';
import {createFinanceAccount,createFinanceMovement,financeAccounts,financeMovements,applyFinanceSchedule,cancelFinanceMovement,updateFinanceAccount}
  from '../finances/finances.service.js';

const meta={ipAddress:'127.0.0.1',userAgent:'sgb-commerce-test'};
async function identity(label:string){
  const suffix=randomUUID();const email=`commerce-${suffix}@example.test`;
  const registration=await register({email,password:'Clave-segura-2026',
    displayName:label,propertyName:`Finca ${suffix}`},meta);
  await pool.query(`UPDATE email_verification_token SET created_at=now()-interval '2 minutes'
    WHERE user_id=$1`,[registration.userId]);
  await verifyEmail((await resendEmailVerification(email,meta)).verificationToken!,meta);
  const session=await login({email,password:'Clave-segura-2026',deviceId:suffix},meta);
  const auth={sessionId:session.sessionId,userId:session.user.id,email:session.user.email,
    displayName:session.user.displayName,isSuperadmin:false,
    activePropertyId:session.activePropertyId,activeRoleId:session.activeRoleId};
  const overview=await getSessionOverview(auth);
  const property=overview.properties[0]!;const role=property.roles.find(item=>item.code==='OWNER')!;
  const context={propertyId:property.id,propertyName:property.name,roleId:role.id,
    roleCode:role.code,roleName:role.name,permissions:new Set(role.permissions),
    enabledModules:new Set(property.enabledModules),enabledSpecies:new Set(property.enabledSpecies)};
  return {registration,auth,context};
}
test('una venta registra salida reversible y las finanzas privadas respetan el ámbito',async()=>{
  try{
    const owner=await identity('Propietario de prueba');
    const outsider=await identity('Otro propietario');
    for(const moduleCode of ['SALES_PURCHASES','PROPERTY_FINANCE']){
      await pool.query(`INSERT INTO account_module(account_id,module_code,enabled,configured_by)
        VALUES($1,$2,true,$3) ON CONFLICT(account_id,module_code) DO UPDATE SET enabled=true`,
        [owner.registration.accountId,moduleCode,owner.auth.userId]);
      await pool.query(`INSERT INTO property_module(property_id,module_code,enabled,configured_by)
        VALUES($1,$2,true,$3) ON CONFLICT(property_id,module_code) DO UPDATE SET enabled=true`,
        [owner.context.propertyId,moduleCode,owner.auth.userId]);
    }
    
    const groupPlace=await createLocation(owner.auth,owner.context,{kind:'PASTURE',name:'Lote comercio'},meta);
    const group=await createGroup(owner.auth,owner.context,{name:'Lote comercio',locationId:groupPlace.id},meta);
    const animal=await createAnimal(owner.auth,owner.context,{name:'Vaca vendida',
      sex:'FEMALE',speciesCode:'BOVINE',groupId:group.id},meta);
    const today=(await pool.query<{today:string}>(`SELECT (now() AT TIME ZONE timezone)::date::text
      AS today FROM property WHERE id=$1`,[owner.context.propertyId])).rows[0]!.today;
    const buyer=await createCatalogItem(owner.auth,owner.context,'BUYERS',
      {name:'Cliente de prueba'},meta);
    const product=await createCatalogItem(owner.auth,owner.context,'SALE_PRODUCTS',
      {name:'Leche fresca'},meta);
    assert.equal((await listCatalogItems(owner.context,'BUYERS')).some(item=>item.id===buyer.id),true);
    assert.equal((await listCatalogItems(outsider.context,'BUYERS')).some(item=>item.id===buyer.id),false);
    assert.equal((await listCatalogItems(outsider.context,'SALE_PRODUCTS'))
      .some(item=>item.id===product.id),false);
    const sale=await createCommerce(owner.auth,owner.context,{
      kind:'SALE',tradedOn:today,buyerId:buyer.id,
      lines:[{animalId:animal.id,quantity:1,unit:'ANIMAL',unitPrice:1250,
        animalEffect:'EXIT_CURRENT_PROPERTY'},
      {productId:product.id,quantity:5,unit:'L',unitPrice:5}]},meta);
    assert.equal(sale.total,1275);
    assert.equal(sale.counterpartyName,'Cliente de prueba');
    assert.equal(sale.lines.find((line:{productId?:string})=>line.productId===product.id)
      ?.productName,'Leche fresca');
    assert.equal((await pool.query(`SELECT availability_status_code FROM animal WHERE id=$1`,
      [animal.id])).rows[0]?.availability_status_code,'EXITED');
    assert.equal((await listCommerce(outsider.context)).length,0);
    await assert.rejects(()=>cancelCommerce(outsider.auth,outsider.context,sale.id,
      'Intento externo',meta),(error:{code?:string})=>
        error.code==='COMMERCE_NOT_FOUND'||error.code==='COMMERCE_DENIED');
    const cancelled=await cancelCommerce(owner.auth,owner.context,sale.id,
      'Venta deshecha por el comprador',meta);
    assert.equal(cancelled.status,'CANCELLED');
    assert.equal((await pool.query(`SELECT availability_status_code FROM animal WHERE id=$1`,
      [animal.id])).rows[0]?.availability_status_code,'ACTIVE');
    await assert.rejects(()=>cancelCommerce(owner.auth,owner.context,sale.id,
      'Otra vez',meta),(error:{code?:string})=>error.code==='COMMERCE_CANCELLED');
    const personal=await createFinanceAccount(owner.auth,undefined,'PERSONAL',{
      name:'Efectivo privado',kind:'CASH',openingBalance:100},meta);
    assert.equal(personal.balance,100,'The initial balance is reflected before any movements');
    await createFinanceMovement(owner.auth,undefined,'PERSONAL',{
      kind:'EXPENSE',sourceAccountId:personal.id,destinationAccountId:null,amount:20,
      occurredOn:today,category:null,concept:'Gasto privado',notes:null},meta);
    assert.equal((await financeAccounts(owner.auth,undefined,'PERSONAL'))[0]?.balance,80);
    assert.equal((await financeAccounts(outsider.auth,undefined,'PERSONAL')).length,0);
    assert.equal((await financeAccounts(owner.auth,owner.context,'PROPERTY')).length,0);
    const tomorrow=(await pool.query(`SELECT (current_date+1)::text AS day`)).rows[0].day;
    const planned={kind:'EXPENSE' as const,sourceAccountId:personal.id,destinationAccountId:null,amount:15.25,
      occurredOn:tomorrow,scheduledOn:tomorrow,category:null,concept:'Pago programado',notes:null};
    const future=await createFinanceMovement(owner.auth,undefined,'PERSONAL',planned,meta);
    assert.equal(future.effectiveAt,null);
    assert.equal((await financeAccounts(owner.auth,undefined,'PERSONAL'))[0].balance,80);
    assert(!(await financeMovements(owner.auth,undefined,'PERSONAL')).some(row=>row.id===future.id));
    assert((await financeMovements(owner.auth,undefined,'PERSONAL',true)).some(row=>row.id===future.id));
    await pool.query('SELECT notify_finance_due($1)',[owner.auth.userId]);
    assert.equal((await pool.query('SELECT 1 FROM app_notification WHERE finance_movement_id=$1',[future.id])).rowCount,0);
    await assert.rejects(()=>applyFinanceSchedule(owner.auth,undefined,'PERSONAL',future.id,today,meta),{code:'FINANCE_EFFECTIVE_DATE'});
    await assert.rejects(()=>createFinanceMovement(owner.auth,undefined,'PERSONAL',{kind:'EXPENSE',sourceAccountId:personal.id,destinationAccountId:null,amount:15.25,occurredOn:tomorrow,category:null,concept:'Futuro',notes:null},meta),{code:'FINANCE_FUTURE_DATE'});
    const due=await createFinanceMovement(owner.auth,undefined,'PERSONAL',{...planned,scheduledOn:today,occurredOn:today},meta);
    await pool.query('SELECT notify_finance_due($1)',[owner.auth.userId]);
    await pool.query('SELECT notify_finance_due($1)',[owner.auth.userId]);
    const reminders=await pool.query('SELECT * FROM app_notification WHERE finance_movement_id=$1',[due.id]);
    assert.equal(reminders.rowCount,1,'Due notification is emitted once');assert.equal(reminders.rows[0].property_id,null);
    assert.equal((await pool.query('SELECT can_view_finance_reminder($1,$2) AS allowed',[due.id,outsider.auth.userId])).rows[0].allowed,false);
    await assert.rejects(()=>applyFinanceSchedule(outsider.auth,undefined,'PERSONAL',due.id,today,meta),{code:'FINANCE_SCHEDULE_NOT_FOUND'});
    await Promise.all([applyFinanceSchedule(owner.auth,undefined,'PERSONAL',due.id,today,meta),applyFinanceSchedule(owner.auth,undefined,'PERSONAL',due.id,today,meta)]);
    assert.equal((await financeAccounts(owner.auth,undefined,'PERSONAL'))[0].balance,64.75,'Concurrent confirmation debits exactly once');
    assert.equal((await financeMovements(owner.auth,undefined,'PERSONAL')).filter(row=>row.id===due.id).length,1);
    await cancelFinanceMovement(owner.auth,undefined,'PERSONAL',due.id,'Pago anulado',meta);
    assert.equal((await financeAccounts(owner.auth,undefined,'PERSONAL'))[0].balance,80);
    await cancelFinanceMovement(owner.auth,undefined,'PERSONAL',future.id,'No se pagará',meta);
    assert.equal((await financeAccounts(owner.auth,undefined,'PERSONAL'))[0].balance,80,'Cancelling an unapplied schedule has no balance effect');
    await assert.rejects(()=>applyFinanceSchedule(owner.auth,undefined,'PERSONAL',future.id,today,meta),{code:'FINANCE_SCHEDULE_CANCELLED'});
    const income=await createFinanceMovement(owner.auth,undefined,'PERSONAL',{...planned,kind:'INCOME',sourceAccountId:null,destinationAccountId:personal.id,scheduledOn:today,occurredOn:today},meta);
    await updateFinanceAccount(owner.auth,undefined,'PERSONAL',personal.id,{name:'Efectivo privado',kind:'CASH',active:false},meta);
    await assert.rejects(()=>applyFinanceSchedule(owner.auth,undefined,'PERSONAL',income.id,today,meta),{code:'FINANCE_ACCOUNT_DISABLED'});
    await updateFinanceAccount(owner.auth,undefined,'PERSONAL',personal.id,{name:'Efectivo privado',kind:'CASH',active:true},meta);
    await applyFinanceSchedule(owner.auth,undefined,'PERSONAL',income.id,today,meta);
    assert.equal((await financeAccounts(owner.auth,undefined,'PERSONAL'))[0].balance,95.25);
    const propertyAccount=await createFinanceAccount(owner.auth,owner.context,'PROPERTY',{name:'Caja del predio',kind:'CASH',openingBalance:200},meta);
    const propertyDue=await createFinanceMovement(owner.auth,owner.context,'PROPERTY',{...planned,sourceAccountId:propertyAccount.id,scheduledOn:today,occurredOn:today},meta);
    assert.equal((await pool.query('SELECT can_view_finance_reminder($1,$2) AS allowed',[propertyDue.id,owner.auth.userId])).rows[0].allowed,true);
    await pool.query('SELECT notify_finance_due($1)',[owner.auth.userId]);
    assert.equal((await pool.query('SELECT 1 FROM app_notification WHERE finance_movement_id=$1',[propertyDue.id])).rowCount,1);
    await applyFinanceSchedule(owner.auth,owner.context,'PROPERTY',propertyDue.id,today,meta);
    assert.equal((await financeAccounts(owner.auth,owner.context,'PROPERTY'))[0].balance,184.75);
    await pool.query(`DELETE FROM role_permission WHERE role_id=$1 AND permission_code='FINANCE_MANAGE'`,[owner.context.roleId]);
    await assert.rejects(()=>applyFinanceSchedule(owner.auth,owner.context,'PROPERTY',propertyDue.id,today,meta),{code:'FINANCE_DENIED'});
    await pool.query(`DELETE FROM role_permission WHERE role_id=$1 AND permission_code='FINANCE_VIEW'`,[owner.context.roleId]);
    assert.equal((await pool.query('SELECT can_view_finance_reminder($1,$2) AS allowed',[propertyDue.id,owner.auth.userId])).rows[0].allowed,false,'Revoked access hides financial notices');

  }finally{await pool.end();}
});
