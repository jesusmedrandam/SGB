import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {pool} from '../../database/pool.js';
import {app} from '../../app.js';
import {getSessionOverview,login,register,resendEmailVerification,verifyEmail} from '../auth/auth.service.js';
import {createCatalogItem,listCatalogItems,updateCatalogItem} from './catalogs.service.js';
import {createProduct,updateProduct} from '../cleanings/cleanings.service.js';
const metadata={ipAddress:'127.0.0.1',userAgent:'catalog-sync-check'};
async function account(){
 const email=`catalog-${randomUUID()}@example.test`;
 const registration=await register({email,password:'Clave-segura-2026',displayName:'Catálogos',propertyName:'Cuenta de prueba'},metadata);
 await pool.query(`UPDATE email_verification_token SET created_at=now()-interval '2 minutes' WHERE user_id=$1`,[registration.userId]);
 await verifyEmail((await resendEmailVerification(email,metadata)).verificationToken!,metadata);
 const session=await login({email,password:'Clave-segura-2026',deviceId:randomUUID()},metadata);
 const auth={sessionId:session.sessionId,userId:session.user.id,email,displayName:session.user.displayName,isSuperadmin:false,
  activePropertyId:session.activePropertyId,activeRoleId:session.activeRoleId};
 const overview=await getSessionOverview(auth);const property=overview.properties[0]!;const role=property.roles.find(row=>row.code==='OWNER')!;
 const context={propertyId:property.id,propertyName:property.name,roleId:role.id,roleCode:role.code,roleName:role.name,
  permissions:new Set(role.permissions),enabledModules:new Set(property.enabledModules),enabledSpecies:new Set(property.enabledSpecies)};
 return {registration,auth,context};
}
test('administradores editan catálogos de toda su cuenta y el servidor conserva límites, aislamiento e historial',async()=>{
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.on('listening',resolve));
 try{
 const a=await account();const b=await account();
 const original=await createCatalogItem(a.auth,a.context,'COLORS',{name:'Color de la cuenta'},metadata);
 const changed=await updateCatalogItem(a.auth,a.context,'COLORS',original.id,{name:'Color corregido',expectedVersion:original.version},metadata);
 assert.equal(changed.version,original.version+1);
 await assert.rejects(updateCatalogItem(a.auth,a.context,'COLORS',original.id,{name:'Versión antigua',expectedVersion:original.version},metadata),{code:'CATALOG_VERSION_CONFLICT'});
 const system=(await listCatalogItems(a.context,'COLORS')).find(row=>row.systemDefined)!;
 await assert.rejects(updateCatalogItem(a.auth,a.context,'COLORS',system.id,{name:'Sistema modificado',expectedVersion:system.version},metadata),{code:'CATALOG_ITEM_UNAVAILABLE'});
 await assert.rejects(updateCatalogItem(b.auth,b.context,'COLORS',original.id,{name:'Cuenta ajena',expectedVersion:changed.version},metadata),{code:'CATALOG_ITEM_UNAVAILABLE'});
 const product=await createProduct(a.auth,a.context,{name:'Producto de la cuenta'},metadata,'CATALOG_MANAGE');
 // A second administrator creates the record within the same account.
 const administrator=(await pool.query(`SELECT id FROM property_role WHERE property_id=$1 AND code='ADMINISTRATOR'`,[a.context.propertyId])).rows[0];
 const membership=(await pool.query(`INSERT INTO property_membership(property_id,user_id,status,created_by) VALUES($1,$2,'ACTIVE',$2) RETURNING id`,[a.context.propertyId,b.auth.userId])).rows[0];
 await pool.query(`INSERT INTO membership_role(membership_id,property_id,role_id,assigned_by) VALUES($1,$2,$3,$4)`,[membership.id,a.context.propertyId,administrator.id,a.auth.userId]);
 const otherAuth={...b.auth,activePropertyId:a.context.propertyId,activeRoleId:administrator.id};
 const otherContext={...a.context,roleId:administrator.id,roleCode:'ADMINISTRATOR'};
 const shared=await createProduct(otherAuth,otherContext,{name:'Creado por otra administradora'},metadata,'CATALOG_MANAGE');
 const edited=await updateProduct(a.auth,a.context,shared.id,{name:'Compartido corregido',active:false,expectedVersion:shared.version},metadata);
 assert.equal(edited.active,false);assert.equal(edited.version,shared.version+1);
 await assert.rejects(updateProduct(a.auth,a.context,shared.id,{name:'Obsoleto',active:true,expectedVersion:shared.version},metadata),{code:'CLEANING_PRODUCT_VERSION_CONFLICT'});
 await assert.rejects(updateProduct(b.auth,b.context,product.id,{name:'Cuenta ajena',active:true,expectedVersion:product.version},metadata),{code:'CLEANING_PRODUCT_NOT_FOUND'});
 // A custom role with catalog permission still cannot act as an administrator.
 const custom=(await pool.query(`INSERT INTO property_role(property_id,code,name,is_system,created_by) VALUES($1,'CUSTOM_CATALOG','Encargado',false,$2) RETURNING id`,[a.context.propertyId,a.auth.userId])).rows[0];
 await pool.query(`INSERT INTO role_permission(role_id,permission_code) VALUES($1,'CATALOG_MANAGE')`,[custom.id]);
 const ownMembership=(await pool.query(`SELECT id FROM property_membership WHERE property_id=$1 AND user_id=$2`,[a.context.propertyId,a.auth.userId])).rows[0];
 await pool.query(`INSERT INTO membership_role(membership_id,property_id,role_id,assigned_by) VALUES($1,$2,$3,$4)`,[ownMembership.id,a.context.propertyId,custom.id,a.auth.userId]);
 await assert.rejects(updateProduct({...a.auth,activeRoleId:custom.id},{...a.context,roleId:custom.id},product.id,{name:'Sin autorización',active:true,expectedVersion:product.version},metadata),{code:'CATALOG_ADMIN_REQUIRED'});
 // A historical completed cleaning seeded before migration 0038 retains its name.
 const historical=(await pool.query(`SELECT d.product_id,d.product_name FROM pasture_cleaning_product d JOIN pasture_cleaning c ON c.id=d.cleaning_id WHERE c.status='COMPLETADO' LIMIT 1`)).rows[0];
 if(historical){await pool.query(`UPDATE pasture_agrochemical SET name='Renombrado después de aplicar' WHERE id=$1`,[historical.product_id]);
  assert.equal((await pool.query(`SELECT product_name FROM pasture_cleaning_product WHERE product_id=$1 LIMIT 1`,[historical.product_id])).rows[0].product_name,historical.product_name);}
 const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 for(let i=0;i<30;i++)assert.equal((await fetch(url+'/auth/refresh',{method:'POST'})).status,401);
 const limited=await fetch(url+'/auth/refresh',{method:'POST'});assert.equal(limited.status,429);
 const error=(await limited.json()).error;assert.equal(error.code,'SESSION_REFRESH_RATE_LIMIT');assert.ok(error.retryAfterSeconds>0);assert.ok(limited.headers.get('retry-after'));
 assert.equal((await fetch(url+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'missing@example.test',password:'Clave-segura-2026',deviceId:'quota-check'})})).status,401,'Renewal does not exhaust the login quota');
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await pool.end();}
});
