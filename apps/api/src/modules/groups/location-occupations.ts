export interface LocationStay {
 locationId:string;animalId:string;startedAt:string;endedAt:string|null;
 startedOn:string;endedOn:string|null;countsForOccupancy?:boolean;
}
export interface OccupationSegment {startedOn:string;endedOn:string|null;animalCount:number;days:number}
export interface LocationOccupation {
 startedOn:string;endedOn:string|null;animalCount:number;restStartedOn:string|null;
 durationDays:number;segments:OccupationSegment[];
 pauses?:Array<{startedOn:string;endedOn:string;days:number}>;
}
const days=(start:string,end:string)=>Math.max(0,Math.round((Date.parse(end+'T00:00:00Z')-Date.parse(start+'T00:00:00Z'))/86400000));

// Civil days match movement dates. Short pauses only join when the pasture had usable grass left.
export function locationOccupations(stays:LocationStay[],initialRest:string|null,
 today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Guayaquil'}).format(new Date()),
 observations:Array<{observedOn:string;exitState:string|null}>=[]){
 const events=new Map<string,Map<string,number>>(),current=new Set<string>();
 const event=(on:string,id:string,delta:number)=>{const values=events.get(on)??new Map<string,number>();values.set(id,(values.get(id)??0)+delta);events.set(on,values);};
 for(const stay of stays){
  if(stay.countsForOccupancy===false)continue;
  if(stay.endedAt===null)current.add(stay.animalId);
  if(stay.endedOn!==null&&stay.endedOn<=stay.startedOn)continue;
  event(stay.startedOn,stay.animalId,1);if(stay.endedOn)event(stay.endedOn,stay.animalId,-1);
 }
 const boundaries=[...events.keys()].sort(),active=new Map<string,number>(),periods:LocationOccupation[]=[];
 for(const [index,on] of boundaries.entries()){
  for(const [id,delta] of events.get(on)!){const count=(active.get(id)??0)+delta;if(count>0)active.set(id,count);else active.delete(id);}
  if(!active.size)continue;
  const end=boundaries[index+1]??null,length=days(on,end??today);
  if(end!==null&&!length)continue;
  let period=periods.at(-1);
  if(!period||period.endedOn!==on||period.startedOn!==on&&observations.some(row=>row.observedOn===on&&row.exitState==='DEPLETED')){
   period={startedOn:on,endedOn:end,animalCount:active.size,durationDays:0,segments:[],
    restStartedOn:period?.endedOn??(initialRest&&initialRest<=on?initialRest:null)};periods.push(period);
  }
  period.endedOn=end;period.durationDays+=length;
  if(length>0){
   period.animalCount=Math.max(period.segments.length?period.animalCount:0,active.size);
   const previous=period.segments.at(-1);
   if(previous&&previous.animalCount===active.size&&previous.endedOn===on){previous.endedOn=end;previous.days+=length;}
   else period.segments.push({startedOn:on,endedOn:end,animalCount:active.size,days:length});
  }else if(end===null)period.segments.push({startedOn:on,endedOn:null,animalCount:active.size,days:0});
 }
 const joined:LocationOccupation[]=[];
 for(const period of periods){
  const previous=joined.at(-1),gap=previous?.endedOn?days(previous.endedOn,period.startedOn):0;
  const exit=previous?observations.filter(row=>row.observedOn>=previous.startedOn&&row.observedOn<=(previous.endedOn??today)&&row.exitState).at(-1):null;
  if(previous&&previous.endedOn&&gap>0&&gap<=7&&exit?.exitState==='REMAINS'){
   previous.pauses=[...(previous.pauses??[]),{startedOn:previous.endedOn,endedOn:period.startedOn,days:gap}];
   previous.endedOn=period.endedOn;previous.durationDays+=period.durationDays;
   previous.animalCount=Math.max(previous.animalCount,period.animalCount);previous.segments.push(...period.segments);
  }else joined.push(period);
 }
 return {currentAnimalCount:current.size,occupationHistory:joined.reverse()};
}
