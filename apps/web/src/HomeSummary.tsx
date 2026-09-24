import {useEffect,useState} from 'react';
import {getAnimalSummary,type AnimalSummary} from './api';
import {ShellIcon} from './ShellIcon';

const codes=['VACA','VACONA','TERNERA','TORO','TORETE','TERNERO'] as const;
const labels:Record<(typeof codes)[number],string>={VACA:'Vacas',VACONA:'Vaconas',
  TERNERA:'Terneras',TORO:'Toros',TORETE:'Toretes',TERNERO:'Terneros'};

export function HomeSummary({accessToken,onAnimals,onGroups,onClassification}:{accessToken:string;
  onAnimals:()=>void;onGroups:(()=>void)|undefined;onClassification:(code:string)=>void}){
  const [data,setData]=useState<AnimalSummary|null>(null);
  const [error,setError]=useState<string|null>(null);
  useEffect(()=>{let active=true;void getAnimalSummary(accessToken)
    .then(value=>{if(active)setData(value);})
    .catch(()=>{if(active)setError('No se pudo cargar el resumen ganadero.');});
    return()=>{active=false;};},[accessToken]);
  if(error)return <p role="alert" className="form-error">{error}</p>;
  if(!data)return <p className="muted">Cargando resumen de la propiedad…</p>;
  const count=(code:string)=>data.classifications.find(row=>row.code===code)?.count??0;
  const sex=(code:'FEMALE'|'MALE')=>data.sex.find(row=>row.sex===code)?.count??0;
  return <section className="home-herd" aria-label="Resumen de animales">
    <div className="home-herd-heading"><span className="stat-icon"><ShellIcon name="animals" size={23}/></span>
      <div><h2>Animales</h2><p>Inventario de la propiedad activa</p></div>
      <button type="button" className="home-herd-total" onClick={onAnimals}>
        <strong>{data.total}</strong><small>Ver todos ›</small></button></div>
    <div className="home-herd-facts"><button type="button" onClick={onAnimals}>
      <strong>{sex('FEMALE')}</strong><small>Hembras</small></button>
      <button type="button" onClick={onAnimals}><strong>{sex('MALE')}</strong><small>Machos</small></button>
      {onGroups&&<button type="button" onClick={onGroups}><strong>{data.groups.length}</strong><small>Grupos</small></button>}</div>
    <div className="home-herd-sections"><div><h3>Clasificación</h3>
      <div className="home-classification-grid">{codes.map(code=><button type="button" key={code}
        onClick={()=>onClassification(code)}><strong>{count(code)}</strong><small>{data.classifications.find(row=>row.code===code)?.label??labels[code]}</small></button>)}</div>
    </div>{onGroups&&<div><h3>Grupos de esta propiedad</h3><div className="home-group-grid">
      {data.groups.map(group=><button key={group.name} type="button" onClick={onGroups}>
        <strong>{group.count}</strong><small>{group.name}</small></button>)}
      {!data.groups.length&&<small className="muted">Todavía no hay grupos.</small>}
    </div></div>}</div>
  </section>;
}
