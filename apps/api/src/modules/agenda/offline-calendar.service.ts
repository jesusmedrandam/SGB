import type {AuthState,PropertyContext} from '../auth/auth.types.js';
import {agendaCalendar} from './calendar.service.js';
import {moonPhases} from './moon.service.js';

export function offlineCalendarRange(today=new Date()){
 const day=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Guayaquil',year:'numeric',month:'2-digit',day:'2-digit'}).format(today);
 const first=new Date(day.slice(0,7)+'-01T12:00:00Z');first.setUTCMonth(first.getUTCMonth()-1);
 const from=first.toISOString().slice(0,10);first.setUTCMonth(first.getUTCMonth()+3);
 return {from:from+'T00:00:00-05:00',to:first.toISOString().slice(0,10)+'T00:00:00-05:00'};
}
export async function offlineCalendar(auth:AuthState,context:PropertyContext){
 const range=offlineCalendarRange();
 const [items,moon]=await Promise.all([
  agendaCalendar(auth,context,{...range,propertyId:context.propertyId}),
  moonPhases(Number(range.from.slice(0,4))).catch(()=>null)]);
 return {propertyId:context.propertyId,roleId:context.roleId,range,updatedAt:new Date().toISOString(),items,
  options:{properties:[{users:[],animals:[],tasks:false,events:false,id:context.propertyId,name:context.propertyName,roleId:context.roleId}]},
  moon:moon?{...moon,phases:moon.phases.filter(row=>Date.parse(row.at)>=Date.parse(range.from)&&Date.parse(row.at)<Date.parse(range.to))}:null};
}
