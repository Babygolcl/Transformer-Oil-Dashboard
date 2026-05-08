let RAW_DATA = [];
let currentData = [];

const LIMITS = {
  H2:{c1:100,c2:700,c3:1800},CH4:{c1:120,c2:400,c3:1000},
  C2H2:{c1:1,c2:9,c3:35},C2H4:{c1:50,c2:100,c3:200},
  C2H6:{c1:65,c2:100,c3:150},CO:{c1:350,c2:570,c3:1400},
  CO2:{c1:2500,c2:4000,c3:10000},TDCG:{c1:720,c2:1920,c3:4630},
};
const GAS_COLORS = {H2:'#4C72B0',CO:'#DD8452',CO2:'#2ca02c',CH4:'#C44E52',C2H4:'#8172B3',C2H2:'#d62728',C2H6:'#DA8BC3',TDCG:'#1f77b4',C3H6:'#bcbd22',C3H8:'#17becf'};
const COND_COLORS = {Normal:'#16a34a',Caution:'#ca8a04',Warning:'#ea580c',Critical:'#dc2626'};

let mainCharts = {};
let trendCharts = {};
let modalCharts = {};
let currentModalNo = null;

// Helpers
const fmt = (v,d=2) => (v==null)?'-':typeof v==='number'?v.toFixed(d):v;
const condBadge = c => ({Normal:'<span class="badge badge-green">Normal (C1)</span>',Caution:'<span class="badge badge-yellow">Caution (C2)</span>',Warning:'<span class="badge badge-orange">Warning (C3)</span>',Critical:'<span class="badge badge-red">Critical (C4)</span>'})[c]||`<span class="badge badge-gray">${c||'N/A'}</span>`;

// ── Physical / Electrical / Chemical condition helpers ──
function getPhysicalCondition(d) {
  const hasData=(d.color_number!=null)||(d.IFT!=null);
  if(!hasData) return 'N/A';
  const over=(d.color_number!=null&&d.color_number>2.5)||(d.IFT!=null&&d.IFT<25);
  return over?'Over Limit':'Normal';
}
function getElectricalCondition(d) {
  const hasData=(d.DBV!=null)||(d.DF_25C!=null)||(d.DF_100C!=null);
  if(!hasData) return 'N/A';
  const over=(d.DBV!=null&&d.DBV<30)||(d.DF_25C!=null&&d.DF_25C>0.5)||(d.DF_100C!=null&&d.DF_100C>5.0);
  return over?'Over Limit':'Normal';
}
function getChemicalCondition(d) {
  const hasData=(d.acidity!=null)||(d.moisture_ppm!=null)||(d.water_in_oil_pct!=null)||(d.water_in_paper_pct!=null);
  if(!hasData) return 'N/A';
  const over=(d.acidity!=null&&d.acidity>0.20)||(d.moisture_ppm!=null&&d.moisture_ppm>35)||(d.water_in_oil_pct!=null&&d.water_in_oil_pct>30)||(d.water_in_paper_pct!=null&&d.water_in_paper_pct>4);
  return over?'Over Limit':'Normal';
}
// DGA condition based on TDCG limits (IEEE C57.104-2008 primary metric)
// C1 ≤720=Normal | C2 721–1920=Caution | C3 1921–4630=Warning | C4 >4630=Critical
function getTDCGCondition(d) {
  const t=d.TDCG||0;
  if(t>4630) return 'Critical';
  if(t>1920) return 'Warning';
  if(t>720)  return 'Caution';
  return 'Normal';
}
function getIssues(d) {
  const i=[];
  // ── DGA: flag if any gas exceeds IEC 60599 L1 ──
  // IEEE C57.104-2008: C1≤=normal, C2=monitor, C3=plan outage, C4=critical
  const gasLims=[
    {k:'C2H2',C1:1, C2:9,   C3:35},
    {k:'H2',  C1:100,C2:700, C3:1800},
    {k:'CH4', C1:120,C2:400, C3:1000},
    {k:'C2H4',C1:50, C2:100, C3:200},
    {k:'C2H6',C1:65, C2:100, C3:150},
    {k:'CO',  C1:350,C2:570, C3:1400},
    {k:'CO2', C1:2500,C2:4000,C3:10000},
    {k:'TDCG',C1:720,C2:1920,C3:4630}
  ];
  const overGas=gasLims.filter(g=>(d[g.k]||0)>g.C1);
  if(overGas.length>0||d.dga_condition!=='Normal'){
    const hasC4=overGas.some(g=>(d[g.k]||0)>g.C3)||d.dga_condition==='Extreme';
    const hasC3=!hasC4&&(overGas.some(g=>(d[g.k]||0)>g.C2)||d.dga_condition==='Serious');
    const maxSev=hasC4?'Extreme':hasC3?'Serious':'Moderate';
    const gasStr=overGas.map(g=>{
      const v=d[g.k]||0;
      const cond=v>g.C3?'C4':v>g.C2?'C3':'C2';
      return `${g.k}=${fmt(v,0)}[${cond}]`;
    }).join(', ')||`TDCG=${fmt(d.TDCG,0)}`;
    i.push({type:'DGA',sev:maxSev,val:`${gasStr} (IEEE C57.104)`});
  }
  if(d.color_number>2.5) i.push({type:'Color',sev:'Moderate',val:`${fmt(d.color_number,1)} (Limit<2.5)`});
  if(d.IFT!=null&&d.IFT<25) i.push({type:'IFT',sev:'Serious',val:`${fmt(d.IFT,1)} mN/M (Limit>25)`});
  if(d.DBV!=null&&d.DBV<30) i.push({type:'DBV',sev:'Serious',val:`${fmt(d.DBV,1)} kV (Limit>30)`});
  if(d.DF_25C!=null&&d.DF_25C>0.5) i.push({type:'DF25°C',sev:'Moderate',val:`${fmt(d.DF_25C,3)}% (Limit<0.5%)`});
  if(d.acidity!=null&&d.acidity>0.20) i.push({type:'Acidity',sev:'Serious',val:`${fmt(d.acidity,3)} mgKOH/g (Limit<0.20)`});
  if(d.moisture_ppm!=null&&d.moisture_ppm>35) i.push({type:'Moisture',sev:'Serious',val:`${fmt(d.moisture_ppm,1)} ppm (Limit<35)`});
  if(d.water_in_oil_pct!=null&&d.water_in_oil_pct>30) i.push({type:'Water in Oil',sev:'Extreme',val:`${fmt(d.water_in_oil_pct,1)}% Saturation (Extremely Wet >30%)`});
  else if(d.water_in_oil_pct!=null&&d.water_in_oil_pct>20) i.push({type:'Water in Oil',sev:'Serious',val:`${fmt(d.water_in_oil_pct,1)}% Saturation (Wet 21-30%)`});
  else if(d.water_in_oil_pct!=null&&d.water_in_oil_pct>5) i.push({type:'Water in Oil',sev:'Moderate',val:`${fmt(d.water_in_oil_pct,1)}% Saturation (Moderate Wet 6-20%)`});
  if(d.water_in_paper_pct!=null&&d.water_in_paper_pct>4) i.push({type:'Water in Paper',sev:'Extreme',val:`${fmt(d.water_in_paper_pct,2)}% (Extremely Wet >4%)`});
  else if(d.water_in_paper_pct!=null&&d.water_in_paper_pct>2) i.push({type:'Water in Paper',sev:'Serious',val:`${fmt(d.water_in_paper_pct,2)}% (Wet Paper 2-4%)`});
  return i;
}
function getActionText(d) {
  if(d.recommendation_summary) return d.recommendation_summary;
  const iss=getIssues(d);
  if(!iss.length) return 'Normal Operation';
  const hasDGA=iss.some(i=>i.type==='DGA');
  const maxSev=iss.find(i=>i.sev==='Extreme')?'Extreme':iss.find(i=>i.sev==='Serious')?'Serious':'Moderate';
  if(maxSev==='Extreme') return 'Immediate Action Required';
  if(hasDGA) return maxSev==='Serious'?'Review Required (DGA)':'Analyze DGA (Elevated)';
  const types=[...new Set(iss.map(i=>i.type))];
  return `Review Required (${types.join(', ')})`;
}

// Tabs
function showTab(id,el) {
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('panel-'+id).classList.add('active');
  el.classList.add('active');
  if(id==='trend') setTimeout(()=>{ if(!document.getElementById('trend-select').value) return; updateTrendCharts(); },80);
  if(id==='ai') renderAIAnalysis();
}
function showSubTab(id,el) {
  const parent=el.closest('.tab-panel');
  parent.querySelectorAll('.sub-panel').forEach(p=>p.classList.remove('active'));
  parent.querySelectorAll('.sub-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('sub-'+id).classList.add('active');
  el.classList.add('active');
}
function showModalTab(id,el) {
  document.querySelectorAll('.modal-panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.modal-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  el.classList.add('active');
  if(id==='m-trend') setTimeout(renderModalTrend,80);
}
function showModalSubTab(id,el) {
  document.querySelectorAll('.modal-sub-panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.modal-sub-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  el.classList.add('active');
}

// Filters
function populateEquipmentFilter() {
  const sel=document.getElementById('f-equipment');
  while(sel.options.length>1) sel.remove(1);
  RAW_DATA.forEach(d=>{const o=document.createElement('option');o.value=d.equipment_id;o.textContent=`[${d.no}] ${d.equipment_id} (${d.serial_no})`;sel.appendChild(o);});
}
function applyFilters() {
  const eq=document.getElementById('f-equipment').value;
  const cond=document.getElementById('f-condition').value;
  const phys=document.getElementById('f-physical').value;
  const elec=document.getElementById('f-electrical').value;
  const chem=document.getElementById('f-chemical').value;
  currentData=RAW_DATA.filter(d=>{
    if(eq!=='all'&&d.equipment_id!==eq) return false;
    if(cond!=='all'&&getTDCGCondition(d)!==cond) return false;
    // Physical: Color Number, IFT
    const physOver=(d.color_number>2.5)||(d.IFT!=null&&d.IFT<25);
    if(phys==='over'&&!physOver) return false; if(phys==='ok'&&physOver) return false;
    // Electrical: DBV, DF25C, DF100C
    const elecOver=(d.DBV!=null&&d.DBV<30)||(d.DF_25C!=null&&d.DF_25C>0.5)||(d.DF_100C!=null&&d.DF_100C>5.0);
    if(elec==='over'&&!elecOver) return false; if(elec==='ok'&&elecOver) return false;
    // Chemical: Acidity, Moisture, Water
    const chemOver=(d.acidity!=null&&d.acidity>0.20)||(d.moisture_ppm!=null&&d.moisture_ppm>35)||(d.water_in_oil_pct!=null&&d.water_in_oil_pct>20)||(d.water_in_paper_pct!=null&&d.water_in_paper_pct>2);
    if(chem==='over'&&!chemOver) return false; if(chem==='ok'&&chemOver) return false;
    return true;
  });
  updateAllCharts();updateKPIs();updateOverviewTable();
}
function resetFilters() {
  ['f-equipment','f-condition','f-physical','f-electrical','f-chemical'].forEach(id=>document.getElementById(id).value='all');
  currentData=[...RAW_DATA];updateAllCharts();updateKPIs();updateOverviewTable();
}

// KPIs
function updateKPIs() {
  const d=currentData;
  document.getElementById('kpi-total').textContent=d.length;
  document.getElementById('kpi-normal').textContent=d.filter(x=>getTDCGCondition(x)==='Normal').length;
  document.getElementById('kpi-monitor').textContent=d.filter(x=>getTDCGCondition(x)==='Caution').length;
  document.getElementById('kpi-serious').textContent=d.filter(x=>['Warning','Critical'].includes(getTDCGCondition(x))).length;
  document.getElementById('kpi-phys').textContent=d.filter(x=>(x.color_number>2.5)||(x.IFT!=null&&x.IFT<25)||(x.DBV!=null&&x.DBV<30)||(x.DF_25C!=null&&x.DF_25C>0.5)||(x.DF_100C!=null&&x.DF_100C>5.0)).length;
  document.getElementById('kpi-action').textContent=d.filter(x=>getIssues(x).length>0).length;
}

// Overview table
function updateOverviewTable() {
  const tbody=document.getElementById('overview-tbody');tbody.innerHTML='';
  currentData.forEach(d=>{
    const iss=getIssues(d);const fl=iss.length>0;
    const act=getActionText(d);
    const tr=document.createElement('tr');tr.className=fl?'flagged':'';tr.onclick=()=>openModal(d.no);
    tr.innerHTML=`
      <td class="left"><b>${d.no}</b></td>
      <td class="left" style="color:var(--accent);cursor:pointer;"><b>${d.equipment_id}</b></td>
      <td>${d.serial_no}</td><td>${d.rated_power||'-'} kVA</td>
      <td>${d.manufacturer||'-'}</td><td>${d.year||'-'}</td>
      <td>${condBadge(getTDCGCondition(d))}</td>
      <td class="${d.color_number>2.5?'val-over':'val-ok'}">${fmt(d.color_number,1)}</td>
      <td class="${d.IFT!=null&&d.IFT<25?'val-over':'val-ok'}">${fmt(d.IFT,1)}</td>
      <td class="${d.DBV!=null&&d.DBV<30?'val-over':'val-ok'}">${fmt(d.DBV,1)}</td>
      <td class="${d.DF_25C!=null&&d.DF_25C>0.5?'val-over':'val-ok'}">${fmt(d.DF_25C,3)}</td>
      <td class="${d.acidity!=null&&d.acidity>0.20?'val-over':'val-ok'}">${fmt(d.acidity,3)}</td>
      <td class="${d.moisture_ppm!=null&&d.moisture_ppm>35?'val-over':'val-ok'}">${fmt(d.moisture_ppm,1)}</td>
      <td><b style="color:${d.TDCG>720?'var(--red)':d.TDCG>350?'var(--yellow)':'inherit'}">${fmt(d.TDCG,0)}</b></td>
      <td style="color:${d.CO>350?'var(--red)':'inherit'}">${fmt(d.CO,0)}</td>
      <td><small style="color:${act==='Normal Operation'?'var(--green)':act.includes('Analyze')?'var(--yellow)':'var(--red)'}">${act}</small></td>`;
    tbody.appendChild(tr);
  });
}

// Chart destroy helper
function dc(id,map) { if(map[id]){map[id].destroy();delete map[id];} }

// Horizontal bar chart with multiple limit lines
function makeHorizBar(cid,labels,values,limits,unit,isMin) {
  dc(cid,mainCharts);
  const ctx=document.getElementById(cid);if(!ctx) return;
  const bg=values.map(v=>{ if(v==null) return '#e5e7eb80'; const o=isMin?v<limits[0]:v>limits[0]; return o?'#fca5a5a0':'#86efaca0'; });
  const bc=values.map(v=>{ if(v==null) return '#9ca3af'; const o=isMin?v<limits[0]:v>limits[0]; return o?'#dc2626':'#16a34a'; });
  const dirLabel=(isMin?'▲ Higher=Normal':'▼ Lower=Normal')+(unit?' ('+unit+')':'');
  const ds=[{label:dirLabel,data:values,backgroundColor:bg,borderColor:bc,borderWidth:1.5,borderRadius:3}];
  const lc=['#ef4444','#f59e0b','#f97316'];
  limits.forEach((lv,i)=>ds.push({label:`Normal ${isMin?'≥':'≤'} ${lv}${unit||''}`,data:values.map(()=>lv),type:'line',borderColor:lc[i]||'#ef4444',borderWidth:i===0?2:1.5,borderDash:i===0?[6,3]:[4,4],pointRadius:0,fill:false,tension:0}));
  mainCharts[cid]=new Chart(ctx,{type:'bar',data:{labels,datasets:ds},options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',plugins:{legend:{position:'top',labels:{font:{size:10},usePointStyle:true,boxWidth:12}},tooltip:{callbacks:{label:c=>`${c.dataset.label}: ${c.parsed.x}${unit||''}`}}},scales:{x:{beginAtZero:true,ticks:{font:{size:9}}},y:{ticks:{font:{size:10}}}}}});
}

// Update all main charts
function updateAllCharts() {
  const labels=currentData.map(d=>`[${d.no}] ${d.equipment_id}`);
  // Pie
  dc('chart-condition-pie',mainCharts);
  const ctx0=document.getElementById('chart-condition-pie');
  if(ctx0){
    // นับโดยใช้ TDCG limit (IEEE C57.104-2008 primary metric)
    const cOrder=['Normal','Caution','Warning','Critical'];
    const cMap={};currentData.forEach(d=>{const k=getTDCGCondition(d);cMap[k]=(cMap[k]||0)+1;});
    const labels=cOrder.filter(k=>cMap[k]>0);
    const values=labels.map(k=>cMap[k]);
    const colors=labels.map(k=>({Normal:'#16a34a',Caution:'#ca8a04',Warning:'#ea580c',Critical:'#dc2626'})[k]||'#9ca3af');
    mainCharts['chart-condition-pie']=new Chart(ctx0,{type:'doughnut',data:{labels,datasets:[{data:values,backgroundColor:colors,borderWidth:2,borderColor:'#fff'}]},options:{responsive:true,maintainAspectRatio:false,cutout:'55%',plugins:{legend:{position:'right',labels:{font:{size:11},usePointStyle:true}},tooltip:{callbacks:{label:c=>`${c.label}: ${c.parsed} units`}}}}});
  }
  // Physical Test donut
  const makeCategoryDonut=(canvasId,fnGet,orderMap)=>{
    dc(canvasId,mainCharts);
    const ctxD=document.getElementById(canvasId);
    if(!ctxD) return;
    const cMap={};currentData.forEach(d=>{const k=fnGet(d);cMap[k]=(cMap[k]||0)+1;});
    const allKeys=Object.keys(orderMap).filter(k=>cMap[k]>0);
    const vals=allKeys.map(k=>cMap[k]);
    const cols=allKeys.map(k=>orderMap[k]);
    mainCharts[canvasId]=new Chart(ctxD,{type:'doughnut',data:{labels:allKeys,datasets:[{data:vals,backgroundColor:cols,borderWidth:2,borderColor:'#fff'}]},options:{responsive:true,maintainAspectRatio:false,cutout:'55%',plugins:{legend:{position:'right',labels:{font:{size:11},usePointStyle:true}},tooltip:{callbacks:{label:c=>`${c.label}: ${c.parsed} units`}}}}});
  };
  const condPieColors={'Normal':'#16a34a','Over Limit':'#dc2626','N/A':'#d1d5db'};
  makeCategoryDonut('chart-physical-pie',  getPhysicalCondition,  condPieColors);
  makeCategoryDonut('chart-electrical-pie',getElectricalCondition,condPieColors);
  makeCategoryDonut('chart-chemical-pie',  getChemicalCondition,  condPieColors);
  // TDCG big bar
  dc('chart-tdcg-bar',mainCharts);
  const ctx1=document.getElementById('chart-tdcg-bar');
  if(ctx1){
    const tdcgBgMap={Normal:'#86efac80',Caution:'#fde68a80',Warning:'#fdba7480',Critical:'#fca5a580'};
    const bg=currentData.map(d=>tdcgBgMap[getTDCGCondition(d)]||'#e5e7eb');const bc=currentData.map(d=>COND_COLORS[getTDCGCondition(d)]||'#9ca3af');mainCharts['chart-tdcg-bar']=new Chart(ctx1,{type:'bar',data:{labels,datasets:[{label:'TDCG(ppm)',data:currentData.map(d=>d.TDCG),backgroundColor:bg,borderColor:bc,borderWidth:1.5,borderRadius:3},{label:'C1:720',data:currentData.map(()=>720),type:'line',borderColor:'#f59e0b',borderWidth:2,borderDash:[6,3],pointRadius:0,fill:false},{label:'C2:1920',data:currentData.map(()=>1920),type:'line',borderColor:'#ef4444',borderWidth:2,borderDash:[4,4],pointRadius:0,fill:false}]},options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',plugins:{legend:{position:'top',labels:{font:{size:10},usePointStyle:true}}},scales:{x:{beginAtZero:true,ticks:{font:{size:9}}},y:{ticks:{font:{size:9}}}}}});}
  // DGA individual
  const dgaC=[
    {id:'chart-H2',key:'H2',lims:[100,700],unit:' ppm'},
    {id:'chart-CO',key:'CO',lims:[350,570],unit:' ppm'},
    {id:'chart-CO2',key:'CO2',lims:[2500,4000],unit:' ppm'},
    {id:'chart-CH4',key:'CH4',lims:[120,400],unit:' ppm'},
    {id:'chart-C2H4',key:'C2H4',lims:[50,100],unit:' ppm'},
    {id:'chart-C2H2',key:'C2H2',lims:[1,9],unit:' ppm'},
    {id:'chart-C2H6',key:'C2H6',lims:[65,100],unit:' ppm'},
    {id:'chart-TDCG',key:'TDCG',lims:[720,1920],unit:' ppm'},
  ];
  dgaC.forEach(g=>makeHorizBar(g.id,labels,currentData.map(d=>d[g.key]),g.lims,g.unit,false));
  // Stacked
  dc('chart-dga-stack',mainCharts);
  const ctxSt=document.getElementById('chart-dga-stack');
  if(ctxSt){const keys=['H2','CO','CH4','C2H4','C2H2','C2H6'];mainCharts['chart-dga-stack']=new Chart(ctxSt,{type:'bar',data:{labels,datasets:keys.map(k=>({label:k,data:currentData.map(d=>d[k]||0),backgroundColor:GAS_COLORS[k]+'aa',borderColor:GAS_COLORS[k],borderWidth:1}))},options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',plugins:{legend:{position:'top',labels:{font:{size:10},usePointStyle:true,boxWidth:12}}},scales:{x:{stacked:true,beginAtZero:true,ticks:{font:{size:9}}},y:{stacked:true,ticks:{font:{size:9}}}}}});}
  makeHorizBar('chart-color',labels,currentData.map(d=>d.color_number),[2.5],'',false);
  makeHorizBar('chart-ift',labels,currentData.map(d=>d.IFT),[25],' mN/M',true);
  makeHorizBar('chart-dbv',labels,currentData.map(d=>d.DBV),[30],' kV',true);
  makeHorizBar('chart-df25',labels,currentData.map(d=>d.DF_25C),[0.5],'%',false);
  makeHorizBar('chart-acidity',labels,currentData.map(d=>d.acidity),[0.20],' mgKOH/g',false);
  makeHorizBar('chart-moisture',labels,currentData.map(d=>d.moisture_ppm),[35],' ppm',false);
  makeHorizBar('chart-water-oil',labels,currentData.map(d=>d.water_in_oil_pct),[5,20,30],'%',false);
  makeHorizBar('chart-water-paper',labels,currentData.map(d=>d.water_in_paper_pct),[2,4],'%',false);
}

// === TREND LINE CHART BUILDER ===
function makeTrendLine(cid,dates,datasets,limitLines,destroyMap) {
  dc(cid,destroyMap);
  const ctx=document.getElementById(cid);if(!ctx) return;
  const palette=['#4C72B0','#C44E52','#55A868','#DD8452','#8172B3','#da8bc3'];
  const ds=datasets.map((d,i)=>({
    label:d.label,data:d.data,
    borderColor:d.color||palette[i%palette.length],
    backgroundColor:(d.color||palette[i%palette.length])+'30',
    borderWidth:2.5,fill:false,tension:0.3,pointRadius:5,pointHoverRadius:8,spanGaps:true
  }));
  if(limitLines) limitLines.forEach(ll=>ds.push({
    label:ll.label,data:dates.map(()=>ll.value),
    borderColor:ll.color||'#ef4444',borderWidth:2,borderDash:ll.dash||[6,3],
    pointRadius:0,fill:false,tension:0,spanGaps:true
  }));
  destroyMap[cid]=new Chart(ctx,{type:'line',data:{labels:dates,datasets:ds},options:{
    responsive:true,maintainAspectRatio:false,
    plugins:{legend:{position:'top',labels:{font:{size:10},usePointStyle:true,boxWidth:12}},
      tooltip:{callbacks:{label:c=>`${c.dataset.label}: ${c.parsed.y!=null?c.parsed.y:'N/A'}`}}
    },
    scales:{x:{ticks:{font:{size:10}}},y:{beginAtZero:true,ticks:{font:{size:10}}}}}
  });
}

// Build a trend card in a container
function addTrendCard(containerId, cid, title, sub, statusHtml, height) {
  const container=document.getElementById(containerId);
  const card=document.createElement('div');
  card.className='chart-card';
  card.innerHTML=`<h3>${title}</h3><div class="chart-sub">${sub} ${statusHtml}</div><div class="${height||'h260'}"><canvas id="${cid}"></canvas></div>`;
  container.appendChild(card);
}

// Status badge helper
function statusBadge(val, limit, isMin) {
  if(val==null) return '<span style="color:var(--gray);font-size:10px;">N/A</span>';
  const over = isMin ? val<limit : val>limit;
  const dirTag=`<span style="font-size:9px;color:#6b7280;margin-left:3px;">[${isMin?'▲ Higher=Normal':'▼ Lower=Normal'}]</span>`;
  return (over?`<span style="color:var(--red);font-size:10px;">⚠️ เกิน Limit</span>`:`<span style="color:var(--green);font-size:10px;">✓ ปกติ</span>`)+dirTag;
}

// Populate trend select
function populateTrendSelect() {
  const sel=document.getElementById('trend-select');
  RAW_DATA.forEach(d=>{const o=document.createElement('option');o.value=d.no;o.textContent=`[${d.no}] ${d.equipment_id} (${d.serial_no})`;sel.appendChild(o);});
}

function updateTrendCharts() {
  const no=parseInt(document.getElementById('trend-select').value);
  const d=RAW_DATA.find(x=>x.no===no);if(!d) return;
  const gh=d.gas_history_paired||{};

  // Destroy old trend charts
  Object.values(trendCharts).forEach(c=>{try{c.destroy();}catch(e){}});
  Object.keys(trendCharts).forEach(k=>delete trendCharts[k]);

  // Badge
  document.getElementById('trend-badge').innerHTML=`${condBadge(getTDCGCondition(d))} &nbsp; ${d.manufacturer||'-'} ${d.year||''} &nbsp; ${d.rated_power||'-'} kVA`;
  // Info grid
  document.getElementById('trend-info-grid').innerHTML=`
    <div class="info-item"><div class="info-label">Equipment ID</div><div class="info-value">${d.equipment_id}</div></div>
    <div class="info-item"><div class="info-label">Serial No.</div><div class="info-value">${d.serial_no}</div></div>
    <div class="info-item"><div class="info-label">Manufacturer</div><div class="info-value">${d.manufacturer||'-'}</div></div>
    <div class="info-item"><div class="info-label">Year</div><div class="info-value">${d.year||'-'}</div></div>
    <div class="info-item"><div class="info-label">Rated Power</div><div class="info-value">${d.rated_power||'-'} kVA</div></div>
    <div class="info-item"><div class="info-label">DGA Condition (TDCG)</div><div class="info-value">${condBadge(getTDCGCondition(d))}</div></div>
    <div class="info-item"><div class="info-label">Sampling Date</div><div class="info-value">${d.sampling_date}</div></div>
    <div class="info-item"><div class="info-label">Test Points</div><div class="info-value">${(gh.CO||gh.H2||{dates:[]}).dates?.length||1} times</div></div>`;

  // === DGA sub-panel: one chart per gas ===
  const dgaGrid=document.getElementById('trend-dga-grid');dgaGrid.innerHTML='';
  // IEEE C57.104-2008: C1=Normal, C2=Monitor, C3=Action/Plan outage, C4=Critical
  const dgaItems=[
    {key:'H2',  name:'H₂ Hydrogen',       unit:'ppm', lims:[{value:100,label:'C1≤100',color:'#f59e0b',dash:[4,2]},{value:700,label:'C2≤700',color:'#f97316',dash:[6,3]},{value:1800,label:'C3≤1800',color:'#ef4444',dash:[8,4]}]},
    {key:'CO',  name:'CO Carbon Monoxide', unit:'ppm', lims:[{value:350,label:'C1≤350',color:'#f59e0b',dash:[4,2]},{value:570,label:'C2≤570',color:'#f97316',dash:[6,3]},{value:1400,label:'C3≤1400',color:'#ef4444',dash:[8,4]}]},
    {key:'CO2', name:'CO₂ Carbon Dioxide', unit:'ppm', lims:[{value:2500,label:'C1≤2500',color:'#f59e0b',dash:[4,2]},{value:4000,label:'C2≤4000',color:'#f97316',dash:[6,3]},{value:10000,label:'C3≤10000',color:'#ef4444',dash:[8,4]}]},
    {key:'CH4', name:'CH₄ Methane',        unit:'ppm', lims:[{value:120,label:'C1≤120',color:'#f59e0b',dash:[4,2]},{value:400,label:'C2≤400',color:'#f97316',dash:[6,3]},{value:1000,label:'C3≤1000',color:'#ef4444',dash:[8,4]}]},
    {key:'C2H4',name:'C₂H₄ Ethylene',     unit:'ppm', lims:[{value:50,label:'C1≤50',color:'#f59e0b',dash:[4,2]},{value:100,label:'C2≤100',color:'#f97316',dash:[6,3]},{value:200,label:'C3≤200',color:'#ef4444',dash:[8,4]}]},
    {key:'C2H2',name:'C₂H₂ Acetylene ⚠️', unit:'ppm', lims:[{value:1,label:'C1≤1',color:'#f59e0b',dash:[4,2]},{value:9,label:'C2≤9',color:'#f97316',dash:[6,3]},{value:35,label:'C3≤35',color:'#ef4444',dash:[8,4]}]},
    {key:'C2H6',name:'C₂H₆ Ethane',       unit:'ppm', lims:[{value:65,label:'C1≤65',color:'#f59e0b',dash:[4,2]},{value:100,label:'C2≤100',color:'#f97316',dash:[6,3]},{value:150,label:'C3≤150',color:'#ef4444',dash:[8,4]}]},
    {key:'TDCG',name:'TDCG Total',         unit:'ppm', lims:[{value:720,label:'C1≤720',color:'#f59e0b',dash:[4,2]},{value:1920,label:'C2≤1920',color:'#f97316',dash:[6,3]},{value:4630,label:'C3≤4630',color:'#ef4444',dash:[8,4]}]},
    {key:'C3H6',name:'C₃H₆ Propylene',    unit:'ppm', lims:[]},
    {key:'C3H8',name:'C₃H₈ Propane',      unit:'ppm', lims:[]},
  ];
  dgaItems.forEach((g,idx)=>{
    const pair=gh[g.key]||{};
    const dates=pair.dates||['27-Mar-25'];
    const vals=pair.values||[d[g.key]];
    const hasHist=dates.length>1;
    const cid=`td-${g.key}-${no}`;
    const curVal=vals[vals.length-1];
    const limC1=g.lims[0]?.value;
    const limSt=limC1!=null?statusBadge(curVal,limC1,false):'';
    const sub=g.lims.length>0?`${g.lims.map(l=>l.label).join(' | ')} ${g.unit}`:`Reference only`;
    addTrendCard('trend-dga-grid',cid,g.name,sub,limSt,'h260');
    setTimeout(()=>makeTrendLine(cid,dates,[{label:`${g.key} (${g.unit})`,data:vals,color:GAS_COLORS[g.key]||'#4C72B0'}],g.lims,trendCharts),20+idx*15);
  });

  // === PHYSICAL sub-panel ===
  const physGrid=document.getElementById('trend-phys-grid');physGrid.innerHTML='';
  const physItems=[
    {key:'color_number',name:'Color Number (ASTM D1500)',sub:'Normal < 2.5 | ▼ Lower=Normal',val:d.color_number,lims:[{value:2.5,label:'Normal ≤ 2.5',color:'#ef4444'}],isMin:false,unit:''},
    {key:'IFT',name:'IFT Interfacial Tension (ASTM D971)',sub:'Normal > 25 mN/M | ▲ Higher=Normal',val:d.IFT,lims:[{value:25,label:'Normal ≥ 25 mN/M',color:'#ef4444'}],isMin:true,unit:'mN/M'},
  ];
  physItems.forEach((p,idx)=>{
    const cid=`tp-${p.key}-${no}`;
    const st=statusBadge(p.val,p.lims[0].value,p.isMin);
    addTrendCard('trend-phys-grid',cid,p.name,p.sub,st,'h260');
    const physH=d.phys_history||{};const physKey=p.key==='color_number'?'color':p.key;const physPair=(physH[physKey])||{dates:[d.sampling_date?.split(',')[0]||'27-Mar-25'],values:[p.val]};
    const pDates=physPair.dates||['27-Mar-25'];const pVals=physPair.values||[p.val];
    setTimeout(()=>makeTrendLine(cid,pDates,[{label:`${p.key}${p.unit?' ('+p.unit+')':''}`,data:pVals,color:'#d97706'}],p.lims,trendCharts),20+idx*15);
  });

  // === ELECTRICAL sub-panel ===
  const elecGrid=document.getElementById('trend-elec-grid');elecGrid.innerHTML='';
  const elecItems=[
    {key:'DBV',name:'DBV Breakdown Voltage (ASTM D877 / IEC60156)',sub:'Normal > 30 kV | ▲ Higher=Normal',val:d.DBV,lims:[{value:30,label:'Normal ≥ 30 kV',color:'#ef4444'}],isMin:true,unit:'kV'},
    {key:'DF_25C',name:'Dissipation Factor 25°C (ASTM D924)',sub:'Normal < 0.5% | ▼ Lower=Normal',val:d.DF_25C,lims:[{value:0.5,label:'Normal ≤ 0.5%',color:'#ef4444'}],isMin:false,unit:'%'},
    {key:'DF_100C',name:'Dissipation Factor 100°C (ASTM D924)',sub:'Normal < 5.0% | ▼ Lower=Normal',val:d.DF_100C,lims:[{value:5.0,label:'Normal ≤ 5.0%',color:'#ef4444'}],isMin:false,unit:'%'},
  ];
  elecItems.forEach((e,idx)=>{
    const cid=`te-${e.key}-${no}`;
    const st=e.val!=null?statusBadge(e.val,e.lims[0].value,e.isMin):'<span style="color:var(--gray);font-size:10px;">ไม่ได้ทดสอบ</span>';
    addTrendCard('trend-elec-grid',cid,e.name,e.sub,st,'h260');
    const elecH=d.elec_history||{};const elecKey=e.key==='DBV'?'DBV':(e.key==='DF_25C'?'DF25':null);const elecPair=elecKey?(elecH[elecKey])||{}:{};
    const eDates=elecPair.dates||['27-Mar-25'];const eVals=elecPair.values||[e.val];const eDatesFinal=elecKey?eDates:['27-Mar-25'];const eValsFinal=elecKey?eVals:[e.val];
    setTimeout(()=>makeTrendLine(cid,eDatesFinal,[{label:`${e.key}${e.unit?' ('+e.unit+')':''}`,data:eValsFinal,color:'#7c3aed'}],e.lims,trendCharts),20+idx*15);
  });

  // === CHEMICAL sub-panel ===
  const chemGrid=document.getElementById('trend-chem-grid');chemGrid.innerHTML='';
  const chemHistKeyMap={acidity:'acidity',moisture_ppm:'moisture',water_in_oil_pct:'water_in_oil',water_in_paper_pct:'water_in_paper'};
  const chemItems=[
    {key:'acidity',name:'Acid Number (ASTM D664)',sub:'Normal < 0.20 mgKOH/g | ▼ Lower=Normal',val:d.acidity,lims:[{value:0.20,label:'Normal ≤ 0.20',color:'#ef4444'}],isMin:false,unit:'mgKOH/g',color:'#b45309'},
    {key:'moisture_ppm',name:'Moisture Content (ASTM D1533)',sub:'Normal < 35 ppm | ▼ Lower=Normal',val:d.moisture_ppm,lims:[{value:35,label:'Normal ≤ 35ppm',color:'#ef4444'}],isMin:false,unit:'ppm',color:'#0f766e'},
    {key:'water_in_oil_pct',name:'Water in Oil (% Saturation)',sub:'Dry<5% | Moderate 6-20% | Wet 21-30% | Extreme >30%',val:d.water_in_oil_pct,lims:[{value:5,label:'Dry 5%',color:'#22c55e'},{value:20,label:'Mod 20%',color:'#f59e0b'},{value:30,label:'Wet 30%',color:'#ef4444'}],isMin:false,unit:'%',color:'#0369a1'},
    {key:'water_in_paper_pct',name:'Water in Paper (% Moisture)',sub:'Dry<2% | Wet 2-4% | Extremely Wet >4%',val:d.water_in_paper_pct,lims:[{value:2,label:'Dry 2%',color:'#f59e0b'},{value:4,label:'Wet 4%',color:'#ef4444'}],isMin:false,unit:'%',color:'#7c3aed'},
  ];
  chemItems.forEach((c,idx)=>{
    const cid=`tc-${c.key}-${no}`;
    const st=statusBadge(c.val,c.lims[0].value,c.isMin);
    addTrendCard('trend-chem-grid',cid,c.name,c.sub,st,'h260');
    const chemH=d.chem_history||{};const chemHistKey=chemHistKeyMap[c.key]||c.key;const chemPair=(chemH[chemHistKey])||{dates:['27-Mar-25'],values:[c.val]};
    const cDates=chemPair.dates||['27-Mar-25'];const cVals=chemPair.values||[c.val];
    setTimeout(()=>makeTrendLine(cid,cDates,[{label:`${c.key} (${c.unit})`,data:cVals,color:c.color}],c.lims,trendCharts),20+idx*15);
  });
}

// === MODAL ===
function openModal(no) {
  const d=RAW_DATA.find(x=>x.no===no);if(!d) return;
  currentModalNo=no;
  // Reset modal tabs
  document.querySelectorAll('.modal-tab').forEach((t,i)=>t.classList.toggle('active',i===0));
  document.querySelectorAll('.modal-panel').forEach((p,i)=>p.classList.toggle('active',i===0));
  document.querySelectorAll('.modal-sub-tab').forEach((t,i)=>t.classList.toggle('active',i===0));
  document.querySelectorAll('.modal-sub-panel').forEach((p,i)=>p.classList.toggle('active',i===0));
  document.getElementById('modal-title').innerHTML=`[${d.no}] ${d.equipment_id} &nbsp;|&nbsp; S/N: ${d.serial_no} &nbsp;|&nbsp; ${d.rated_power||'-'} kVA`;
  document.getElementById('modal-info-grid').innerHTML=`
    <div class="info-item"><div class="info-label">Equipment ID</div><div class="info-value">${d.equipment_id}</div></div>
    <div class="info-item"><div class="info-label">Serial No.</div><div class="info-value">${d.serial_no}</div></div>
    <div class="info-item"><div class="info-label">Manufacturer</div><div class="info-value">${d.manufacturer||'-'}</div></div>
    <div class="info-item"><div class="info-label">Year</div><div class="info-value">${d.year||'-'}</div></div>
    <div class="info-item"><div class="info-label">Rated Power</div><div class="info-value">${d.rated_power||'-'} kVA</div></div>
    <div class="info-item"><div class="info-label">HV / LV</div><div class="info-value">${d.hv||'-'} / ${d.lv||'-'} V</div></div>
    <div class="info-item"><div class="info-label">DGA Condition (TDCG)</div><div class="info-value">${condBadge(getTDCGCondition(d))}</div></div>
    <div class="info-item"><div class="info-label">Sampling</div><div class="info-value">${d.sampling_date}</div></div>`;
  renderModalDGA(d);renderModalPhys(d);renderModalElec(d);renderModalChem(d);renderModalAI(d);
  document.getElementById('detail-modal').classList.add('open');
  document.body.style.overflow='hidden';
  document.querySelectorAll('#overview-tbody tr').forEach(r=>r.classList.remove('selected'));
  document.querySelectorAll('#overview-tbody tr').forEach(r=>{if(r.cells[0]?.textContent==String(no)) r.classList.add('selected');});
}
function closeModal() {
  document.getElementById('detail-modal').classList.remove('open');document.body.style.overflow='';
  Object.values(modalCharts).forEach(c=>{try{c.destroy();}catch(e){}});
  Object.keys(modalCharts).forEach(k=>delete modalCharts[k]);
  document.querySelectorAll('#overview-tbody tr').forEach(r=>r.classList.remove('selected'));
}
function closeModalOnOverlay(e) { if(e.target===document.getElementById('detail-modal')) closeModal(); }

function ri(label,val,unit,limit,isMin,std) {
  const disp=fmt(val,val!=null&&Math.abs(val)<1?3:val!=null&&Math.abs(val)<100?1:0);
  let cls='result-item',st='',lt='';
  if(val!=null){const o=isMin?val<limit:val>limit;cls+=' '+(o?'over':'ok');st=o?`⚠️ ${isMin?'ต่ำกว่า':'เกิน'} Limit`:'✓ ปกติ';lt=`${isMin?'Limit >':'Limit <'} ${limit}${unit} (${std})`;}
  return `<div class="${cls}"><div class="r-label">${label}</div><div class="r-value">${disp}${val!=null?unit:' N/A'}</div><div class="r-limit">${lt}<br>${st}</div></div>`;
}

function renderModalDGA(d) {
  // IEEE C57.104-2008: c1=C1 limit, c2=C2 limit, c3=C3 limit, c4>c3=Condition 4
  const gases=[
    {k:'H2', n:'H₂ Hydrogen',        c1:100,c2:700, c3:1800},
    {k:'CO', n:'CO Carbon Monoxide',  c1:350,c2:570, c3:1400},
    {k:'CO2',n:'CO₂ Carbon Dioxide',  c1:2500,c2:4000,c3:10000},
    {k:'CH4',n:'CH₄ Methane',         c1:120,c2:400, c3:1000},
    {k:'C2H4',n:'C₂H₄ Ethylene',      c1:50, c2:100, c3:200},
    {k:'C2H2',n:'C₂H₂ Acetylene',     c1:1,  c2:9,   c3:35},
    {k:'C2H6',n:'C₂H₆ Ethane',        c1:65, c2:100, c3:150},
    {k:'C3H6',n:'C₃H₆ Propylene',     c1:null},
    {k:'C3H8',n:'C₃H₈ Propane',       c1:null},
    {k:'TDCG',n:'TDCG Total',          c1:720,c2:1920,c3:4630},
    {k:'O2', n:'O₂ Oxygen',           c1:null},
    {k:'N2', n:'N₂ Nitrogen',         c1:null}
  ];
  const condColors={'C1':'#16a34a','C2':'#d97706','C3':'#ea580c','C4':'#dc2626'};
  let html=`<div style="margin-bottom:10px;">${condBadge(getTDCGCondition(d))} &nbsp;<small style="color:var(--text2);">TDCG:${fmt(d.TDCG,0)} | CO:${fmt(d.CO,0)} | CO₂:${fmt(d.CO2,0)} ppm</small></div>`;
  html+=`<div style="font-size:10px;color:var(--text2);margin-bottom:8px;">อ้างอิง: IEEE C57.104-2008 — C1=Normal (≤720), C2=Caution (721–1920), C3=Warning (1921–4630), C4=Critical (>4630) ppm</div>`;
  html+=`<div class="result-grid">`;
  gases.forEach(g=>{
    const v=d[g.k];
    let cls='result-item',cond='',condCol='';
    if(v!=null&&g.c1!=null){
      if(v>g.c3) {cond='C4';cls+=' over';}
      else if(v>g.c2) {cond='C3';cls+=' over';}
      else if(v>g.c1) {cond='C2';cls+=' over';}
      else cond='C1';
      condCol=condColors[cond]||'#16a34a';
      cls+=' '+(cond==='C1'?'ok':'over');
    }
    const lim=g.c1!=null?`C1≤${g.c1} | C2≤${g.c2||'-'} | C3≤${g.c3||'-'} ppm`:'—';
    html+=`<div class="${cls}">
      <div class="r-label">${g.n}</div>
      <div class="r-value">${fmt(v,0)} <small>ppm</small></div>
      <div class="r-limit">${lim}${cond?` <b style="color:${condCol}"> ${cond}</b>`:''}</div>
    </div>`;
  });
  document.getElementById('modal-dga-content').innerHTML=html+'</div>';
}
function renderModalPhys(d) {
  document.getElementById('modal-phys-content').innerHTML=`<div class="result-grid">
    ${ri('Color Number',d.color_number,'',2.5,false,'ASTM D1500')}
    ${ri('IFT (ASTM D971)',d.IFT,' mN/M',25,true,'IEEE C57-106')}</div>`;
}
function renderModalElec(d) {
  document.getElementById('modal-elec-content').innerHTML=`<div class="result-grid">
    ${ri('DBV (ASTM D877/IEC60156)',d.DBV,' kV',30,true,'IEEE C57-106')}
    ${ri('DF at 25°C (ASTM D924)',d.DF_25C,'%',0.5,false,'ASTM D924')}
    ${ri('DF at 100°C (ASTM D924)',d.DF_100C,'%',5.0,false,'ASTM D924')}</div>`;
}
function renderModalChem(d) {
  const woWet=d.water_in_oil_pct>30?'Extremely Wet':d.water_in_oil_pct>20?'Wet':d.water_in_oil_pct>5?'Moderate Wet':'Dry';
  const wpWet=d.water_in_paper_pct>4?'Extremely Wet':d.water_in_paper_pct>2?'Wet Paper':'Dry Paper';
  document.getElementById('modal-chem-content').innerHTML=`<div class="result-grid">
    ${ri('Acid Number (ASTM D664)',d.acidity,' mgKOH/g',0.20,false,'ASTM D664')}
    ${ri('Moisture (ASTM D1533)',d.moisture_ppm,' ppm',35,false,'ASTM D1533')}
    ${d.water_in_oil_pct!=null?ri('Water in Oil % Saturation (IEEE 62-1995)',d.water_in_oil_pct,'%',30,false,'IEEE 62-1995'):''}
    ${d.water_in_paper_pct!=null?ri('Water in Paper % Moisture (IEEE 62-1995)',d.water_in_paper_pct,'%',4,false,'IEEE 62-1995'):''}</div>
    ${d.water_in_oil_pct!=null?`<div style="margin-top:6px;padding:6px 12px;background:#eff6ff;border-radius:6px;font-size:12px;">💧 Water in Oil: <b>${fmt(d.water_in_oil_pct,1)}%</b> → <b>${woWet}</b> | Paper: <b>${fmt(d.water_in_paper_pct,2)}%</b> → <b>${wpWet}</b></div>`:''}
    <div style="margin-top:6px;padding:8px 12px;background:#f0fdf4;border-radius:6px;font-size:12px;">
    📋 ${d.recommendation_summary||'Continue normal operation and oil testing according to normal process'}</div>`;
}

function renderModalAI(d) {
  const iss=getIssues(d);
  if(!iss.length){document.getElementById('modal-ai-content').innerHTML='<div style="text-align:center;padding:24px;color:var(--green);"><h3>✅ ค่าการทดสอบทุกรายการอยู่ในเกณฑ์ปกติ</h3></div>';return;}
  const nonDGA=iss.filter(i=>i.type!=='DGA');
  const hasDGA=iss.some(i=>i.type==='DGA');
  const sev=iss.find(i=>i.sev==='Extreme')?'extreme':iss.find(i=>i.sev==='Serious')?'serious':'moderate';
  document.getElementById('modal-ai-content').innerHTML=`<div class="ai-issue ${sev}">
    <div style="margin-bottom:8px;">${iss.map(i=>`<div class="ai-finding">⚠️ <b>${i.type}:</b> ${i.val}</div>`).join('')}</div>
    <div class="ai-rec">
      ${hasDGA?`<div>${getRec(d,'DGA')}</div>`:''}
      ${nonDGA.length?`<hr style="border:none;border-top:1px dashed #cbd5e1;margin:8px 0;">${nonDGA.map(i=>`<div style="margin-bottom:8px;">${getRec(d,i.type)}</div>`).join('<hr style="border:none;border-top:1px dashed #cbd5e1;margin:6px 0;">')}`:''}
    </div></div>`;
}

// Modal Trend - per gas, per parameter
function renderModalTrend() {
  const d=RAW_DATA.find(x=>x.no===currentModalNo);if(!d) return;
  const gh=d.gas_history_paired||{};
  Object.values(modalCharts).forEach(c=>{try{c.destroy();}catch(e){}});
  Object.keys(modalCharts).forEach(k=>delete modalCharts[k]);

  // DGA
  const dgaG=document.getElementById('modal-trend-dga');dgaG.innerHTML='';
  // IEEE C57.104-2008 limits C1/C2/C3
  const dgaGases=[
    {key:'H2', lims:[{value:100,label:'C1≤100',color:'#f59e0b',dash:[4,2]},{value:700,label:'C2≤700',color:'#f97316',dash:[6,3]},{value:1800,label:'C3≤1800',color:'#ef4444',dash:[8,4]}]},
    {key:'CO', lims:[{value:350,label:'C1≤350',color:'#f59e0b',dash:[4,2]},{value:570,label:'C2≤570',color:'#f97316',dash:[6,3]},{value:1400,label:'C3≤1400',color:'#ef4444',dash:[8,4]}]},
    {key:'CO2',lims:[{value:2500,label:'C1≤2500',color:'#f59e0b',dash:[4,2]},{value:4000,label:'C2≤4000',color:'#f97316',dash:[6,3]},{value:10000,label:'C3≤10k',color:'#ef4444',dash:[8,4]}]},
    {key:'CH4',lims:[{value:120,label:'C1≤120',color:'#f59e0b',dash:[4,2]},{value:400,label:'C2≤400',color:'#f97316',dash:[6,3]},{value:1000,label:'C3≤1000',color:'#ef4444',dash:[8,4]}]},
    {key:'C2H4',lims:[{value:50,label:'C1≤50',color:'#f59e0b',dash:[4,2]},{value:100,label:'C2≤100',color:'#f97316',dash:[6,3]},{value:200,label:'C3≤200',color:'#ef4444',dash:[8,4]}]},
    {key:'C2H2',lims:[{value:1,label:'C1≤1',color:'#f59e0b',dash:[4,2]},{value:9,label:'C2≤9',color:'#f97316',dash:[6,3]},{value:35,label:'C3≤35',color:'#ef4444',dash:[8,4]}]},
    {key:'C2H6',lims:[{value:65,label:'C1≤65',color:'#f59e0b',dash:[4,2]},{value:100,label:'C2≤100',color:'#f97316',dash:[6,3]},{value:150,label:'C3≤150',color:'#ef4444',dash:[8,4]}]},
    {key:'TDCG',lims:[{value:720,label:'C1≤720',color:'#f59e0b',dash:[4,2]},{value:1920,label:'C2≤1920',color:'#f97316',dash:[6,3]},{value:4630,label:'C3≤4630',color:'#ef4444',dash:[8,4]}]},
  ];
  dgaGases.forEach((g,idx)=>{
    const pair=gh[g.key]||{};const dates=pair.dates||['27-Mar-25'];const vals=pair.values||[d[g.key]];
    const cid=`mtd-${g.key}-${d.no}`;
    const card=document.createElement('div');card.className='modal-chart-card';
    card.innerHTML=`<h4>${g.key}</h4><div class="csub">Trend (${dates.length} data points)</div><div style="height:160px;position:relative;"><canvas id="${cid}"></canvas></div>`;
    dgaG.appendChild(card);
    setTimeout(()=>makeTrendLine(cid,dates,[{label:`${g.key}(ppm)`,data:vals,color:GAS_COLORS[g.key]||'#4C72B0'}],g.lims,modalCharts),20+idx*15);
  });

  // Physical
  const physG=document.getElementById('modal-trend-phys');physG.innerHTML='';
  [{key:'color_number',name:'Color Number',lims:[{value:2.5,label:'Limit 2.5',color:'#ef4444'}],val:d.color_number,color:'#d97706'},
   {key:'IFT',name:'IFT (mN/M)',lims:[{value:25,label:'Limit 25',color:'#ef4444'}],val:d.IFT,color:'#0369a1'}
  ].forEach((p,idx)=>{
    const cid=`mtp-${p.key}-${d.no}`;
    const card=document.createElement('div');card.className='modal-chart-card';
    card.innerHTML=`<h4>${p.name}</h4><div class="csub">Current: ${fmt(p.val,2)}</div><div style="height:160px;position:relative;"><canvas id="${cid}"></canvas></div>`;
    physG.appendChild(card);
    const mphH=d.phys_history||{};const mphKey=p.key==='color_number'?'color':p.key;const mphPair=(mphH[mphKey])||{};
    const mpDates=mphPair.dates||['27-Mar-25'];const mpVals=mphPair.values||[p.val];
    const mpSub=`${mpDates.length} data points | Current: ${fmt(p.val,2)}`;
    card.querySelector('.csub').textContent=mpSub;
    setTimeout(()=>makeTrendLine(cid,mpDates,[{label:p.key,data:mpVals,color:p.color}],p.lims,modalCharts),20+idx*15);
  });

  // Electrical
  const elecG=document.getElementById('modal-trend-elec');elecG.innerHTML='';
  [{key:'DBV',name:'DBV (kV)',lims:[{value:30,label:'Limit 30kV',color:'#ef4444'}],val:d.DBV,color:'#7c3aed'},
   {key:'DF_25C',name:'DF 25°C (%)',lims:[{value:0.5,label:'Limit 0.5%',color:'#ef4444'}],val:d.DF_25C,color:'#0891b2'},
   {key:'DF_100C',name:'DF 100°C (%)',lims:[{value:5.0,label:'Limit 5%',color:'#ef4444'}],val:d.DF_100C,color:'#059669'}
  ].forEach((e,idx)=>{
    const cid=`mte-${e.key}-${d.no}`;
    const card=document.createElement('div');card.className='modal-chart-card';
    card.innerHTML=`<h4>${e.name}</h4><div class="csub">Current: ${fmt(e.val,3)}</div><div style="height:160px;position:relative;"><canvas id="${cid}"></canvas></div>`;
    elecG.appendChild(card);
    const meH=d.elec_history||{};const meKey=e.key==='DBV'?'DBV':(e.key==='DF_25C'?'DF25':null);const mePair=meKey?(meH[meKey])||{}:{};
    const meDates=meKey?mePair.dates||['27-Mar-25']:['27-Mar-25'];const meVals=meKey?mePair.values||[e.val]:[e.val];
    const meSub=`${meDates.length} data points | Current: ${fmt(e.val,3)}`;
    card.querySelector('.csub').textContent=meSub;
    setTimeout(()=>makeTrendLine(cid,meDates,[{label:e.key,data:meVals,color:e.color}],e.lims,modalCharts),20+idx*15);
  });

  // Chemical
  const chemG=document.getElementById('modal-trend-chem');chemG.innerHTML='';
  const mChemHistKeyMap={acidity:'acidity',moisture_ppm:'moisture',water_in_oil_pct:'water_in_oil',water_in_paper_pct:'water_in_paper'};
  [{key:'acidity',name:'Acid Number (mgKOH/g) ▼ Lower=Normal',lims:[{value:0.20,label:'Normal ≤ 0.20',color:'#ef4444'}],val:d.acidity,color:'#b45309'},
   {key:'moisture_ppm',name:'Moisture (ppm) ▼ Lower=Normal',lims:[{value:35,label:'Normal ≤ 35ppm',color:'#ef4444'}],val:d.moisture_ppm,color:'#0f766e'},
   {key:'water_in_oil_pct',name:'Water in Oil (%Sat) ▼ Lower=Normal',lims:[{value:5,label:'Dry 5%',color:'#22c55e'},{value:20,label:'Mod 20%',color:'#f59e0b'},{value:30,label:'Wet 30%',color:'#ef4444'}],val:d.water_in_oil_pct,color:'#0369a1'},
   {key:'water_in_paper_pct',name:'Water in Paper (%) ▼ Lower=Normal',lims:[{value:2,label:'Dry 2%',color:'#f59e0b'},{value:4,label:'Wet 4%',color:'#ef4444'}],val:d.water_in_paper_pct,color:'#7c3aed'}
  ].forEach((c,idx)=>{
    const cid=`mtc-${c.key}-${d.no}`;
    const card=document.createElement('div');card.className='modal-chart-card';
    card.innerHTML=`<h4>${c.name}</h4><div class="csub">Current: ${fmt(c.val,3)}</div><div style="height:160px;position:relative;"><canvas id="${cid}"></canvas></div>`;
    chemG.appendChild(card);
    const mcH=d.chem_history||{};const mcHistKey=mChemHistKeyMap[c.key]||c.key;const mcPair=(mcH[mcHistKey])||{};
    const mcDates=mcPair.dates||['27-Mar-25'];const mcVals=mcPair.values||[c.val];
    const mcSub=`${mcDates.length} data points | Current: ${fmt(c.val,3)}`;
    card.querySelector('.csub').textContent=mcSub;
    setTimeout(()=>makeTrendLine(cid,mcDates,[{label:c.key,data:mcVals,color:c.color}],c.lims,modalCharts),20+idx*15);
  });
}

// ══════════════════════════════════════════════════════
//  IEC 60599:2007 + IEEE C57.104 AI ANALYSIS ENGINE
// ══════════════════════════════════════════════════════

const IEC_GAS = {
  H2:  {L1:100, L2:200, name:'H₂ Hydrogen', unit:'ppm',
    cause:'Partial Discharge (PD) / Corona discharge ใน oil, Electrolytic decomposition, Low-energy sparking',
    detail:'H₂ เป็น key gas หลักของ Partial Discharge — ถ้าสูงโดยไม่มี C₂H₂ มักเป็น Corona ใน oil หรือ Bushing ถ้ามี C₂H₄ ร่วมด้วยอาจเป็น Thermal+PD',
    inspect:[
      'ตรวจสอบ Bushing (Tan Delta & Capacitance test)',
      'วัด Partial Discharge (PD measurement) ที่ terminal',
      'ตรวจ Oil level, ปรับปรุง Oil headspace nitrogen',
      'ตรวจ Surge Arrester, Lightning protection, Grounding system',
      'ตรวจสอบ Insulation resistance (Megger test)'
    ],
    action:[
      'DGA ซ้ำภายใน 1–3 เดือน เพื่อดู trend',
      'ทำ PD measurement แบบ online ถ้าเป็นไปได้',
      'ถ้า H₂ trend เพิ่มต่อเนื่อง → ลด load และ วางแผน internal inspection'
    ]},
  CH4: {L1:120, L2:240, name:'CH₄ Methane', unit:'ppm',
    cause:'Thermal fault อุณหภูมิต่ำ (<300°C) ใน oil หรือ winding, Hot spot ระดับต่ำ, Core overheating',
    detail:'CH₄ dominant บ่งชี้ T1 fault (Thermal <300°C) ตาม Duval Triangle — มักเกิดจาก Stray loss heating หรือ core bolt ไม่ได้ insulate',
    inspect:[
      'ตรวจ Core grounding (Short-circuit core test)',
      'วัด Circulating current ใน core laminations',
      'ตรวจ Cooling system: fan, pump, oil flow',
      'ทำ Thermal imaging (IR camera) ขณะ on-load',
      'ตรวจ Load history, overloading'
    ],
    action:[
      'DGA ติดตาม trend ทุก 3 เดือน',
      'ทำ Thermal imaging ขณะ load > 70%',
      'ตรวจ Winding resistance (cold–hot comparison)',
      'ถ้า CH₄ > 240 ppm → วางแผน shutdown inspection'
    ]},
  C2H2:{L1:1, L2:6, name:'C₂H₂ Acetylene', unit:'ppm',
    cause:'⚠️ Arcing discharge / Flashover ระหว่าง conductors, OLTC contact burning, Insulation breakdown, High-energy spark',
    detail:'C₂H₂ คือ critical gas ที่สำคัญที่สุด — แม้เพียง 1 ppm ต้องเฝ้าระวัง ถ้า C₂H₂/C₂H₄ > 1 = D1 (Low-energy arc); ถ้า < 1 แต่ C₂H₄ สูง = D2 (High-energy arc)',
    inspect:[
      'ตรวจ OLTC (On-Load Tap Changer): contacts, oil, carbon deposits',
      'ตรวจ Winding insulation resistance (Hi-pot / Insulation test)',
      'ทำ SFRA (Sweep Frequency Response Analysis) ตรวจ winding deformation',
      'ตรวจ Turn-to-turn insulation (Low Voltage Impulse Test)',
      'ตรวจ Core insulation, Clamping bolts'
    ],
    action:[
      '🚨 C₂H₂ > 1 ppm: DGA ซ้ำภายใน 2–4 สัปดาห์',
      '🚨 C₂H₂ > 6 ppm: ลด load ทันที, วางแผน shutdown',
      'ทำ SFRA, Insulation resistance test, OLTC inspection',
      'ถ้า C₂H₂ เพิ่มขึ้นเร็ว → Emergency outage'
    ]},
  C2H4:{L1:50, L2:100, name:'C₂H₄ Ethylene', unit:'ppm',
    cause:'High-temperature thermal fault (>700°C), Hot spot รุนแรงใน winding หรือ core, Severe overloading',
    detail:'C₂H₄ dominant = T3 fault (Thermal >700°C) — มักเกิดจาก Winding conductor hot spot หรือ Overloading ต่อเนื่อง ถ้า C₂H₄/C₂H₆ > 3 ยืนยัน high-temp thermal',
    inspect:[
      'ตรวจ Winding hot spot temperature (Fiber optic sensor ถ้ามี)',
      'ตรวจ Cooling system: fan, ONAN/ONAF operation',
      'ตรวจสอบ Load profile ย้อนหลัง — overloading?',
      'ตรวจ Oil flow channel ใน winding — blocked?',
      'ทำ Thermal imaging ขณะ on-load'
    ],
    action:[
      'ลด load ทันทีถ้า C₂H₄ > 100 ppm',
      'DGA ติดตามทุก 1 เดือน',
      'ตรวจ Cooling system โดยละเอียด',
      'ถ้า C₂H₄ + C₂H₂ เพิ่มพร้อมกัน → Thermal+Arcing fault → shutdown'
    ]},
  C2H6:{L1:65, L2:130, name:'C₂H₆ Ethane', unit:'ppm',
    cause:'Low-to-medium thermal fault (<300°C), Oil overheating เล็กน้อย, Stray flux heating, Core bolt heating',
    detail:'C₂H₆ dominant = T1 fault เล็กน้อย — ถ้า C₂H₆/C₂H₄ > 1 ยืนยัน low-temp thermal (<300°C) มักเกิดจาก Stray loss ใน core หรือ Circulating current',
    inspect:[
      'ตรวจ Core clamping bolts insulation',
      'ตรวจ Magnetic shunts (ถ้ามี)',
      'ตรวจ Stray flux path ผ่าน tank wall',
      'วัด Circulating current ใน core',
      'ตรวจ Oil circulation pump, thermosiphon'
    ],
    action:[
      'DGA ติดตาม trend ทุก 3–6 เดือน',
      'ทำ Thermal imaging บริเวณ tank และ core',
      'ตรวจ Core insulation resistance',
      'ถ้า C₂H₆ > 130 ppm → ทำ Core inspection'
    ]},
  CO:  {L1:350, L2:700, name:'CO Carbon Monoxide', unit:'ppm',
    cause:'Cellulose insulation (กระดาษ/pressboard) เสื่อมสภาพ — Thermal degradation ของ paper wrapping รอบ winding',
    detail:'CO เป็น key gas บ่งชี้ paper aging — ต้องดู CO₂/CO ratio: >11 = normal aging (ไม่วิกฤต), 3–11 = เฝ้าระวัง, <3 = active thermal fault ใน paper insulation',
    inspect:[
      'คำนวณ CO₂/CO ratio (ดูด้านล่าง)',
      'ทำ Furan analysis (2-FAL, 5-HMF, 2-ACF, 5-MEF, 2-FOL) ในน้ำมัน',
      'ทำ Degree of Polymerization (DP) test ถ้าทำได้',
      'ตรวจ Oil temperature history — hot spot ใน paper?',
      'ตรวจ Cooling system adequacy'
    ],
    action:[
      'CO > 350 ppm: ทำ Furan analysis เพื่อประเมินอายุ paper',
      'CO > 700 ppm + CO₂/CO < 3: เสี่ยง active fault → DGA ทุก 1 เดือน',
      'CO > 1400 ppm (IEEE C3): วางแผน shutdown ตรวจสอบฉนวน',
      'ติดตาม CO₂/CO ratio และ trend ร่วมกัน'
    ]},
  CO2: {L1:2500, L2:5000, name:'CO₂ Carbon Dioxide', unit:'ppm',
    cause:'Cellulose aging / thermal degradation ของ paper insulation — normal aging หรือ overheating ของ paper/pressboard',
    detail:'CO₂ สูงอย่างเดียวโดยมี CO₂/CO > 11 อาจเป็นแค่ normal aging ของ paper — แต่ถ้า CO สูงด้วยและ ratio ต่ำ = active fault ใน cellulose',
    inspect:[
      'ดู CO₂/CO ratio (ดูด้านล่าง) ก่อนสรุป',
      'ทำ Furan analysis (วัดอายุ paper จาก 2-FAL content)',
      'ตรวจ Top oil temperature, Winding hot spot',
      'ตรวจ Breathing system (silica gel breather, conservator)',
      'ตรวจ Moisture ใน oil (สัมพันธ์กับ paper aging)'
    ],
    action:[
      'CO₂ > 2500 + CO > 350: ทำ Furan analysis ทันที',
      'CO₂ > 5000 + DP < 200: พิจารณาเปลี่ยน/ซ่อม transformer',
      'ถ้า CO₂/CO > 11: ติดตาม trend ปีละ 1 ครั้ง',
      'ถ้า CO₂/CO < 3: เพิ่มความถี่ DGA เป็นทุก 1–3 เดือน'
    ]},
  TDCG:{L1:720, L2:1920, name:'TDCG (Total Dissolved Combustible Gas)', unit:'ppm',
    cause:'รวม combustible gases เกิน normal — บ่งชี้ fault activity ภายในหม้อแปลง (ระบุประเภทจาก Key gas)',
    detail:'TDCG = H₂+CH₄+C₂H₂+C₂H₄+C₂H₆+CO — IEEE C57.104: C1<720 (Normal), C2=720-1920 (Monitor), C3=1920-4630 (Action), C4>4630 (Emergency)',
    inspect:[
      'ระบุ Key gas ที่สูงสุดเพื่อบ่งชี้ fault type',
      'วิเคราะห์ Duval Triangle (ดูผลด้านล่าง)',
      'คำนวณ Rogers ratio: R1=C₂H₂/C₂H₄, R2=CH₄/H₂, R3=C₂H₄/C₂H₆',
      'ตรวจ Gas-in-oil trend rate (ppm/month)',
      'ตรวจ Oil temperature, Load history'
    ],
    action:[
      'TDCG C2 (720–1920): DGA ทุก 1–3 เดือน',
      'TDCG C3 (1920–4630): DGA ทุก 1 เดือน, ลด load, เตรียม outage',
      'TDCG C4 (>4630): Emergency outage — ห้ามปล่อยทำงาน',
      'วิเคราะห์ fault type และดำเนินการตาม gas dominant'
    ]}
};

function getDuvalFaultType(d) {
  // ── Duval Triangle 1 — IEC 60599:2007 / IEEE C57.104-2008 ──
  // Zone boundaries ตาม Duval Triangle diagram
  // D1 : %C2H2 >= 29%  หรือ  %C2H2 >= 13% และ %C2H4 < 23%
  // D2 : %C2H2 >= 13% และ %C2H4 >= 23%
  // DT : %C2H2 >= 4%  และ %C2H4 >= 15%  (mixed fault)
  // T3 : %C2H4 >= 50%  |  T2 : %C2H4 >= 20%
  // PD : %CH4  >= 98% (apex)  |  T1 : ที่เหลือ
  const ch4=d.CH4||0, c2h4=d.C2H4||0, c2h2=d.C2H2||0;
  const total=ch4+c2h4+c2h2;
  if(total<1) return null;
  const pM=ch4/total*100, pE=c2h4/total*100, pA=c2h2/total*100;

  // ── PREREQUISITE CHECK (IEEE C57.104-2008) ──────────────────────
  // Duval Triangle = Fault TYPE tool — ใช้เฉพาะเมื่อมีหลักฐานว่ามี Fault
  // ต้องมีอย่างน้อย 1 Duval gas เกิน C1 limit:
  //   CH4 C1 = 120 ppm | C2H4 C1 = 50 ppm | C2H2 C1 = 1 ppm
  // ถ้าทุก Duval gas ≤ C1 → ไม่มี Fault Indication → Duval N/A
  if(ch4<=120 && c2h4<=50 && c2h2<=1) {
    return {code:'N/A',
            label:'N/A — Duval ไม่ applicable (CH4, C2H4, C2H2 ทุกตัวอยู่ใน C1 Normal)',
            color:'#16a34a', pM:pM.toFixed(1), pE:pE.toFixed(1), pA:pA.toFixed(1)};
  }
  // ────────────────────────────────────────────────────────────────

  // Zone D1: C2H2 >= 29%
  if(pA>=29) return {code:'D1',label:'D1 — Electrical Discharge (Low Energy)',color:'#dc2626',pM:pM.toFixed(1),pE:pE.toFixed(1),pA:pA.toFixed(1)};

  // Zone D1 / D2: C2H2 ระหว่าง 13–29%
  if(pA>=13){
    if(pE>=23) return {code:'D2',label:'D2 — Electrical Discharge (High Energy / Arcing) ⚠️',color:'#dc2626',pM:pM.toFixed(1),pE:pE.toFixed(1),pA:pA.toFixed(1)};
    return {code:'D1',label:'D1 — Electrical Discharge (Low Energy)',color:'#dc2626',pM:pM.toFixed(1),pE:pE.toFixed(1),pA:pA.toFixed(1)};
  }

  // Zone DT: C2H2 ระหว่าง 4–13% และ C2H4 >= 15%
  if(pA>=4&&pE>=15) return {code:'DT',label:'DT — Mixture of Electrical + Thermal Faults',color:'#ea580c',pM:pM.toFixed(1),pE:pE.toFixed(1),pA:pA.toFixed(1)};

  // Zone T3: C2H4 >= 50%
  if(pE>=50) return {code:'T3',label:'T3 — High Temperature Thermal Fault (>700°C)',color:'#ea580c',pM:pM.toFixed(1),pE:pE.toFixed(1),pA:pA.toFixed(1)};

  // Zone T2: C2H4 >= 20%
  if(pE>=20) return {code:'T2',label:'T2 — Thermal Fault (300–700°C)',color:'#d97706',pM:pM.toFixed(1),pE:pE.toFixed(1),pA:pA.toFixed(1)};

  // Zone PD: CH4 >= 98% (apex ของ triangle)
  if(pM>=98) return {code:'PD',label:'PD — Corona Partial Discharges',color:'#7c3aed',pM:pM.toFixed(1),pE:pE.toFixed(1),pA:pA.toFixed(1)};

  // Zone T1: ที่เหลือ (low-temperature thermal หรือ gas ต่ำมาก)
  return {code:'T1',label:'T1 — Low Temperature Thermal Fault (<300°C)',color:'#d97706',pM:pM.toFixed(1),pE:pE.toFixed(1),pA:pA.toFixed(1)};
}

function getRogersRatios(d) {
  const ch4r=d.CH4||0, c2h4r=d.C2H4||0, c2h2r=d.C2H2||0, h2r=d.H2||0, c2h6r=d.C2H6||0;
  // ── PREREQUISITE CHECK ──────────────────────────────────────────
  // Rogers Ratios = Fault TYPE tool — ใช้เฉพาะเมื่อมี Gas เกิน C1 limit
  // (IEEE C57.104-2008: CH4>120 | C2H4>50 | C2H2>1 | H2>100 | C2H6>65 ppm)
  if(ch4r<=120 && c2h4r<=50 && c2h2r<=1 && h2r<=100 && c2h6r<=65) {
    return {r1:'—', r2:'—', r3:'—', ftype:'N/A — Gas ทุกตัวอยู่ใน C1 Normal (Rogers ใช้เฉพาะเมื่อ Gas เกิน Limit)'};
  }
  // ────────────────────────────────────────────────────────────────
  const c2h2=d.C2H2||0.001, c2h4=d.C2H4||0.001, ch4=d.CH4||0.001, h2=d.H2||0.001, c2h6=d.C2H6||0.001;
  const r1=(c2h2/c2h4).toFixed(3), r2=(ch4/h2).toFixed(3), r3=(c2h4/c2h6).toFixed(3);
  // Rogers ratio fault classification
  let ftype='';
  const r1f=parseFloat(r1),r2f=parseFloat(r2),r3f=parseFloat(r3);
  if(r1f<0.1&&r2f>=0.1&&r2f<1&&r3f<1) ftype='Normal (ปกติ)';
  else if(r1f<0.1&&r2f>=0.1&&r2f<1&&r3f>=1&&r3f<=3) ftype='Thermal <150°C';
  else if(r1f<0.1&&r2f>1&&r3f>=1&&r3f<=3) ftype='Thermal 150–200°C';
  else if(r1f<0.1&&r2f>1&&r3f>3) ftype='Thermal >200°C';
  else if(r1f>=0.1&&r1f<=3&&r2f<0.1) ftype='Partial Discharge';
  else if(r1f>3&&r2f<0.1) ftype='Partial Discharge (Severe)';
  else if(r1f>=0.1&&r1f<=3&&r2f>=0.1&&r2f<1) ftype='Low-energy Discharge';
  else if(r1f>3&&r2f>=0.1&&r2f<1) ftype='High-energy Discharge + Thermal';
  else ftype='Indeterminate';
  return {r1,r2,r3,ftype};
}

function getIECGasAnalysisHTML(d) {
  // IEEE C57.104-2008: L1=C1 limit, L2=C2 limit (C3 shown in card)
  const limits = [
    {key:'C2H2',L1:1,  L2:9,   L3:35,  label:'Acetylene'},
    {key:'H2',  L1:100,L2:700, L3:1800,label:'Hydrogen'},
    {key:'CH4', L1:120,L2:400, L3:1000,label:'Methane'},
    {key:'C2H4',L1:50, L2:100, L3:200, label:'Ethylene'},
    {key:'C2H6',L1:65, L2:100, L3:150, label:'Ethane'},
    {key:'CO',  L1:350,L2:570, L3:1400,label:'Carbon Monoxide'},
    {key:'CO2', L1:2500,L2:4000,L3:10000,label:'Carbon Dioxide'},
    {key:'TDCG',L1:720,L2:1920,L3:4630,label:'TDCG'}
  ];
  const over = limits.filter(g=>(d[g.key]||0)>g.L1);
  if(!over.length) return '<div style="color:var(--green);padding:8px;">✅ ค่า Gas ทุกตัวอยู่ในเกณฑ์ปกติ (IEEE C57.104-2008 Condition 1)</div>';

  let html='';

  // ── Duval Triangle ──
  const duval=getDuvalFaultType(d);
  const rogers=getRogersRatios(d);
  const co=d.CO||0, co2=d.CO2||0;
  const coco2ratio=co>0?(co2/co).toFixed(1):'-';
  const coco2note=co>0?(parseFloat(coco2ratio)>11?'Normal aging ของ paper (ไม่วิกฤต)':parseFloat(coco2ratio)>3?'เฝ้าระวัง paper degradation':'⚠️ Active thermal fault ใน paper insulation'):'';

  html+=`<div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:12px 14px;margin-bottom:12px;">
    <div style="font-weight:700;font-size:12px;color:#0369a1;margin-bottom:8px;">🔬 FAULT DIAGNOSIS — IEEE C57.104-2008 / IEC 60599:2007</div>
    <table style="width:100%;font-size:11.5px;border-collapse:collapse;">
      <tr><td style="padding:2px 6px;color:#64748b;width:45%;">📐 Duval Triangle
          <div style="font-size:9.5px;color:#94a3b8;margin-top:2px;">ใช้เฉพาะเมื่อ CH4/C2H4/C2H2 เกิน C1</div></td>
          <td style="padding:2px 6px;font-weight:600;color:${duval?(duval.code==='N/A'?'#16a34a':duval.color):'#6b7280'}">
            ${duval?duval.label:'ข้อมูล gas ไม่เพียงพอ (CH4+C2H4+C2H2 < 1 ppm)'}
            ${duval&&duval.code!=='N/A'?`<span style="margin-left:8px;font-weight:400;font-size:10.5px;color:#64748b;">(%CH4=${duval.pM} | %C2H4=${duval.pE} | %C2H2=${duval.pA})</span>`:''}
            ${duval&&duval.code==='N/A'?`<span style="margin-left:8px;font-weight:400;font-size:10px;color:#64748b;">ค่าปัจจุบัน: %CH4=${duval.pM} | %C2H4=${duval.pE} | %C2H2=${duval.pA} (อ้างอิงเท่านั้น)</span>`:''}
          </td></tr>
      <tr><td style="padding:2px 6px;color:#64748b;">📊 Rogers Ratios
          <div style="font-size:9.5px;color:#94a3b8;margin-top:2px;">ใช้เฉพาะเมื่อ Gas เกิน C1</div></td>
          <td style="padding:2px 6px;">R1(C₂H₂/C₂H₄)=${rogers.r1} | R2(CH₄/H₂)=${rogers.r2} | R3(C₂H₄/C₂H₆)=${rogers.r3}
          <span style="margin-left:6px;font-weight:600;color:${rogers.r1==='—'?'#16a34a':'#0369a1'};">→ ${rogers.ftype}</span></td></tr>
      ${co>0?`<tr><td style="padding:2px 6px;color:#64748b;">📋 CO₂/CO Ratio</td>
          <td style="padding:2px 6px;font-weight:600;">${coco2ratio} <span style="color:${parseFloat(coco2ratio)<3?'#dc2626':parseFloat(coco2ratio)<11?'#d97706':'#16a34a'}">→ ${coco2note}</span></td></tr>`:''}
    </table>
  </div>`;

  // ── Per-gas cards ──
  over.forEach(g=>{
    const info=IEC_GAS[g.key]; if(!info) return;
    const val=d[g.key]||0;
    const isC4=g.L3&&val>g.L3, isC3=!isC4&&g.L2&&val>g.L2, isC2=!isC4&&!isC3;
    const condCode=isC4?'C4':isC3?'C3':'C2';
    const condLabel=isC4?'C4 — CRITICAL (Consider removal from service)':isC3?'C3 — Plan outage, Advise manufacturer':'C2 — Monitor, Determine load dependence';
    const sev=isC4?'#fef2f2':isC3?'#fff3e0':'#fff7ed';
    const sevBorder=isC4?'#fca5a5':isC3?'#fdba74':'#fed7aa';
    const sevColor=isC4?'#dc2626':isC3?'#ea580c':'#d97706';
    const sevTag=`<span style="background:${sev};color:${sevColor};border:1px solid ${sevBorder};padding:1px 8px;border-radius:10px;font-size:10px;font-weight:700;">${condCode}: ${isC4?'CRITICAL':isC3?'PLAN OUTAGE':'MONITOR'}</span>`;
    html+=`<div style="background:${sev};border:1px solid ${sevBorder};border-radius:8px;padding:12px 14px;margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span style="font-weight:700;font-size:13px;">${info.name}: <span style="color:${sevColor}">${val.toFixed(0)} ${info.unit}</span></span>
        ${sevTag}
      </div>
      <div style="font-size:11px;color:#64748b;margin-bottom:6px;">IEEE C57.104-2008 — C1≤${g.L1} | C2≤${g.L2||'-'} | C3≤${g.L3||'-'} | C4>${g.L3||'-'} ppm &nbsp;→&nbsp; <b style="color:${sevColor}">${condLabel}</b></div>
      <div style="font-size:12px;margin-bottom:8px;">${info.detail}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div style="background:rgba(255,255,255,0.7);border-radius:6px;padding:8px 10px;">
          <div style="font-size:10px;font-weight:700;color:#dc2626;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">⚡ สาเหตุที่เป็นไปได้</div>
          <div style="font-size:11.5px;line-height:1.6;">${info.cause}</div>
        </div>
        <div style="background:rgba(255,255,255,0.7);border-radius:6px;padding:8px 10px;">
          <div style="font-size:10px;font-weight:700;color:#0369a1;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">🔬 สิ่งที่ควรตรวจสอบ</div>
          <ul style="margin:0;padding-left:14px;font-size:11.5px;line-height:1.7;">${info.inspect.map(x=>`<li>${x}</li>`).join('')}</ul>
        </div>
      </div>
      <div style="background:rgba(255,255,255,0.7);border-radius:6px;padding:8px 10px;margin-top:8px;">
        <div style="font-size:10px;font-weight:700;color:#166534;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">🔧 แนวทางแก้ไขเบื้องต้น</div>
        <ul style="margin:0;padding-left:14px;font-size:11.5px;line-height:1.7;">${info.action.map(x=>`<li>${x}</li>`).join('')}</ul>
      </div>
    </div>`;
  });
  return html;
}

function getRec(d,type) {
  const co=d.CO||0,tdcg=d.TDCG||0,h2=d.H2||0,c2h2=d.C2H2||0,c2h4=d.C2H4||0;
  const rs = {
    'DGA': ()=> getIECGasAnalysisHTML(d),
    'Color': ()=>{
      const v=d.color_number||0;
      const sev=v>3.5?'→ <b style="color:#dc2626">เปลี่ยนน้ำมันใหม่ (Oil Replacement)</b>':v>2.5?'→ ทำ Oil Filtering/Polishing':' — ปกติ';
      return `<b>📋 อ้างอิง: ASTM D1500</b><br>
        <b>สาเหตุ:</b> Oil สีเข้มบ่งชี้ Oxidation, Contamination หรือ Thermal degradation ของ oil<br>
        <b>ตรวจสอบ:</b> ตรวจ Oil ด้วยสายตา, Furan test, Acid Number, IFT<br>
        <b>แนวทาง:</b> Color ${fmt(v,1)} ${sev}`;},
    'IFT': ()=>{
      const v=d.IFT||0;
      const sev=v<20?'<b style="color:#dc2626">Oil Reclamation หรือเปลี่ยนน้ำมัน</b>':'Oil Filtering/Polishing + ติดตาม Trend';
      return `<b>📋 อ้างอิง: ASTM D971 / IEEE C57-106</b><br>
        <b>สาเหตุ:</b> IFT ต่ำบ่งชี้ Oil oxidation, polar contaminants (acid, sludge) สะสมใน oil<br>
        <b>ตรวจสอบ:</b> Acid Number (ถ้า IFT ต่ำมักมี Acid สูง), Oil ด้วยสายตา, Bottom sediment<br>
        <b>แนวทาง:</b> IFT ${fmt(v,1)} mN/M → ${sev}`;},
    'DBV': ()=>{
      const v=d.DBV||0;
      return `<b>📋 อ้างอิง: ASTM D877 / IEC 60156</b><br>
        <b>สาเหตุ:</b> DBV ต่ำเกิดจาก Moisture ในน้ำมัน, Particles/fibers contamination หรือ dissolved gases<br>
        <b>ตรวจสอบ:</b> ตรวจ Moisture content (ASTM D1533), Particle count, Oil sampling condition<br>
        <b>แนวทาง:</b> DBV ${fmt(v,1)} kV → ทำ Oil Degassing/Dehydration (Hot oil circulation หรือ Vacuum processing), ตรวจ Seal & Gasket, ทดสอบซ้ำหลัง treatment`;},
    'DF25°C': ()=>{
      const v=d.DF_25C||0;
      return `<b>📋 อ้างอิง: ASTM D924 / IEC 60247</b><br>
        <b>สาเหตุ:</b> Dissipation Factor สูงบ่งชี้ Moisture, Oxidation products, Polar contaminants ใน oil หรือ Bushing insulation เสื่อม<br>
        <b>ตรวจสอบ:</b> ตรวจ Moisture in oil, Bushing Tan Delta & Capacitance, Acid Number, Oil color<br>
        <b>แนวทาง:</b> DF ${fmt(v,3)}% → Oil Purification (Vacuum dehydration + Degassing), ตรวจ Bushing อย่างละเอียด, ตรวจ Contamination source`;},
    'Acidity': ()=>{
      const v=d.acidity||0;
      const sev=v>0.5?'<b style="color:#dc2626">Oil Reclamation + Inhibitor เร่งด่วน</b>':v>0.35?'Oil Reclamation + DBPC Inhibitor':'Oil Polishing + เพิ่ม Oxidation Inhibitor (DBPC)';
      return `<b>📋 อ้างอิง: ASTM D664 / IEEE C57-106</b><br>
        <b>สาเหตุ:</b> Acid สูงเกิดจาก Oil Oxidation → สะสม Organic acids → เกิด Sludge ใน winding และ cooling duct → เสี่ยง Corrosive Sulfur<br>
        <b>ตรวจสอบ:</b> ตรวจ IFT (มักต่ำคู่กับ Acid สูง), Color Number, Oil sludge ด้วยสายตา, Oxidation Inhibitor (DBPC) level<br>
        <b>แนวทาง:</b> Acid ${fmt(v,3)} mgKOH/g → ${sev}`;},
    'Moisture': ()=>{
      const v=d.moisture_ppm||0;
      const sev=v>50?'<b style="color:#dc2626">Online Drying หรือ Vacuum Oil Treatment เร่งด่วน</b>':v>35?'Vacuum Dehydration + ตรวจ Seal':'Silica Gel + ติดตาม trend';
      return `<b>📋 อ้างอิง: ASTM D1533 / IEEE C57-106</b><br>
        <b>สาเหตุ:</b> Moisture สูงลด Dielectric strength, เร่ง Paper aging, เสี่ยง Bubble formation (อุณหภูมิสูง)<br>
        <b>ตรวจสอบ:</b> ตรวจ Seal & Gasket, Conservator, Silica gel breather (อิ่มตัว?), DBV (มักต่ำ), Sampling temperature<br>
        <b>แนวทาง:</b> Moisture ${fmt(v,1)} ppm → ${sev} + ตรวจ Seal system ทั้งหมด`;},
  };
  return (rs[type]||rs['DGA'])();
}
function renderAIAnalysis() {
  const container=document.getElementById('ai-content');
  const flagged=currentData.filter(d=>getIssues(d).length>0);
  if(!flagged.length){container.innerHTML='<div style="text-align:center;padding:40px;color:var(--green);">✅ All selected transformers are within limits</div>';return;}
  container.innerHTML=`<div style="margin-bottom:12px;font-size:12px;color:var(--text2);">พบ <b>${flagged.length} เครื่อง</b> ที่มีค่าเกิน Limit</div>`;
  flagged.forEach(d=>{
    const iss=getIssues(d);
    const sev=iss.find(i=>i.sev==='Extreme')?'extreme':iss.find(i=>i.sev==='Serious')?'serious':'moderate';
    const nonDGA=iss.filter(i=>i.type!=='DGA');
    const hasDGA=iss.some(i=>i.type==='DGA');
    container.innerHTML+=`<div class="ai-issue ${sev}">
      <div class="ai-issue-header">
        <div class="ai-issue-title">[${d.no}] ${d.equipment_id} — S/N: ${d.serial_no} | ${d.rated_power||'-'} kVA ${d.manufacturer||''} ${d.year||''}</div>
        <div style="display:flex;gap:6px;align-items:center;">${condBadge(getTDCGCondition(d))}<span style="font-size:10px;color:var(--text2);">Sampling: ${d.sampling_date||'-'}</span></div>
      </div>
      ${iss.map(i=>`<div class="ai-finding">⚠️ <b>${i.type}:</b> ${i.val}</div>`).join('')}
      <div class="ai-rec">
        ${hasDGA?`<div>${getRec(d,'DGA')}</div>`:''}
        ${nonDGA.length?`<hr style="border:none;border-top:1px dashed #cbd5e1;margin:8px 0;">${nonDGA.map(i=>`<div style="margin-bottom:8px;">${getRec(d,i.type)}</div>`).join('<hr style="border:none;border-top:1px dashed #cbd5e1;margin:6px 0;">')}`:''}
      </div>
    </div>`;
  });
}

// Upload
function loadNewReport(event) {
  const file=event.target.files[0];if(!file) return;
  const reader=new FileReader();
  reader.onload=e=>{
    try{
      const nd=JSON.parse(e.target.result);if(!Array.isArray(nd)) throw new Error('Expected JSON array');
      nd.forEach(rec=>{const idx=RAW_DATA.findIndex(d=>d.serial_no===rec.serial_no);if(idx>=0) RAW_DATA[idx]=rec;else RAW_DATA.push(rec);});
      currentData=[...RAW_DATA];
      document.getElementById('last-updated').textContent=`Updated: ${new Date().toLocaleString()} (+${nd.length} records)`;
      populateEquipmentFilter();populateTrendSelect();updateAllCharts();updateKPIs();updateOverviewTable();
      alert(`✅ Loaded ${nd.length} records!`);
    }catch(err){alert(`❌ Error: ${err.message}`);}
  };
  reader.readAsText(file);
}

window.onload = async () => {
  try {
    const response = await fetch('data.json');
    if (!response.ok) throw new Error('data.json not found');
    const data = await response.json();
    loadDashboardData(data);
  } catch (e) {
    console.warn('Could not load data.json. Showing upload screen.', e);
    const uploadScreen = document.getElementById('upload-screen');
    const dashboardRoot = document.getElementById('dashboard-root');
    if (uploadScreen) uploadScreen.classList.remove('hidden');
    if (dashboardRoot) dashboardRoot.style.display = 'none';
  }
};

// ─── JSON Upload & Init ───────────────────────────────────────────
function loadDashboardData(data) {
  if (!Array.isArray(data) || data.length === 0) {
    document.getElementById('upload-error').style.display = 'block';
    return;
  }
  RAW_DATA = data;
  currentData = [...RAW_DATA];

  // Update header meta from data
  const loc = RAW_DATA[0]?.location || '';
  const sDate = RAW_DATA[0]?.sampling_date || '';
  const el = document.querySelector('.subtitle');
  if (el) el.textContent = `${loc} | Transformers: ${RAW_DATA.length} | Sampling: ${sDate}`;

  // Show dashboard, hide upload screen
  document.getElementById('upload-screen').classList.add('hidden');
  document.getElementById('dashboard-root').style.display = 'block';

  // Init dashboard
  initDashboard();
}

function handleFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      loadDashboardData(data);
    } catch(err) {
      document.getElementById('upload-error').style.display = 'block';
      console.error('JSON parse error:', err);
    }
  };
  reader.readAsText(file);
}

// File input change
document.getElementById('json-input').addEventListener('change', e => {
  handleFile(e.target.files[0]);
});

// Drag & Drop
const dropZone = document.getElementById('drop-zone');
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  handleFile(e.dataTransfer.files[0]);
});

// Wrap existing initDashboard to be callable
function initDashboard() {
  populateEquipmentFilter();
  populateTrendSelect();
  updateKPIs();
  updateOverviewTable();
  updateAllCharts();
  // Set default active tab
  document.querySelectorAll('.tab')[0]?.click();
}

// ─── Save HTML with Embedded Data ────────────────────────────
function downloadWithData() {
  if (!RAW_DATA || RAW_DATA.length === 0) {
    showToast('❌ ไม่มีข้อมูล — กรุณา Upload JSON ก่อนบันทึก');
    return;
  }
  showToast('⏳ กำลังสร้างไฟล์ HTML...');

  // Short delay so the toast appears before heavy JSON stringify
  setTimeout(() => {
    try {
      const dataJson = JSON.stringify(RAW_DATA);
      let html = document.documentElement.outerHTML;

      // 1. Embed RAW_DATA & initialize currentData
      html = html.replace('let RAW_DATA = [];',
        `let RAW_DATA = ${dataJson};`);
      html = html.replace('let currentData = [];',
        'let currentData = [...RAW_DATA];');

      // 2. Show dashboard directly — no upload screen
      html = html.replace('#dashboard-root{display:none;}',
        '#dashboard-root{display:block;}');
      html = html.replace('#upload-screen.hidden{display:none;}',
        '#upload-screen,#upload-screen.hidden{display:none!important;}');

      // 3. Filename based on location + sampling date
      const loc  = (RAW_DATA[0]?.location     || 'report').replace(/[^\w]/g,'_');
      const sd   = (RAW_DATA[0]?.sampling_date || '').replace(/[^\w]/g,'') ||
                   new Date().toISOString().slice(0,10).replace(/-/g,'');
      const fname = `Transformer_Dashboard_${loc}_${sd}.html`;

      // 4. Trigger download
      const blob = new Blob([html], {type:'text/html;charset=utf-8'});
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = fname;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 3000);

      // 5. Success feedback
      showToast(`✅ บันทึกสำเร็จ: ${fname}\n📌 เปิดไฟล์นี้ได้ทันทีโดยไม่ต้อง Upload ซ้ำ`, 5000);
    } catch(err) {
      showToast('❌ เกิดข้อผิดพลาด: ' + err.message, 5000);
    }
  }, 80);
}

// ─── Toast Notification ───────────────────────────────────────
function showToast(msg, duration=3000) {
  let t = document.getElementById('save-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'save-toast';
    t.className = 'save-toast';
    document.body.appendChild(t);
  }
  t.style.whiteSpace = 'pre-line';
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), duration);
}

