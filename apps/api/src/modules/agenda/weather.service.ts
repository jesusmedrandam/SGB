import {z} from 'zod';
import {ApiError} from '../../core/errors.js';

export const weatherQuery=z.object({lat:z.string().trim().min(1).transform(Number).pipe(z.number().finite().min(-90).max(90)),lon:z.string().trim().min(1).transform(Number).pipe(z.number().finite().min(-180).max(180))});
const period=z.object({summary:z.object({symbol_code:z.string().max(100)}),details:z.object({precipitation_amount:z.number().nonnegative().nullable().optional()})});
const forecastSchema=z.object({properties:z.object({meta:z.object({updated_at:z.iso.datetime()}),timeseries:z.array(z.object({
 time:z.iso.datetime(),data:z.object({instant:z.object({details:z.object({air_temperature:z.number().finite()})}),
 next_1_hours:period.optional(),next_6_hours:period.optional()})})).min(1).max(1000)})});
export function normalizeWeather(raw:unknown,point:{lat:number;lon:number},expiresAt:string){
 const data=forecastSchema.parse(raw);let end=0;
 const intervals=data.properties.timeseries.flatMap(row=>{
  const start=Date.parse(row.time);if(start<end)return [];
  const period=row.data.next_1_hours??row.data.next_6_hours;if(!period)return [];
  const hours=row.data.next_1_hours?1:6;end=start+hours*3600000;
  return [{at:row.time,to:new Date(end).toISOString(),temperature:row.data.instant.details.air_temperature,
   symbol:period.summary.symbol_code,rainMm:period.details.precipitation_amount??null}];
 });
 if(!intervals.length)throw new Error('Missing forecast intervals');
 return {provider:'MET Norway',latitude:point.lat,longitude:point.lon,updatedAt:data.properties.meta.updated_at,
  retrievedAt:new Date().toISOString(),expiresAt,intervals};
}
type Forecast=ReturnType<typeof normalizeWeather>;
const cache=new Map<string,{data:Forecast;lastModified:string|null}>();
const pending=new Map<string,Promise<Forecast>>();let nextRequestAt=0;
export async function weatherForecast(point:{lat:number;lon:number}){
 const coordinates={lat:Math.round(point.lat*10000)/10000,lon:Math.round(point.lon*10000)/10000};
 const key=coordinates.lat+','+coordinates.lon;const saved=cache.get(key);
 if(saved&&Date.parse(saved.data.expiresAt)>Date.now())return saved.data;
 const existing=pending.get(key);if(existing)return existing;
 const work=(async()=>{
  // ponytail: one server limits upstream cache misses to 10/s; use a shared limiter if deployed with multiple instances.
  if(Date.now()<nextRequestAt)throw new Error('Weather service cooling down');nextRequestAt=Date.now()+100;
  const headers:Record<string,string>={'User-Agent':'SGB/2.0 https://github.com/jesusmedrandam/SGB'};
  if(saved?.lastModified)headers['If-Modified-Since']=saved.lastModified;
  const response=await fetch(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${coordinates.lat}&lon=${coordinates.lon}`,
   {headers,signal:AbortSignal.timeout(10000)});
  const expiresAt=new Date(Math.max(Date.now()+60000,Date.parse(response.headers.get('expires')??'')||Date.now()+1800000)).toISOString();
  if(response.status===304&&saved){saved.data={...saved.data,expiresAt,retrievedAt:new Date().toISOString()};return saved.data;}
  if(response.status===429){const delay=Number(response.headers.get('retry-after'));
   nextRequestAt=Date.now()+Math.max(60000,Number.isFinite(delay)?delay*1000:0);}
  if(!response.ok)throw new Error('Weather upstream unavailable');
  const data=normalizeWeather(await response.json(),coordinates,expiresAt);
  if(cache.size>=128)cache.delete(cache.keys().next().value!);
  cache.set(key,{data,lastModified:response.headers.get('last-modified')});return data;
 })();pending.set(key,work);
 try{return await work;}catch{throw new ApiError(503,'WEATHER_UNAVAILABLE','No se pudo actualizar el clima. Puedes seguir usando el calendario.');}
 finally{pending.delete(key);}
}
