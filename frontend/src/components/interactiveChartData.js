export function exposureRowsToTraces(rows=[],wallKey="ZERO_GAMMA"){
  const points=rows.map(row=>({timestamp:row?.timestamp,spot:Number(row?.spot),level:Number(row?.walls?.[wallKey]?.strike)})).filter(point=>Number.isFinite(Date.parse(point.timestamp))&&Number.isFinite(point.spot)&&point.spot>0&&Number.isFinite(point.level)&&point.level>0);
  const label=wallKey==="ZERO_DELTA"?"ZERO Δ":"ZERO Γ";
  const positive=points.map(point=>point.level<=point.spot?point.level:null),negative=points.map(point=>point.level>point.spot?point.level:null);
  return [
    {name:"QQQ",x:points.map(point=>point.timestamp),y:points.map(point=>point.spot),unit:"USD",line:{color:"#e6edf3",width:3}},
    {name:`${label} · BELOW QQQ`,x:points.map(point=>point.timestamp),y:positive,unit:"USD",status:"BELOW QQQ",line:{color:"#00d084",width:2.7,dash:"dash"}},
    {name:`${label} · ABOVE QQQ`,x:points.map(point=>point.timestamp),y:negative,unit:"USD",status:"ABOVE QQQ",line:{color:"#ff4f69",width:2.7,dash:"dash"}},
  ];
}
