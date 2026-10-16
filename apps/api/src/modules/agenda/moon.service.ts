import {z} from 'zod';
import {ApiError} from '../../core/errors.js';
import {bundledMoonPhases} from './moon-data.js';

const responseSchema=z.object({phasedata:z.array(z.object({year:z.number().int(),month:z.number().int().min(1).max(12),
 day:z.number().int().min(1).max(31),time:z.string().regex(/^\d{2}:\d{2}$/),
 phase:z.enum(['New Moon','First Quarter','Full Moon','Last Quarter'])})).min(40).max(60)});
const cache=new Map<number,{until:number;data:Array<{at:string;phase:string}>}>();
const inflight=new Map<number,Promise<Array<{at:string;phase:string}>>>();
async function yearPhases(year:number){
 if(bundledMoonPhases[year])return bundledMoonPhases[year];
 const saved=cache.get(year);if(saved&&saved.until>Date.now())return saved.data;
 const pending=inflight.get(year);if(pending)return pending;
 const work=(async()=>{
  const response=await fetch(`https://aa.usno.navy.mil/api/moon/phases/year?year=${year}`,{signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new Error('Astronomical service unavailable');
  const data=responseSchema.parse(await response.json()).phasedata.map(row=>({
   at:`${row.year}-${String(row.month).padStart(2,'0')}-${String(row.day).padStart(2,'0')}T${row.time}:00Z`,phase:row.phase}));
  if(cache.size>=6)cache.delete(cache.keys().next().value!);
  cache.set(year,{until:Date.now()+86400000,data});return data;
 })();inflight.set(year,work);
 try{return await work;}finally{inflight.delete(year);}
}
export async function moonPhases(year:number){
 try{return {source:'US Naval Observatory',phases:(await Promise.all([yearPhases(year),yearPhases(year+1)])).flat()};}
 catch{throw new ApiError(503,'MOON_UNAVAILABLE','No se pudieron consultar las fases lunares. Puedes seguir usando el calendario.');}
}
