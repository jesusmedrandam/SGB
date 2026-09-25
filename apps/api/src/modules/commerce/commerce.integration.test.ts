import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {pool} from '../../database/pool.js';
import {getSessionOverview,login,register,resendEmailVerification,verifyEmail}
  from '../auth/auth.service.js';
import {createAnimal} from '../animals/animals.service.js';
import {createGroup} from '../groups/groups.service.js';
import {cancelCommerce,createCommerce,listCommerce} from './commerce.service.js';
import {createFinanceAccount,createFinanceMovement,financeAccounts}
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
    const group=await createGroup(owner.auth,owner.context,{name:'Lote comercio'},meta);
    const animal=await createAnimal(owner.auth,owner.context,{name:'Vaca vendida',
      sex:'FEMALE',speciesCode:'BOVINE',groupId:group.id},meta);
    const today=(await pool.query<{today:string}>(`SELECT (now() AT TIME ZONE timezone)::date::text
      AS today FROM property WHERE id=$1`,[owner.context.propertyId])).rows[0]!.today;
    const sale=await createCommerce(owner.auth,owner.context,{
      kind:'SALE',tradedOn:today,counterpartyName:'Cliente de prueba',
      lines:[{animalId:animal.id,quantity:1,unit:'ANIMAL',unitPrice:1250,
        animalEffect:'EXIT_CURRENT_PROPERTY'}]},meta);
    assert.equal(sale.total,1250);
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
    await createFinanceMovement(owner.auth,undefined,'PERSONAL',{
      kind:'EXPENSE',sourceAccountId:personal.id,destinationAccountId:null,amount:20,
      occurredOn:today,category:null,concept:'Gasto privado',notes:null},meta);
    assert.equal((await financeAccounts(owner.auth,undefined,'PERSONAL'))[0]?.balance,80);
    assert.equal((await financeAccounts(outsider.auth,undefined,'PERSONAL')).length,0);
    assert.equal((await financeAccounts(owner.auth,owner.context,'PROPERTY')).length,0);
  }finally{await pool.end();}
});
