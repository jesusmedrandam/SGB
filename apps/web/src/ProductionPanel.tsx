import {type FormEvent,useEffect,useMemo,useState} from 'react';
import {ApiRequestError,createLactation,finishLactation,getProduction,recordMilk,
  recordTank,setLactationMilking,setCowMilking,type MilkShift,type ProductionRecords} from './api';

function localDate(){const date=new Date();return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;}
const issue=(error:unknown)=>error instanceof ApiRequestError ? error.message
  : error instanceof Error ? error.message : 'No se pudo guardar la producción.';
const optional=(data:FormData,key:string)=>String(data.get(key)||'').trim()||null;
const shiftName:Record<MilkShift,string>={MORNING:'Mañana',AFTERNOON:'Tarde',NIGHT:'Noche',SINGLE:'Único'};
function ShiftSelect(){return <select name="shift" defaultValue="SINGLE">
  {Object.entries(shiftName).map(([code,label])=><option key={code} value={code}>{label}</option>)}
</select>;}

export function ProductionPanel({accessToken,canManage,initialAnimalId}:{accessToken:string;
  canManage:boolean;initialAnimalId?:string|undefined}){
  const [records,setRecords]=useState<ProductionRecords|null>(null);
  const [revision,setRevision]=useState(0);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [date,setDate]=useState(localDate());
  const [activeForm,setActiveForm]=useState<'LACTATION'|'MILK'|'TANK'|null>(null);
  useEffect(()=>{
    let active=true;
    void getProduction(accessToken).then((value)=>{if(active)setRecords(value);})
      .catch((failure)=>{if(active)setError(issue(failure));});
    return ()=>{active=false;};
  },[accessToken,revision]);
  const milkingCows=records?.cows.filter((row)=>row.inMilking)??[];
  const [prefilledAnimalId,setPrefilledAnimalId]=useState<string|null>(null);
  useEffect(()=>{if(!initialAnimalId||initialAnimalId===prefilledAnimalId||!records||!canManage)return;
    if(records.cows.some(row=>row.id===initialAnimalId&&row.inMilking)){
      setActiveForm('MILK');setPrefilledAnimalId(initialAnimalId);}
  },[initialAnimalId,prefilledAnimalId,records,canManage]);
  const daily=useMemo(()=>({
    milk:records?.milk.filter((row)=>row.producedOn===date)??[],
    tanks:records?.tanks.filter((row)=>row.producedOn===date)??[],
  }),[records,date]);
  async function run(operation:()=>Promise<unknown>,form?:HTMLFormElement){
    setBusy(true);setError(null);
    try{await operation();form?.reset();setRevision((value)=>value+1);}
    catch(failure){setError(issue(failure));}
    finally{setBusy(false);}
  }
  function start(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=event.currentTarget;
    const data=new FormData(form);
    void run(()=>createLactation(accessToken,{birthId:String(data.get('birthId')),
      inMilking:data.get('inMilking')==='on',notes:optional(data,'notes')}),form);
  }
  function milk(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=event.currentTarget;
    const data=new FormData(form);
    void run(()=>recordMilk(accessToken,{cowId:String(data.get('cowId')),
      producedOn:String(data.get('producedOn')),shift:String(data.get('shift')) as MilkShift,
      liters:Number(data.get('liters')),source:String(data.get('source')) as 'MANUAL'|'SENSOR',
      externalReference:optional(data,'externalReference'),notes:optional(data,'notes')}),form);
  }
  function tank(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=event.currentTarget;
    const data=new FormData(form);
    void run(()=>recordTank(accessToken,{producedOn:String(data.get('producedOn')),
      shift:String(data.get('shift')) as MilkShift,liters:Number(data.get('liters')),
      source:String(data.get('source')) as 'MANUAL'|'SENSOR',
      externalReference:optional(data,'externalReference'),notes:optional(data,'notes')}),form);
  }
  return <section className="section-block production-panel">
    <div className="section-heading"><div><span className="eyebrow">Núcleo ganadero</span>
      <h2>Producción de leche</h2><p className="muted">Lactancias, ordeños por vaca y mediciones de tanque.</p>
    </div></div>
    {error&&<div role="alert" className="form-error admin-error">{error}</div>}
    {!records&&!error&&<p className="muted">Cargando producción…</p>}
    {canManage&&records&&<div className="form-toolbar" aria-label="Registrar producción">
      {([['LACTATION','Iniciar lactancia'],['MILK','Ordeño'],['TANK','Tanque']] as const)
        .map(([id,label])=><button type="button" key={id} className={activeForm===id?'active':''}
          aria-pressed={activeForm===id} onClick={()=>setActiveForm(activeForm===id?null:id)}>{label}</button>)}
    </div>}
    {canManage&&records&&activeForm&&<div className="production-forms">
      <form className="group-new-form" onSubmit={start} hidden={activeForm!=='LACTATION'}>
        <h3>Iniciar lactancia</h3>
        <label><span>Parto *</span><select name="birthId" required defaultValue="">
          <option value="" disabled>Selecciona el parto de la vaca</option>
          {records.births.map((row)=><option key={row.id} value={row.id}>{row.cowName} · {row.occurredOn}</option>)}
        </select></label>
        <label><span>En ordeño</span><input type="checkbox" name="inMilking" defaultChecked /></label>
        <label><span>Observaciones</span><textarea name="notes" maxLength={2000}/></label>
        <button className="primary-button compact" disabled={busy||!records.births.length}>Iniciar lactancia</button>
      </form>
      <form className="group-new-form" onSubmit={milk} hidden={activeForm!=='MILK'}>
        <h3>Registrar ordeño</h3>
        <label><span>Vaca en ordeño *</span><select name="cowId" required
          defaultValue={milkingCows.some(row=>row.id===initialAnimalId)?initialAnimalId:''}>
          <option value="" disabled>Selecciona la vaca</option>
          {milkingCows.map((row)=><option key={row.id} value={row.id}>
            {row.name}{row.lactationId?' · con lactancia':' · sin lactancia'}</option>)}
        </select></label>
        <label><span>Fecha *</span><input type="date" name="producedOn" required defaultValue={localDate()} /></label>
        <label><span>Turno</span><ShiftSelect/></label>
        <label><span>Litros *</span><input type="number" name="liters" min="0" max="10000" step="0.001" required /></label>
        <label><span>Fuente</span><select name="source" defaultValue="MANUAL">
          <option value="MANUAL">Manual</option><option value="SENSOR">Sensor</option>
        </select></label>
        <label><span>Referencia externa</span><input name="externalReference" maxLength={160}/></label>
        <label><span>Observaciones</span><textarea name="notes" maxLength={2000}/></label>
        <button className="primary-button compact" disabled={busy||!milkingCows.length}>Guardar ordeño</button>
      </form>
      <form className="group-new-form" onSubmit={tank} hidden={activeForm!=='TANK'}>
        <h3>Registrar tanque</h3>
        <label><span>Fecha *</span><input type="date" name="producedOn" required defaultValue={localDate()}/></label>
        <label><span>Turno</span><ShiftSelect/></label>
        <label><span>Litros *</span><input type="number" name="liters" min="0" max="100000" step="0.001" required/></label>
        <label><span>Fuente</span><select name="source" defaultValue="MANUAL">
          <option value="MANUAL">Manual</option><option value="SENSOR">Sensor</option>
        </select></label>
        <label><span>Referencia externa</span><input name="externalReference" maxLength={160}/></label>
        <label><span>Observaciones</span><textarea name="notes" maxLength={2000}/></label>
        <button className="primary-button compact" disabled={busy}>Guardar tanque</button>
      </form>
    </div>}
    {records&&<div className="production-forms">
      <div><h3>Vacas aptas para ordeño</h3>
        {!records.cows.length&&<p className="muted">No hay vacas con parto reciente.</p>}
        {records.cows.map((cow)=><details key={cow.id} className="group-location-item record-line">
          <summary><strong>{cow.name}</strong></summary>
          <small>{cow.inMilking?'En ordeño':'Sin ordeño'}{cow.lactationId?' · con lactancia':''}</small>
          {canManage&&<button className="secondary-button compact" disabled={busy}
            onClick={()=>void run(()=>setCowMilking(accessToken,cow.id,!cow.inMilking))}>
            {cow.inMilking?'Pausar ordeño':'Activar ordeño'}</button>}
        </details>)}
      </div>
      <div><h3>Lactancias</h3>
        {!records.lactations.length&&<p className="muted">Sin lactancias registradas.</p>}
        {records.lactations.map((row)=><details key={row.id} className="group-location-item record-line">
          <summary><strong>{row.cowName} · {row.startedOn}</strong></summary>
          <small>{row.endedOn?`Cerrada ${row.endedOn}`:row.inMilking?'En ordeño':'Pausada'}</small>
          {canManage&&!row.endedOn&&<div className="group-inline-form">
            <button className="secondary-button compact" disabled={busy}
              onClick={()=>void run(()=>setLactationMilking(accessToken,row.id,!row.inMilking))}>
              {row.inMilking?'Pausar ordeño':'Reanudar ordeño'}</button>
            <button className="secondary-button compact" disabled={busy}
              onClick={()=>{const endedOn=window.prompt('Fecha de cierre (AAAA-MM-DD)',localDate());
                if(endedOn)void run(()=>finishLactation(accessToken,row.id,endedOn));}}>
              Cerrar lactancia</button>
          </div>}
        </details>)}</div>
      <div><h3>Resumen del día</h3>
        <label><span>Fecha</span><input type="date" value={date}
          onChange={(event)=>setDate(event.target.value)}/></label>
        <p><strong>Vacas:</strong> {daily.milk.reduce((sum,row)=>sum+row.liters,0).toFixed(3)} L</p>
        <p><strong>Tanque:</strong> {daily.tanks.reduce((sum,row)=>sum+row.liters,0).toFixed(3)} L</p>
        {daily.milk.map((row)=><article key={row.id} className="group-location-item">
          <strong>{row.cowName} · {row.liters.toFixed(3)} L</strong>
          <small>{shiftName[row.shift as MilkShift]??row.shift} · {row.source}</small>
        </article>)}
        {daily.tanks.map((row)=><article key={row.id} className="group-location-item">
          <strong>Tanque · {row.liters.toFixed(3)} L</strong>
          <small>{shiftName[row.shift as MilkShift]??row.shift} · {row.source}</small>
        </article>)}
      </div>
    </div>}
  </section>;
}
