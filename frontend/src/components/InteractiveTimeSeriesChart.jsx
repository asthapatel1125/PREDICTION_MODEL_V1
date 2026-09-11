import {useCallback, useMemo, useRef, useState} from "react";
import Plot from "react-plotly.js";
import "./InteractiveTimeSeriesChart.css";

const easternClock=value=>new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:true}).format(new Date(value));

export default function InteractiveTimeSeriesChart({title,traces=[],xAxisTitle="Time",yAxisTitle="Value",unit="",selectedDatasetId="default",height=380,showRangeSlider=true,marketHoursOnly=false,annotations=[],shapes=[],onRelayout}){
  const graphRef=useRef(null),[hovered,setHovered]=useState(null),[resetRevision,setResetRevision]=useState(0);
  const data=useMemo(()=>traces.map((trace,index)=>({
    type:(trace.x?.length||0)>12000?"scattergl":"scatter",mode:"lines",connectgaps:false,
    ...trace,x:[...(trace.x||[])],y:[...(trace.y||[])],name:trace.name||`Series ${index+1}`,
    line:{width:2,...trace.line},
    hovertemplate:`<b>%{fullData.name}</b><br>Time: %{x|%b %d, %Y %I:%M:%S %p}<br>Value: %{y:.2f} ${trace.unit||unit}${trace.status?`<br>Status: ${trace.status}`:""}<extra></extra>`,
  })),[traces,unit]);
  const rangebreaks=marketHoursOnly?[{bounds:["sat","mon"]},{pattern:"hour",bounds:[16,9.5]}]:[];
  const layout=useMemo(()=>({
    autosize:true,dragmode:"pan",hovermode:"x unified",hoverdistance:20,spikedistance:-1,uirevision:selectedDatasetId,
    paper_bgcolor:"#050d14",plot_bgcolor:"#040a0f",font:{family:"IBM Plex Mono, Consolas, monospace",color:"#b6d0df",size:12},
    margin:{l:76,r:24,t:16,b:showRangeSlider?62:44},showlegend:false,annotations,shapes,
    xaxis:{title:xAxisTitle,type:"date",fixedrange:false,gridcolor:"#18364b",showspikes:true,spikemode:"across",spikesnap:"data",spikecolor:"#d8e1ee",spikethickness:1,rangebreaks,rangeslider:{visible:showRangeSlider,thickness:.07,bgcolor:"#07111b",bordercolor:"#315b75",borderwidth:1}},
    yaxis:{title:yAxisTitle,fixedrange:false,gridcolor:"#18364b",showspikes:true,spikemode:"across",spikesnap:"data",spikecolor:"#7f8ea3",spikethickness:1,automargin:true},
  }),[selectedDatasetId,xAxisTitle,yAxisTitle,showRangeSlider,marketHoursOnly,annotations,shapes]);
  const config=useMemo(()=>({responsive:true,scrollZoom:true,displaylogo:false,displayModeBar:true,doubleClick:"reset+autosize",modeBarButtonsToRemove:["lasso2d","select2d"],toImageButtonOptions:{format:"png",filename:"axiom-interactive-chart",scale:2}}),[]);
  const reset=useCallback(()=>{setHovered(null);setResetRevision(value=>value+1)},[]);
  const hover=event=>{const points=event?.points||[];if(!points.length)return;const timestamp=points[0].x;setHovered({timestamp,values:points.filter(point=>point.y!==null&&point.y!==undefined).map(point=>({name:point.data.name,value:Number(point.y),unit:point.data.meta?.unit||unit,status:point.data.meta?.status||""}))})};
  return <section className="interactive-time-series" aria-label={title} style={{"--interactive-chart-height":`${height}px`}}>
    <div className="interactive-chart-toolbar"><button type="button" onClick={reset} aria-label={`Reset ${title} view`}>RESET VIEW</button><span>WHEEL: ZOOM · DRAG: PAN · AXES: INDEPENDENT</span></div>
    <div className="interactive-chart-readout" aria-live="polite">{hovered?<><b>{easternClock(hovered.timestamp)}</b>{hovered.values.map((item,index)=><span key={`${item.name}-${index}`} style={{color:data.find(trace=>trace.name===item.name)?.line?.color}}>{item.name}<strong>{Number.isFinite(item.value)?item.value.toFixed(2):"—"} {item.unit}</strong>{item.status&&<em>{item.status}</em>}</span>)}</>:<span>Hover over the graph for exact stored values</span>}</div>
    <div className="interactive-chart-plot">
      <Plot key={`${selectedDatasetId}-${resetRevision}`} data={data.map(trace=>({...trace,meta:{unit:trace.unit||unit,status:trace.status||""}}))} layout={layout} config={config} useResizeHandler style={{width:"100%",height:"100%"}} onInitialized={(_,graph)=>{graphRef.current=graph}} onUpdate={(_,graph)=>{graphRef.current=graph}} onHover={hover} onUnhover={()=>setHovered(null)} onRelayout={onRelayout}/>
    </div>
  </section>;
}
