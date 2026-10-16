import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {app} from '../../app.js';
import {pool} from '../../database/pool.js';
import {register,login,getSessionOverview,resendEmailVerification,verifyEmail} from '../auth/auth.service.js';
import {createAgendaItem} from './agenda.service.js';
import {offlineCalendar,offlineCalendarRange} from './offline-calendar.service.js';
import {normalizeWeather,weatherForecast,weatherQuery} from './weather.service.js';
import {createPropertyRole} from '../collaboration/collaboration.service.js';

const metadata={ipAddress:'127.0.0.1',userAgent:'weather-offline-test'};
const period=(amount:number,symbol='rain')=>({summary:{symbol_code:symbol},details:{precipitation_amount:amount}});
const sample={properties:{meta:{updated_at:'2026-10-16T00:00:00Z'},timeseries:[
 {time:'2026-10-16T04:00:00Z',data:{instant:{details:{air_temperature:24}},next_1_hours:period(1)}},
 {time:'2026-10-16T05:00:00Z',data:{instant:{details:{air_temperature:23}},next_6_hours:period(6)}},
 {time:'2026-10-16T06:00:00Z',data:{instant:{details:{air_temperature:26}},next_6_hours:period(7)}},
 {time:'2026-10-16T11:00:00Z',data:{instant:{details:{air_temperature:28}},next_6_hours:period(0,'partlycloudy_day')}}]}};

test('calendario sin conexión por propiedad y rol, tres meses y clima validado sin compartir datos personales',async()=>{
 const server=app.listen(0,'127.0.0.1');const nativeFetch=globalThis.fetch;
 try{
  await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}`;
  assert.deepEqual(offlineCalendarRange(new Date('2026-01-01T04:00:00Z')),{from:'2025-11-01T00:00:00-05:00',to:'2026-02-01T00:00:00-05:00'},'Uses Ecuador date at the UTC year boundary');
  assert.deepEqual(offlineCalendarRange(new Date('2024-02-29T17:00:00Z')),{from:'2024-01-01T00:00:00-05:00',to:'2024-04-01T00:00:00-05:00'});
  async function user(){const email=`offline-weather-${randomUUID()}@example.test`;
   const registration=await register({email,password:'Clave-segura-2026',displayName:'Dueño',propertyName:'Predio '+randomUUID()},metadata);
   await pool.query("UPDATE email_verification_token SET created_at=now()-interval '2 minutes' WHERE user_id=$1",[registration.userId]);
   await verifyEmail((await resendEmailVerification(email,metadata)).verificationToken!,metadata);
   const session=await login({email,password:'Clave-segura-2026',deviceId:randomUUID()},metadata);
   const auth={sessionId:session.sessionId,userId:session.user.id,email,displayName:'Dueño',isSuperadmin:false,activePropertyId:session.activePropertyId,activeRoleId:session.activeRoleId};
   const property=(await getSessionOverview(auth)).properties[0]!,role=property.roles.find(r=>r.code==='OWNER')!;
   const context={propertyId:property.id,propertyName:property.name,roleId:role.id,roleCode:role.code,roleName:role.name,permissions:new Set(role.permissions),enabledModules:new Set(property.enabledModules),enabledSpecies:new Set(property.enabledSpecies)};
   return {auth,context,session};}
  const [a,b]=await Promise.all([user(),user()]);const range=offlineCalendarRange();
  const task={kind:'TASK' as const,activityType:'PERSONALIZADA',title:'Datos guardados',instructions:null,scheduledAt:range.from,reminderAt:null,visibility:'PRIVATE' as const,userIds:[],animalIds:[]};
  const first=await createAgendaItem(a.auth,a.context,task,metadata);
  await createAgendaItem(a.auth,a.context,{...task,scheduledAt:new Date(Date.parse(range.to)-1000).toISOString()},metadata);
  await createAgendaItem(a.auth,a.context,{...task,scheduledAt:range.to},metadata);
  await createAgendaItem(a.auth,a.context,{...task,scheduledAt:new Date(Date.parse(range.from)-1000).toISOString()},metadata);
  const copy=await offlineCalendar(a.auth,a.context);assert.deepEqual(copy.range,range);assert.equal(copy.items.length,2);
  assert.ok(copy.items.some(row=>row.id===first.id));assert.equal(copy.propertyId,a.context.propertyId);assert.equal(copy.roleId,a.context.roleId);
  assert.equal(copy.options.properties.length,1);assert.deepEqual(copy.options.properties[0]!.users,[]);assert.equal(copy.options.properties[0]!.tasks,false);
  assert.equal((await offlineCalendar(b.auth,b.context)).items.length,0);
  assert.ok(copy.moon&&copy.moon.phases.length>=11);assert.ok(copy.moon.phases.every(p=>Date.parse(p.at)>=Date.parse(range.from)&&Date.parse(p.at)<Date.parse(range.to)));
  const viewer=await createPropertyRole(a.auth,a.context,{name:'Agenda de consulta',description:null,permissions:['AGENDA_TASK_VIEW']},metadata);
  await pool.query('INSERT INTO membership_role(membership_id,role_id,property_id,assigned_by) SELECT id,$2,property_id,user_id FROM property_membership WHERE user_id=$1 AND property_id=$3',[a.auth.userId,viewer.id,a.context.propertyId]);
  const restricted=await offlineCalendar({...a.auth,activeRoleId:viewer.id},{...a.context,roleId:viewer.id,permissions:new Set<string>(viewer.permissions)});
  assert.equal(restricted.roleId,viewer.id);assert.ok(restricted.items.every(item=>!item.canManage));
  for(const query of [{lat:'',lon:'0'},{lat:'NaN',lon:'1'},{lat:'91',lon:'0'},{lat:'0',lon:'181'}])assert.equal(weatherQuery.safeParse(query).success,false);
  assert.deepEqual(weatherQuery.parse({lat:'0',lon:'0'}),{lat:0,lon:0});
  const normalized=normalizeWeather(sample,{lat:-2.17,lon:-79.92},new Date(Date.now()+3600000).toISOString());
  assert.equal(normalized.intervals.length,3,'Overlapping six-hour intervals are not counted twice');
  assert.equal(normalized.intervals[1]!.to,'2026-10-16T11:00:00.000Z');assert.equal(normalized.intervals[0]!.rainMm,1);
  let calls=0;let upstream='';let upstreamHeaders:Headers|null=null;let fail=false;
  globalThis.fetch=(async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
   if(!String(input).startsWith('https://api.met.no/'))return nativeFetch(input,init);
   calls++;upstream=String(input);upstreamHeaders=new Headers(init?.headers);if(fail)throw Error('Provider unavailable');
   return new Response(JSON.stringify(sample),{headers:{expires:new Date(Date.now()+3600000).toUTCString(),'last-modified':'Fri, 16 Oct 2026 00:00:00 GMT'}});
  }) as typeof fetch;
  const headers={authorization:`Bearer ${a.session.accessToken}`};
  let response=await nativeFetch(url+'/agenda/weather?lat=-2.170049&lon=-79.92001',{headers});assert.equal(response.status,200);
  assert.ok(upstream.includes('lat=-2.17&lon=-79.92'));assert.equal(calls,1);
  assert.equal((upstreamHeaders as Headers|null)?.get('authorization'),null);assert.ok((upstreamHeaders as Headers|null)?.get('user-agent')?.includes('jesusmedrandam/SGB'));
  await weatherForecast({lat:-2.17,lon:-79.92});assert.equal(calls,1,'Honors upstream expiry and shares cache for rounded coordinates');
  response=await nativeFetch(url+'/agenda/offline',{headers});assert.equal(response.status,200);assert.equal((await response.json()).data.propertyId,a.context.propertyId);
  assert.equal((await nativeFetch(url+'/agenda/weather?lat=&lon=0',{headers})).status,400);
  assert.equal((await nativeFetch(url+'/agenda/weather?lat=-2&lon=-79')).status,401);assert.equal((await nativeFetch(url+'/agenda/offline')).status,401);
  assert.equal((await (await nativeFetch(url+'/health/ready')).json()).calendarOfflineWeatherReady,true);
  await new Promise(resolve=>setTimeout(resolve,120));fail=true;
  assert.equal((await nativeFetch(url+'/agenda/weather?lat=1&lon=2',{headers})).status,503);
  assert.equal((await nativeFetch(url+'/agenda/offline',{headers})).status,200,'Weather failure never blocks the calendar copy');
 }finally{globalThis.fetch=nativeFetch;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await pool.end();}
});
