import {type FormEvent,useEffect,useState} from 'react';
import {ApiRequestError,applyCleaning,cancelCleaning,createCleaning,createCleaningProduct,
  getCleaningOptions,getCleaningProducts,getCleanings,listCatalogItems,updateCleaning,
  type CatalogItem,type CleaningInput,type CleaningOptions,type CleaningProduct,type CleaningRecord} from './api';
import {RecordMedia} from './RecordMedia';
const labels={FUMIGACION:'Fumigación',TALA_SELECTIVA:'Tala selectiva',
  DESBROCE:'Desbroce',OTRA:'Otra labor'};
const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const message=(error:unknown)=>error instanceof ApiRequestError?error.message:
  error instanceof Error?error.message:'No se pudo guardar la limpieza.';
type ProductLine=CleaningInput['products'][number];
type OperatorLine=CleaningInput['operators'][number];
export function CleaningPanel({accessToken,canManage,canViewMedia,canManageMedia}:{accessToken:string;
  canManage:boolean;canViewMedia:boolean;canManageMedia:boolean}){
  const [records,setRecords]=useState<CleaningRecord[]|null>(null);
  const [options,setOptions]=useState<CleaningOptions|null>(null);
  const [products,setProducts]=useState<CleaningProduct[]>([]);
  const [categories,setCategories]=useState<CatalogItem[]>([]);
  const [revision,setRevision]=useState(0);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [showForm,setShowForm]=useState(false);
  const [showProduct,setShowProduct]=useState(false);
  const [editing,setEditing]=useState<CleaningRecord|null>(null);
  const [locationId,setLocationId]=useState('');
  const [areaType,setAreaType]=useState<CleaningInput['areaType']>('TOTAL');
  const [activities,setActivities]=useState<CleaningInput['activities']>([]);
  const [applicationUnit,setApplicationUnit]=useState<'TANQUES'|'BOMBADAS'>('TANQUES');
  const [applicationCount,setApplicationCount]=useState('');
  const [lines,setLines]=useState<ProductLine[]>([]);
  const [operators,setOperators]=useState<OperatorLine[]>([]);
  useEffect(()=>{let active=true;void Promise.all([getCleanings(accessToken),
    getCleaningOptions(accessToken),getCleaningProducts(accessToken),
    listCatalogItems(accessToken,'AGROCHEMICAL_CATEGORIES')]).then(([items,choices,catalog,types])=>{
    if(active){setRecords(items);setOptions(choices);setProducts(catalog);setCategories(types);}
  }).catch((failure)=>{if(active)setError(message(failure));});return ()=>{active=false;};
  },[accessToken,revision]);
  function reset(){setEditing(null);setShowForm(false);setLocationId('');setAreaType('TOTAL');
    setActivities([]);setApplicationCount('');setApplicationUnit('TANQUES');setLines([]);setOperators([]);}
  function edit(item:CleaningRecord){setEditing(item);setShowForm(true);setLocationId(item.locationId);
    setAreaType(item.areaType);setActivities(item.activities);setApplicationUnit(item.applicationUnit??'TANQUES');
    setApplicationCount(item.applicationCount==null?'':String(item.applicationCount));
    setLines(item.products.map(({productId,unitCode,quantityPerApplication,notes})=>({
      productId,unitCode,quantityPerApplication,notes:notes??null})));setOperators(item.operators);
    window.scrollTo({top:0,behavior:'smooth'});}
  async function run(action:()=>Promise<unknown>,done?:()=>void){setBusy(true);setError(null);
    try{await action();done?.();setRevision((value)=>value+1);}
    catch(failure){setError(message(failure));window.scrollTo({top:0,behavior:'smooth'});}
    finally{setBusy(false);}}
  function saveProduct(event:FormEvent<HTMLFormElement>){event.preventDefault();
    const data=new FormData(event.currentTarget);
    void run(()=>createCleaningProduct(accessToken,{name:String(data.get('name')).trim(),
      category:String(data.get('category')).trim()||null,
      activeIngredient:String(data.get('activeIngredient')).trim()||null,
      formulatedBy:String(data.get('formulatedBy')).trim()||null,
      description:String(data.get('description')).trim()||null}),()=>setShowProduct(false));}
  function save(event:FormEvent<HTMLFormElement>){event.preventDefault();const data=new FormData(event.currentTarget);
    const spray=activities.includes('FUMIGACION');
    const input:CleaningInput={locationId,startedOn:String(data.get('startedOn')),
      finishedOn:String(data.get('finishedOn'))||null,activities,applicationUnit:spray?applicationUnit:null,
      applicationCount:spray&&applicationCount?Number(applicationCount):null,
      tankCapacityLiters:spray&&data.get('capacity')?Number(data.get('capacity')):null,
      areaType,partialPercent:areaType==='PARCIAL'?Number(data.get('partialPercent')):null,
      notes:String(data.get('notes')).trim()||null,products:spray?lines:[],operators,
      ...(editing?{expectedVersion:editing.version}:{})};
    void run(()=>editing?updateCleaning(accessToken,editing.id,input)
      :createCleaning(accessToken,input),reset);
  }
  const location=options?.locations.find((item)=>item.id===locationId);
  return <section className="section-block cleanings-panel">
    <div className="section-heading"><div><span className="eyebrow">Potreros</span><h2>Limpieza de potreros</h2>
      <p className="muted">Labores, operadores y consumo total calculado por tanque o bombada.</p></div>
      {canManage&&<div className="movement-actions"><button className="secondary-button compact" type="button"
        onClick={()=>setShowProduct((value)=>!value)}>+ Producto</button>
        <button className="primary-button compact" type="button" onClick={()=>showForm?reset():setShowForm(true)}>
          {showForm?'Cerrar':'+ Limpieza'}</button></div>}
    </div>
    {error&&<div role="alert" className="form-error admin-error">{error}</div>}
    {canManage&&showProduct&&<form className="movement-form" onSubmit={saveProduct}>
      <h3>Nuevo producto compartido en la cuenta</h3>
      <label><span>Nombre *</span><input name="name" required minLength={2} maxLength={160}/></label>
      <label><span>Categoría *</span><select name="category" required><option value="">Selecciona</option>
        {categories.filter(item=>item.active).map(item=><option key={item.id} value={item.name}>{item.name}</option>)}
      </select><small>Agrega categorías nuevas desde Catálogos.</small></label>
      <label><span>Principio activo</span><textarea name="activeIngredient" maxLength={2000}/></label>
      <label><span>Formulado por</span><input name="formulatedBy" maxLength={200}/></label>
      <label className="movement-wide"><span>Descripción</span><textarea name="description" maxLength={2000}/></label>
      <button className="primary-button compact" disabled={busy}>Guardar producto</button></form>}
    {canManage&&showForm&&options&&<form className="movement-form" onSubmit={save}
      key={editing?.id??'new'}><h3>{editing?'Editar borrador':'Nueva limpieza'}</h3>
      <label><span>Potrero *</span><select required value={locationId}
        onChange={(event)=>setLocationId(event.target.value)}><option value="">Selecciona</option>
        {options.locations.map((item)=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label><span>Inicio *</span><input name="startedOn" type="date" max={today()} required
        defaultValue={editing?.startedOn??today()}/></label>
      <label><span>Finalización</span><input name="finishedOn" type="date" max={today()}
        defaultValue={editing?.finishedOn??''}/></label>
      <label><span>Área intervenida</span><select value={areaType}
        onChange={(event)=>setAreaType(event.target.value as CleaningInput['areaType'])}>
        <option value="TOTAL">Total</option><option value="PARCIAL">Parcial</option></select></label>
      {areaType==='PARCIAL'&&<label><span>Porcentaje del potrero *</span>
        <input name="partialPercent" type="number" min="0.01" max="99.99" step="0.01"
          required defaultValue={editing?.partialPercent??''}/></label>}
      {location?.areaValue&&<p className="muted movement-wide">Área del potrero: {location.areaValue} {location.areaUnitCode}.
        El área intervenida se calculará automáticamente.</p>}
      <fieldset className="movement-wide cleaning-activities"><legend>Actividades *</legend>
        {Object.entries(labels).map(([code,label])=><label key={code}><input type="checkbox"
          checked={activities.includes(code as CleaningInput['activities'][number])}
          onChange={(event)=>setActivities(event.target.checked
            ?[...activities,code as CleaningInput['activities'][number]]
            :activities.filter((item)=>item!==code))}/>{label}</label>)}</fieldset>
      {activities.includes('FUMIGACION')&&<><label><span>Unidad de aplicación</span><select value={applicationUnit}
        onChange={(event)=>setApplicationUnit(event.target.value as 'TANQUES'|'BOMBADAS')}>
        <option value="TANQUES">Tanques</option><option value="BOMBADAS">Bombadas</option></select></label>
      <label><span>Cantidad de {applicationUnit==='TANQUES'?'tanques':'bombadas'}</span>
        <input type="number" min="0.01" step="0.01" value={applicationCount}
          onChange={(event)=>setApplicationCount(event.target.value)}/></label>
      <label><span>Capacidad (litros)</span><input name="capacity" type="number" min="0.01"
        step="0.01" defaultValue={editing?.tankCapacityLiters??''}/></label></>}
      <label className="movement-wide"><span>Observaciones</span><textarea name="notes" maxLength={5000}
        defaultValue={editing?.notes??''}/></label>
      {activities.includes('FUMIGACION')&&<div className="movement-wide cleaning-lines"><div className="movement-card-top"><h3>Productos</h3>
        <button type="button" className="secondary-button compact" onClick={()=>setLines([...lines,
          {productId:'',unitCode:'MILLILITER',quantityPerApplication:1}])}>+ Producto aplicado</button></div>
        {lines.map((line,index)=><div className="cleaning-line" key={index}>
          <select aria-label="Producto" value={line.productId} required onChange={(event)=>setLines(lines.map(
            (item,i)=>i===index?{...item,productId:event.target.value}:item))}>
            <option value="">Selecciona</option>{products.filter((item)=>item.active).map((item)=><option
              key={item.id} value={item.id}>{item.name}</option>)}</select>
          <input type="number" min="0.0001" step="any" value={line.quantityPerApplication}
            aria-label="Cantidad por aplicación" required onChange={(event)=>setLines(lines.map((item,i)=>
              i===index?{...item,quantityPerApplication:Number(event.target.value)}:item))}/>
          <select aria-label="Unidad" value={line.unitCode} onChange={(event)=>setLines(lines.map((
            item,i)=>i===index?{...item,unitCode:event.target.value}:item))}>
            {options.units.map((unit)=><option key={unit.code} value={unit.code}>{unit.symbol}</option>)}</select>
          <strong>Total: {applicationCount?Number((Number(applicationCount)*line.quantityPerApplication)
            .toFixed(4)):'—'}</strong><button type="button" className="secondary-button compact"
              onClick={()=>setLines(lines.filter((_,i)=>i!==index))}>Quitar</button>
        </div>)}</div>}
      <div className="movement-wide cleaning-lines"><div className="movement-card-top"><h3>Operadores</h3>
        <button type="button" className="secondary-button compact" onClick={()=>setOperators([...operators,
          {name:'',function:null}])}>+ Operador</button></div>
        {operators.map((item,index)=><div className="cleaning-line" key={index}>
          <input aria-label="Nombre de operador" placeholder="Nombre" required value={item.name}
            onChange={(event)=>setOperators(operators.map((entry,i)=>i===index
              ?{...entry,name:event.target.value}:entry))}/>
          <input aria-label="Función" placeholder="Función" value={item.function??''}
            onChange={(event)=>setOperators(operators.map((entry,i)=>i===index
              ?{...entry,function:event.target.value}:entry))}/>
          <button type="button" className="secondary-button compact"
            onClick={()=>setOperators(operators.filter((_,i)=>i!==index))}>Quitar</button></div>)}</div>
      <button className="primary-button compact" disabled={busy||!activities.length||!locationId
        ||activities.includes('FUMIGACION')&&lines.length>0&&!applicationCount}>
        {editing?'Guardar borrador':'Crear borrador'}</button>
    </form>}
    <div className="movement-list"><h3>Labores registradas</h3>
      {!records&&!error&&<p className="muted">Cargando limpiezas…</p>}
      {records?.length===0&&<p className="muted">Aún no hay limpiezas registradas.</p>}
      {records?.map((item)=><article className="movement-card" key={item.id}>
        <div className="movement-card-top"><div><strong>{item.locationName}</strong>
          <small>{item.startedOn}{item.finishedOn?` → ${item.finishedOn}`:''} · {item.activities
            .map((activity)=>labels[activity]).join(', ')}</small></div>
          <span className={`movement-status status-${item.status.toLowerCase()}`}>
            {item.status==='BORRADOR'?'Borrador':item.status==='COMPLETADO'?'Completado':'Cancelado'}</span></div>
        <p>Área {item.areaType==='TOTAL'?'total':`${item.partialPercent}%`} · {item.areaValue??'Sin área'}
          {item.areaUnitCode?` ${item.areaUnitCode}`:''}
          {item.applicationCount!=null?` · ${item.applicationCount} ${item.applicationUnit==='TANQUES'?'tanques':'bombadas'}`:''}</p>
        <details className="record-detail"><summary>Ver limpieza completa</summary>
          {item.notes&&<p>{item.notes}</p>}
          {item.products.map((product)=><span className="movement-animal-name" key={product.productId}>
            {product.productName}: {product.totalQuantity} {product.unitCode} en total</span>)}
          {item.operators.map((operator)=><span className="movement-animal-name" key={operator.name}>
            {operator.name}{operator.function?` · ${operator.function}`:''}</span>)}
          {canViewMedia&&<RecordMedia accessToken={accessToken} entityType="CLEANING" entityId={item.id}
            canManage={canManageMedia}/>}
        {canManage&&item.status==='BORRADOR'&&<div className="movement-actions">
          <button type="button" className="secondary-button compact" disabled={busy}
            onClick={()=>edit(item)}>Editar</button>
          <button type="button" className="primary-button compact" disabled={busy}
            onClick={()=>void run(()=>applyCleaning(accessToken,item.id))}>Completar</button>
          <button type="button" className="secondary-button compact" disabled={busy}
            onClick={()=>void run(()=>cancelCleaning(accessToken,item.id))}>Cancelar</button></div>}</details>
      </article>)}</div>
  </section>;
}
