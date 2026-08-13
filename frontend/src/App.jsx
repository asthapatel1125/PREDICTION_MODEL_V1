import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchChart, fetchConfiguration, fetchDashboard, fetchDynamicsHistory, fetchInstruments, fetchOutcomeAttribution, fetchOutcomeCall, fetchReplay, fetchSystem, fetchWallSpectrum, fetchWallBreaks, fetchWallDealerFlow,
  startReplay, subscribeToEvents, toDashboardAlert,
} from "./api";

const OVERVIEW_SECTIONS = [
  ["System scorecard", "system-scorecard"], ["One-screen focus", "decision"], ["Wall intelligence", "wall-intelligence"], ["Gamma dynamics 1.0", "gamma-dynamics"], ["Gamma dynamics 2.0", "gamma-dynamics-v2"], ["Delta dynamics", "six-greek-dynamics"], ["Experimental forecast", "forecast"], ["Signal scores", "score-modules"], ["Greek orders", "greek-orders"],
  ["Custom Greek graphs", "custom-greeks"], ["Live alerts", "live-alerts"],
];
const DEFAULT_MODULE_ORDER=["wall-intelligence","gamma-dynamics","gamma-dynamics-v2","six-greek-dynamics","forecast","score-modules","greek-orders","custom-greeks","live-alerts"];
const OVERVIEW_LABELS=Object.fromEntries(OVERVIEW_SECTIONS.map(([label,id])=>[id,label]));
const OVERVIEW_NUMBERS=Object.fromEntries(OVERVIEW_SECTIONS.map(([,id],index)=>[id,String(index+1).padStart(2,"0")]));
const OVERVIEW_CATEGORIES={
  "system-scorecard":"OUTCOME BRIEFING",
  decision:"DECISION",
  "wall-intelligence":"MARKET STRUCTURE",
  "gamma-dynamics":"SIGNAL MODEL",
  "gamma-dynamics-v2":"SIGNAL MODEL",
  "six-greek-dynamics":"SIGNAL MODEL",
  forecast:"RESEARCH",
  "score-modules":"DIAGNOSTICS",
  "greek-orders":"MARKET DATA",
  "custom-greeks":"ANALYTICS",
  "live-alerts":"AUDIT",
};
const GREEKS = ["gamma", "vanna", "charm", "vomma", "veta", "speed", "zomma", "color", "ultima"];
const CHART_INTERVALS = [
  ["5s", 5], ["15s", 15], ["1m", 60], ["3m", 180], ["5m", 300],
  ["15m", 900], ["30m", 1800], ["1h", 3600], ["4h", 14400], ["1D", 86400],
];
const GREEK_COLORS = {
  delta:"#ff5c8a", theta:"#ffd166", vega:"#b388ff", rho:"#2dd4bf",
  gamma:"#4cc9f0", vanna:"#f72585", charm:"#90be6d", vomma:"#ff9f1c", veta:"#4361ee",
  speed:"#ef476f", zomma:"#06d6a0", color:"#f4d35e", ultima:"#c77dff",
};
const GREEK_CATALOG = {
  delta: { order:"first", derivedFrom:[] },
  theta: { order:"first", derivedFrom:[] },
  vega: { order:"first", derivedFrom:[] },
  rho: { order:"first", derivedFrom:[] },
  gamma: { order:"second", derivedFrom:["Delta", "underlying price"] },
  vanna: { order:"second", derivedFrom:["Delta", "implied volatility"] },
  charm: { order:"second", derivedFrom:["Delta", "time"] },
  vomma: { order:"second", derivedFrom:["Vega", "implied volatility"] },
  veta: { order:"second", derivedFrom:["Vega", "time"] },
  speed: { order:"third", derivedFrom:["Gamma", "underlying price"] },
  zomma: { order:"third", derivedFrom:["Gamma", "implied volatility"] },
  color: { order:"third", derivedFrom:["Gamma", "time"] },
  ultima: { order:"third", derivedFrom:["Vomma", "implied volatility"] },
};
const GREEK_ORDERS = {
  first: { label: "1st order · pink", series: ["delta","theta","vega","rho"].map(name=>[name,GREEK_COLORS[name]]) },
  second: { label: "2nd order · sky blue", series: ["gamma","vanna","charm","vomma","veta"].map(name=>[name,GREEK_COLORS[name]]) },
  third: { label: "3rd order · lime green", series: ["speed","zomma","color","ultima"].map(name=>[name,GREEK_COLORS[name]]) },
};
const FALLBACK_INSTRUMENTS = ["SPY", "QQQ", "NDX", "NQ", "ES", "YM"].map(symbol => ({
  symbol, available: ["SPY", "QQQ", "NDX"].includes(symbol),
  provider: ["SPY", "QQQ", "NDX"].includes(symbol) ? "ThetaData options" : "Futures feed required",
}));
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const optionalNumber = (value) => value === null || value === undefined || value === "" ? NaN : number(value, NaN);
const greekValue = (row, name) => optionalNumber(row?.greeks?.[name] ?? row?.supporting_indicators?.[`greek_${name}`]);
const pct = (value) => `${(number(value) * 100).toFixed(1)}%`;
const pretty = (value = "") => String(value).replaceAll("_", " ");
const biasLabel = (value) => value === "UP" ? "LONG" : value === "DOWN" ? "SHORT" : "WAIT";
const EASTERN_TZ="America/New_York";
const easternDateFormatter=new Intl.DateTimeFormat("en-CA",{timeZone:EASTERN_TZ,year:"numeric",month:"2-digit",day:"2-digit"});
const easternTimeFormatter=new Intl.DateTimeFormat("en-US",{timeZone:EASTERN_TZ,hour12:true,hour:"2-digit",minute:"2-digit",second:"2-digit",fractionalSecondDigits:3});
const easternIdFormatter=new Intl.DateTimeFormat("en-US",{timeZone:EASTERN_TZ,hourCycle:"h23",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"});
const time = value => value&&!Number.isNaN(new Date(value).getTime())?`${new Date(value).toLocaleTimeString("en-US",{timeZone:EASTERN_TZ,hour12:true,hour:"2-digit",minute:"2-digit",second:"2-digit"})} EST`:"—";
const logDate = value => {const date=new Date(value);return Number.isNaN(date.getTime())?"—":easternDateFormatter.format(date)};
const logTime = value => {const date=new Date(value);return Number.isNaN(date.getTime())?"—":`${easternTimeFormatter.format(date)} EST`};
const chartTime = value => {const date=new Date(value);if(Number.isNaN(date.getTime()))return "—";const today=easternDateFormatter.format(new Date()),day=easternDateFormatter.format(date),clock=date.toLocaleTimeString("en-US",{timeZone:EASTERN_TZ,hour12:true,hour:"2-digit",minute:"2-digit",second:"2-digit"});return `${day===today?"":`${day} · `}${clock} EST`};
const clockSeconds=value=>{
  if(!value)return null;
  const parts=String(value).split(":").map(Number);
  if(parts.length<2||parts.some(part=>!Number.isFinite(part)))return null;
  return parts[0]*3600+parts[1]*60+(parts[2]??0);
};
const timeRangeMatches=(eventTime,fromTime,toTime)=>{
  const eventSeconds=clockSeconds(eventTime),fromSeconds=clockSeconds(fromTime),toSeconds=clockSeconds(toTime);
  if(eventSeconds==null)return false;
  const toLimit=toSeconds==null?null:toSeconds+(String(toTime).split(":").length<3?59:0);
  if(fromSeconds!=null&&toSeconds!=null&&fromSeconds>toSeconds)return eventSeconds>=fromSeconds||eventSeconds<=toLimit;
  if(fromSeconds!=null&&eventSeconds<fromSeconds)return false;
  if(toLimit!=null&&eventSeconds>toLimit)return false;
  return true;
};
const FILTER_HOURS=Array.from({length:12},(_,index)=>index+1);
const FILTER_MINUTES=Array.from({length:60},(_,index)=>index);
function CompactEventTimeFilter({label,value,onChange}){
  const detailsRef=useRef(null),[rawHour="0",rawMinute="0"]=String(value||"0:0").split(":"),hour24=Number(rawHour),minute=Number(rawMinute),hasValue=Boolean(value),period=hour24>=12?"PM":"AM",hour12=hour24%12||12;
  useEffect(()=>{const close=event=>{const details=detailsRef.current;if(details?.open&&!details.contains(event.target))details.removeAttribute("open")};const escape=event=>event.key==="Escape"&&detailsRef.current?.removeAttribute("open");document.addEventListener("pointerdown",close);document.addEventListener("keydown",escape);return()=>{document.removeEventListener("pointerdown",close);document.removeEventListener("keydown",escape)}},[]);
  const update=(nextHour=hour12,nextMinute=minute,nextPeriod=period)=>{let converted=Number(nextHour)%12;if(nextPeriod==="PM")converted+=12;onChange(`${String(converted).padStart(2,"0")}:${String(nextMinute).padStart(2,"0")}`)};
  const display=hasValue?`${String(hour12).padStart(2,"0")}:${String(minute).padStart(2,"0")} ${period}`:"--:-- --";
  return <div className="compact-time-dropdown"><span>{label}</span><details ref={detailsRef}><summary>{display}</summary><div className="compact-time-menu"><section><b>HOUR</b><div className="time-option-grid hours">{FILTER_HOURS.map(option=><button type="button" className={hasValue&&hour12===option?"selected":""} onClick={()=>update(option)} key={option}>{option}</button>)}</div></section><section><b>MINUTE</b><div className="time-option-grid minutes">{FILTER_MINUTES.map(option=><button type="button" className={hasValue&&minute===option?"selected":""} onClick={()=>update(hour12,option)} key={option}>{String(option).padStart(2,"0")}</button>)}</div></section><section><b>AM / PM</b><div className="time-option-grid period"><button type="button" className={hasValue&&period==="AM"?"selected":""} onClick={()=>update(hour12,minute,"AM")}>AM</button><button type="button" className={hasValue&&period==="PM"?"selected":""} onClick={()=>update(hour12,minute,"PM")}>PM</button></div></section><footer><button type="button" onClick={()=>onChange("")}>CLEAR</button><button type="button" className="done" onClick={()=>detailsRef.current?.removeAttribute("open")}>DONE</button></footer></div></details></div>;
}
const easternMarketPhase=value=>{
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:EASTERN_TZ,weekday:"short",hourCycle:"h23",hour:"2-digit",minute:"2-digit"}).formatToParts(new Date(value)).filter(part=>part.type!=="literal").map(part=>[part.type,part.value]));
  if(["Sat","Sun"].includes(parts.weekday))return "WEEKEND_CLOSED";
  const minute=Number(parts.hour)*60+Number(parts.minute);
  if(minute>=240&&minute<570)return "PREMARKET";
  if(minute>=960&&minute<1200)return "AFTER_HOURS";
  return minute>=570&&minute<960?"RTH":"CLOSED";
};
const formatAge=value=>{const seconds=Math.max(0,number(value));if(seconds<60)return `${Math.floor(seconds)}s`;const minutes=Math.floor(seconds/60),rest=Math.floor(seconds%60);return `${minutes}m ${rest}s`};
const numericEventId=(value,stream=0)=>{const date=new Date(value);if(Number.isNaN(date.getTime()))return "—";const parts=Object.fromEntries(easternIdFormatter.formatToParts(date).filter(part=>part.type!=="literal").map(part=>[part.type,part.value]));return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}${String(date.getUTCMilliseconds()).padStart(3,"0")}${String(stream).padStart(2,"0")}`};
const visibleEventId=(record,stream=0)=>record?.displayId??record?.display_id??(/^\d{17,21}$/.test(String(record?.id??""))?String(record.id):numericEventId(record?.timestamp,stream));

function deriveOptionsDecision(state) {
  if (!state) return { qualified:false, direction:"NEUTRAL", failed:[], checks:{} };
  const directionValue=number(state.direction?.value), pressure=number(state.pressure?.value);
  const rawDirection=directionValue>0?"UP":directionValue<0?"DOWN":"NEUTRAL";
  const thresholds={explosion:number(state.active_thresholds?.explosion_min,.58),direction:number(state.active_thresholds?.direction_min,2),pressure:number(state.active_thresholds?.pressure_min,.15),confidence:number(state.active_thresholds?.confidence_min,.68),risk:number(state.active_thresholds?.risk_max,.88)};
  const fallbackConfidence=(.30*number(state.explosion?.value)+.25*Math.abs(directionValue)/3+.20*Math.abs(pressure))/.75;
  const optionsConfidence=number(state.supporting_indicators?.options_confidence,fallbackConfidence);
  const derived={explosion:number(state.explosion?.value)>=thresholds.explosion,direction:Math.abs(directionValue)>=thresholds.direction,
    pressure_alignment:(rawDirection==="UP"&&pressure>=thresholds.pressure)||(rawDirection==="DOWN"&&pressure<=-thresholds.pressure),
    confidence:optionsConfidence>=thresholds.confidence,risk:number(state.risk?.value)<thresholds.risk};
  const requiredChecks=["explosion","direction","pressure_alignment","confidence","risk"];
  const hasCurrentChecks=requiredChecks.every(name=>typeof state.signal_checks?.[name]==="boolean");
  const checks=hasCurrentChecks?Object.fromEntries(requiredChecks.map(name=>[name,state.signal_checks[name]])):derived;
  const failed=Object.entries(checks).filter(([,passed])=>!passed).map(([name])=>pretty(name));
  const indicators=state.supporting_indicators??{},hasEpisode=typeof indicators.signal_lifecycle==="string";
  const direction=hasEpisode?state.options_bias:rawDirection;
  const qualified=hasEpisode?Boolean(state.options_bias_qualified):(Object.values(checks).every(Boolean)&&direction!=="NEUTRAL");
  return {qualified,direction,rawDirection,failed,checks,optionsConfidence,thresholds,
    lifecycle:indicators.signal_lifecycle??(qualified?"ACTIVE":"WAIT"),
    ageSeconds:number(indicators.signal_age_seconds),
    entryProgress:number(indicators.signal_entry_progress),
    entryRequired:number(indicators.signal_entry_required,3),
    exitProgress:number(indicators.signal_exit_progress),
    exitRequired:number(indicators.signal_exit_required,3),
    minHoldSeconds:number(indicators.signal_min_hold_seconds,60),
    rawQualified:Boolean(indicators.signal_raw_qualified??qualified)};
}

const signedGreek=value=>!Number.isFinite(Number(value))?"--":Math.abs(Number(value))<.001?Number(value).toExponential(3):`${Number(value)>0?"+":""}${Number(value).toFixed(4)}`;
const exportCell=value=>String(value??"—").replaceAll("\t"," ").replaceAll("\r"," ").replaceAll("\n"," ");
const exportTsv=(title,headers,rows)=>[title,headers.map(exportCell).join("\t"),...rows.map(row=>row.map(exportCell).join("\t"))].join("\n");

function deriveGammaDynamics(state,history=[]){
  if(state?.gamma_dynamics)return {...state.gamma_dynamics,available:true};
  const names=["zomma","color","speed","gamma"],inputs=Object.fromEntries(names.map(name=>[name,greekValue(state,name)])),available=Object.values(inputs).every(Number.isFinite);
  if(!available)return {available:false,qualified:false,decision:"NEUTRAL",intensity:0,pressure:0,history_points:history.length,inputs,percentiles:{},normalized:{},explanation:"Waiting for Zomma, Color, Speed, and Gamma."};
  const rows=history.filter(row=>row?.timestamp).slice(-100),percentile=(name,value)=>{const values=rows.map(row=>Math.abs(greekValue(row,name))).filter(Number.isFinite);if(!values.length)return 0;const target=Math.abs(value),below=values.filter(item=>item<target).length,equal=values.filter(item=>item===target).length;return Math.min(1,(below+.5*equal)/values.length)},scaled=(name,value)=>{const values=rows.map(row=>greekValue(row,name)).filter(Number.isFinite);if(!values.length)return 0;const mean=values.reduce((sum,item)=>sum+item,0)/values.length,variance=values.reduce((sum,item)=>sum+(item-mean)**2,0)/values.length,std=Math.sqrt(variance),floor=Math.max(Math.abs(mean)*1e-15,1e-18);return std<=floor?0:Math.max(-3,Math.min(3,(value-mean)/std))/3};
  const percentiles=Object.fromEntries(Object.entries(inputs).map(([name,value])=>[name,percentile(name,value)])),normalized=Object.fromEntries(Object.entries(inputs).map(([name,value])=>[name,scaled(name,value)])),intensity=(Math.abs(normalized.zomma)+Math.abs(normalized.color))/2,gammaActive=Math.abs(inputs.gamma)>1e-12,alignedUp=inputs.speed>1e-12&&gammaActive,alignedDown=inputs.speed< -1e-12&&gammaActive,pressureMagnitude=(Math.abs(normalized.speed)+Math.abs(normalized.gamma))/2,warmed=rows.length>=20,qualified=warmed&&intensity>=.65&&(alignedUp||alignedDown),decision=qualified?(alignedUp?"UP":"DOWN"):"NEUTRAL",ideal_ranges={zomma:"|normalized| >= 0.30 · IV-to-Gamma sensitivity",color:"|normalized| >= 0.30 · time-to-Gamma sensitivity",speed:"|normalized| >= 0.30 and signed with call direction",gamma:"|normalized| >= 0.30 · active curvature base"};
  return {available:true,qualified,decision,intensity,pressure:alignedUp?pressureMagnitude:alignedDown?-pressureMagnitude:0,history_points:rows.length,intensity_threshold:.65,inputs,percentiles,normalized,ideal_ranges,explanation:!warmed?`Building a relative baseline: ${rows.length}/20 observations.`:!(alignedUp||alignedDown)?"Gamma or Speed is effectively zero, so signed curvature pressure is not confirmed.":intensity<.65?"Speed has direction, but Zomma/Color intensity is below its rolling threshold.":`Speed indicates ${alignedUp?"upward":"downward"} curvature change while Gamma, Zomma, and Color confirm the environment.`};
}

function deriveGammaDynamicsV2(state,history=[]){
  if(state?.gamma_dynamics_v2)return {...state.gamma_dynamics_v2,available:true};
  const inputs=Object.fromEntries(["zomma","color","speed","gamma","ultima","vomma"].map(name=>[name,greekValue(state,name)])),available=Object.values(inputs).every(Number.isFinite);
  if(!available)return {available:false,qualified:false,decision:"NEUTRAL",intensity:0,pressure:0,history_points:history.length,inputs,percentiles:{},normalized:{},explanation:"Waiting for Zomma, Color, Speed, Gamma, Ultima, and Vomma."};
  const rows=history.filter(row=>row?.timestamp).slice(-100),percentile=(name,value)=>{const values=rows.map(row=>Math.abs(greekValue(row,name))).filter(Number.isFinite);if(!values.length)return 0;const target=Math.abs(value),below=values.filter(item=>item<target).length,equal=values.filter(item=>item===target).length;return Math.min(1,(below+.5*equal)/values.length)};
  const scaled=(name,value)=>{const values=rows.map(row=>greekValue(row,name)).filter(Number.isFinite);if(!values.length)return 0;const mean=values.reduce((sum,item)=>sum+item,0)/values.length,variance=values.reduce((sum,item)=>sum+(item-mean)**2,0)/values.length,std=Math.sqrt(variance),floor=Math.max(Math.abs(mean)*1e-15,1e-18);return std<=floor?0:Math.max(-3,Math.min(3,(value-mean)/std))/3};
  const percentiles=Object.fromEntries(Object.entries(inputs).map(([name,value])=>[name,percentile(name,value)])),normalized=Object.fromEntries(Object.entries(inputs).map(([name,value])=>[name,scaled(name,value)])),intensity=.30*Math.abs(normalized.zomma)+.25*Math.abs(normalized.color)+.25*Math.abs(normalized.ultima)+.20*Math.abs(normalized.vomma),contextConfirmed=["zomma","color","vomma","ultima"].every(name=>Math.abs(normalized[name])>=GAMMA_DYNAMICS_V2_IDEALS[name].threshold),alignedUp=normalized.speed>=GAMMA_DYNAMICS_V2_IDEALS.speed.threshold&&normalized.gamma>=GAMMA_DYNAMICS_V2_IDEALS.gamma.threshold&&inputs.speed>1e-12&&inputs.gamma>1e-12,alignedDown=normalized.speed<=-GAMMA_DYNAMICS_V2_IDEALS.speed.threshold&&normalized.gamma<=-GAMMA_DYNAMICS_V2_IDEALS.gamma.threshold&&inputs.speed< -1e-12&&inputs.gamma< -1e-12,pressureMagnitude=.45*Math.abs(normalized.speed)+.30*Math.abs(normalized.gamma)+.15*Math.abs(normalized.zomma)+.10*Math.abs(normalized.vomma),warmed=rows.length>=20,qualified=warmed&&contextConfirmed&&intensity>=.65&&(alignedUp||alignedDown),decision=qualified?(alignedUp?"UP":"DOWN"):"NEUTRAL";
  const ideal_ranges=Object.fromEntries(Object.entries(GAMMA_DYNAMICS_V2_IDEALS).map(([name,spec])=>[name,spec.description]));
  return {available:true,qualified,decision,intensity,pressure:alignedUp?pressureMagnitude:alignedDown?-pressureMagnitude:0,history_points:rows.length,intensity_threshold:.65,inputs,percentiles,normalized,ideal_ranges,explanation:!warmed?`Building a relative baseline: ${rows.length}/20 observations.`:!(alignedUp||alignedDown)?"Speed and Gamma have not reached their signed long/short thresholds in the same direction.":!contextConfirmed?"Directional curvature is present, but the Zomma/Color/Vomma/Ultima context gates are not all confirmed.":intensity<.65?"All six individual gates pass, but weighted volatility/time intensity remains below 0.65.":`Speed and Gamma indicate ${alignedUp?"upward":"downward"} curvature while Zomma, Color, Vomma, and Ultima confirm the volatility-time regime.`};
}

function deriveGammaDynamicsEvents(history,state,symbol,version=1){
  const rows=[...history];if(state?.timestamp&&!rows.some(row=>row.timestamp===state.timestamp))rows.push(state);rows.sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
  const events=[];let prior="NEUTRAL",window=[];rows.forEach(row=>{window=[...window,row].slice(-100);const result=version===2?deriveGammaDynamicsV2(row,window):deriveGammaDynamics(row,window),decision=result.qualified?result.decision:"NEUTRAL";if(decision!=="NEUTRAL"&&decision!==prior)events.push({id:numericEventId(row.timestamp,version===2?5:3),timestamp:row.timestamp,symbol:row.symbol??symbol,price:number(row?.supporting_indicators?.price,NaN),decision,intensity:result.intensity,pressure:result.pressure,normalized:result.normalized??{},...result.inputs});prior=decision});return events.reverse();
}

const SIX_GREEKS=["ultima","zomma","gamma","speed","color","delta"];
const GAMMA_DYNAMICS_GREEKS=["zomma","color","speed","gamma"];
const GAMMA_DYNAMICS_V2_GREEKS=[...GAMMA_DYNAMICS_GREEKS,"vomma","ultima"];
const GAMMA_DYNAMICS_V2_IDEALS={
  zomma:{threshold:.40,label:"|NORM| ≥ 0.400",description:"IV-to-Gamma regime confirmation"},
  color:{threshold:.35,label:"|NORM| ≥ 0.350",description:"Time-to-Gamma regime confirmation"},
  speed:{threshold:.30,label:"LONG ≥ +0.300 · SHORT ≤ -0.300",description:"Directional acceleration gate"},
  gamma:{threshold:.25,label:"LONG ≥ +0.250 · SHORT ≤ -0.250",description:"Must agree with Speed direction"},
  vomma:{threshold:.30,label:"|NORM| ≥ 0.300",description:"Volatility-convexity confirmation"},
  ultima:{threshold:.40,label:"|NORM| ≥ 0.400",description:"Volatility-instability confirmation"},
};
const gammaGreekIdeal=(name,model)=>{
  const value=number(model?.inputs?.[name]),scaled=Math.abs(number(model?.normalized?.[name]));
  if(number(model?.history_points)<20)return false;
  if(GAMMA_DYNAMICS_V2_GREEKS.every(greek=>Object.hasOwn(model?.inputs??{},greek))){
    const spec=GAMMA_DYNAMICS_V2_IDEALS[name],signed=number(model?.normalized?.[name]),speed=number(model?.normalized?.speed),direction=model?.decision==="UP"||model?.decision==="DOWN"?model.decision:(speed>=0?"UP":"DOWN");
    if(name==="speed"||name==="gamma")return direction==="UP"?signed>=spec.threshold:signed<=-spec.threshold;
    return Math.abs(signed)>=spec.threshold;
  }
  if(name==="speed")return scaled>=.3&&Math.abs(value)>1e-12&&(model?.decision==="NEUTRAL"||(model?.decision==="UP"&&value>0)||(model?.decision==="DOWN"&&value<0));
  if(name==="gamma")return scaled>=.3&&Math.abs(value)>1e-12;
  return scaled>=.3;
};
const gammaGreekIdealSpec=(name,v2)=>v2?GAMMA_DYNAMICS_V2_IDEALS[name]:{
  threshold:.30,
  label:name==="speed"?"LONG ≥ +0.300 · SHORT ≤ -0.300":"|NORM| ≥ 0.300",
  description:name==="speed"?"Must match the prospective call direction":name==="gamma"?"Must also have a non-zero raw curvature base":"Static moderate normalized-strength threshold",
};
const gammaGreekCloseness=(name,model,v2)=>{
  const spec=gammaGreekIdealSpec(name,v2),signed=number(model?.normalized?.[name]),magnitude=Math.abs(signed);
  if(v2&&(name==="speed"||name==="gamma")){
    const speed=number(model?.normalized?.speed),direction=model?.decision==="UP"||model?.decision==="DOWN"?model.decision:(speed>=0?"UP":"DOWN"),aligned=direction==="UP"?signed>=0:signed<=0;
    return aligned?Math.min(100,magnitude/spec.threshold*100):0;
  }
  return Math.min(100,magnitude/spec.threshold*100);
};
const GAMMA_RANKS=["strongest","strong","normal","weak","weakest"];
const GAMMA_CALL_STATES=[["SUCCESS","Success"],["CHILD_RESCUED","Child rescue"],["FAILED","Failed"],["TRACKING","Tracking"]];
const referenceStrike=(record,datum=NaN)=>{
  const direct=optionalNumber(record?.strike_price??record?.strike??record?.option_strike??record?.supporting_indicators?.strike_price??record?.supporting_indicators?.strike);
  return Number.isFinite(direct)?{value:direct,estimated:false}:Number.isFinite(Number(datum))?{value:Math.round(Number(datum)),estimated:true}:{value:NaN,estimated:true};
};
const sessionTargetPoints=timestamp=>timestamp&&!Number.isNaN(new Date(timestamp).getTime())&&easternMarketPhase(timestamp)==="RTH"?1.25:.25;
const reachFromDatum=(datum,direction,timestamp)=>Number.isFinite(Number(datum))?Number(datum)+(direction==="UP"?1:-1)*sessionTargetPoints(timestamp):NaN;
const gammaTargetPoints=timestamp=>{if(!timestamp||Number.isNaN(new Date(timestamp).getTime()))return .75;const parts=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:EASTERN_TZ,weekday:"short",hourCycle:"h23",hour:"2-digit",minute:"2-digit"}).formatToParts(new Date(timestamp)).filter(part=>part.type!=="literal").map(part=>[part.type,part.value])),minute=number(parts.hour)*60+number(parts.minute);return !["Sat","Sun"].includes(parts.weekday)&&minute>=570&&minute<720?1.25:.75};
const gammaReachFromDatum=(datum,direction,timestamp)=>Number.isFinite(Number(datum))?Number(datum)+(direction==="UP"?1:-1)*gammaTargetPoints(timestamp):NaN;
const greekRankings=scores=>{const ordered=Object.entries(scores??{}).sort((a,b)=>number(b[1])-number(a[1])||a[0].localeCompare(b[0])).map(([name])=>name);return {strongest:ordered.slice(0,1),strong:ordered.slice(1,2),normal:ordered.slice(2,4),weak:ordered.slice(4,5),weakest:ordered.slice(5,6)}};
const rankingText=(rankings,rank)=>{const values=rankings?.[rank]??[];return (Array.isArray(values)?values:[values]).filter(Boolean).map(pretty).join(" · ")||"—"};
function sixGreekSession(timestamp){
  const date=new Date(timestamp),parts=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:EASTERN_TZ,weekday:"short",hourCycle:"h23",hour:"2-digit",minute:"2-digit"}).formatToParts(date).filter(part=>part.type!=="literal").map(part=>[part.type,part.value]));
  const minute=number(parts.hour)*60+number(parts.minute),second=number(parts.second);
  if(["Sat","Sun"].includes(parts.weekday))return {key:"CLOSED",label:"WEEKEND",minute};
  if(minute>=240&&minute<570)return {key:"PRE_MARKET",label:"PRE-MARKET",minute};
  if(minute===570)return {key:"OPENING_AUCTION",label:"OPENING AUCTION",minute};
  if(minute>=571&&minute<630)return {key:"OPENING",label:"OPENING RANGE / DRIVE",minute};
  if(minute>=630&&minute<720)return {key:"LATE_MORNING",label:"LATE MORNING",minute};
  if(minute>=720&&minute<840)return {key:"MIDDAY",label:"MIDDAY",minute};
  if(minute>=840&&minute<900)return {key:"AFTERNOON",label:"AFTERNOON",minute};
  if(minute>=900&&minute<950)return {key:"POWER_HOUR",label:"POWER HOUR",minute};
  if(minute>=950&&minute<960)return {key:"CLOSING",label:"CLOSING IMBALANCE / POWER HOUR",minute};
  if(minute===960&&second<60)return {key:"CLOSING_AUCTION",label:"CLOSING AUCTION",minute};
  return {key:"CLOSED",label:"MARKET CLOSED",minute};
}
const sixGreekBand=value=>value>=.6?"STRONG POSITIVE":value>=.3?"MODERATE POSITIVE":value>-.3?"NEUTRAL":value>-.6?"MODERATE NEGATIVE":"STRONG NEGATIVE";
function deriveSixGreekDynamics(state,history=[]){
  if(state?.zone_intelligence){
    const zone=state.zone_intelligence,checks=Object.entries(zone.rule_checks?.[zone.zone]??{}).map(([n,p])=>({n,p}));
    return {available:true,qualified:zone.qualified,decision:zone.direction,raw_direction:zone.direction,
      zone:zone.zone,score:zone.score,alignment:zone.score,confidence:zone.confidence,
      session:{key:zone.zone,label:pretty(zone.zone).toUpperCase()},history_points:zone.history_points,
      inputs:Object.fromEntries(SIX_GREEKS.map(name=>[name,greekValue(state,name)])),scaled:zone.normalized,
      bands:zone.bands,checks,zone_scores:zone.zone_scores,active_windows:zone.active_windows,
      delta_change:zone.delta_change,gamma_change:zone.gamma_change,explanation:zone.explanation};
  }
  const inputs=Object.fromEntries(SIX_GREEKS.map(name=>[name,greekValue(state,name)])),available=Object.values(inputs).every(Number.isFinite),rows=history.filter(row=>row?.timestamp).slice(-100),session=sixGreekSession(state?.timestamp??Date.now());
  if(!available)return {available:false,qualified:false,decision:"NEUTRAL",score:0,confidence:0,session,history_points:rows.length,inputs,scaled:{},bands:{},checks:[],explanation:"Waiting for Ultima, Zomma, Gamma, Speed, Color, and Delta."};
  const stats=Object.fromEntries(SIX_GREEKS.map(name=>{const values=rows.map(row=>greekValue(row,name)).filter(Number.isFinite),mean=values.length?values.reduce((sum,value)=>sum+value,0)/values.length:0,variance=values.length?values.reduce((sum,value)=>sum+(value-mean)**2,0)/values.length:0;return [name,{mean,std:Math.sqrt(variance)}]}));
  const scaled=Object.fromEntries(SIX_GREEKS.map(name=>{const {mean,std}=stats[name],z=std>1e-15?(inputs[name]-mean)/std:0;return [name,Math.max(-3,Math.min(3,z))/3]}));
  const {ultima:U,zomma:Z,gamma:G,speed:S,color:C,delta:D}=scaled,recent=rows.slice(-5);
  const recentScaledDelta=recent.map(row=>{const value=greekValue(row,"delta"),{mean,std}=stats.delta;return std>1e-15?Math.max(-3,Math.min(3,(value-mean)/std))/3:0}).filter(Number.isFinite);
  const deltaChange=recentScaledDelta.length?D-recentScaledDelta[0]:0,previous=rows.at(-1);
  const previousGamma=previous?(()=>{const value=greekValue(previous,"gamma"),{mean,std}=stats.gamma;return std>1e-15?Math.max(-3,Math.min(3,(value-mean)/std))/3:0})():G;
  const gammaChange=G-previousGamma,deltaSignChanged=recentScaledDelta.some(value=>Math.sign(value)&&Math.sign(value)!==Math.sign(D));
  const definitions=[
    ["PRE_MARKET",session.key==="PRE_MARKET",[{n:"|U| ≥ 0.5",p:Math.abs(U)>=.5},{n:"|Z| ≥ 0.5",p:Math.abs(Z)>=.5},{n:"|G| ≤ 0.2",p:Math.abs(G)<=.2},{n:"|S| ≤ 0.2",p:Math.abs(S)<=.2},{n:"C ≥ 0.3",p:C>=.3},{n:"|D| ≤ 0.3",p:Math.abs(D)<=.3}]],
    ["OPENING_AUCTION",session.key==="OPENING_AUCTION",[{n:"G ≤ -0.4",p:G<=-.4},{n:"S ≥ 0.7",p:S>=.7},{n:"C ≤ -0.5",p:C<=-.5},{n:"Z ≤ -0.4",p:Z<=-.4},{n:"U ≥ 0.7",p:U>=.7},{n:"|D| ≤ 0.4",p:Math.abs(D)<=.4}]],
    ["OPENING_RANGE",session.key==="OPENING"&&session.minute<600,[{n:"G ≤ -0.3",p:G<=-.3},{n:"S ≥ 0.5",p:S>=.5},{n:"C ≤ -0.3",p:C<=-.3},{n:"Z ≤ -0.3",p:Z<=-.3},{n:"U ≥ 0.5",p:U>=.5},{n:"|D| ≥ 0.3",p:Math.abs(D)>=.3}]],
    ["OPENING_DRIVE",session.key==="OPENING",[{n:"|D| ≥ 0.7",p:Math.abs(D)>=.7},{n:"S ≥ 0.6",p:S>=.6},{n:"C ≥ 0.3",p:C>=.3},{n:"-0.3 ≤ G ≤ 0.3",p:G>=-.3&&G<=.3},{n:"|Z| ≤ 0.3",p:Math.abs(Z)<=.3},{n:"|U| ≤ 0.4",p:Math.abs(U)<=.4}]],
    ["LATE_MORNING",session.key==="LATE_MORNING",[{n:"|D| ≥ 0.4",p:Math.abs(D)>=.4},{n:"|ΔD| ≤ 0.2",p:Math.abs(deltaChange)<=.2},{n:"G ≥ 0.3",p:G>=.3},{n:"S ≤ 0.3",p:S<=.3},{n:"C ≥ 0.3",p:C>=.3},{n:"Z ≥ 0.3",p:Z>=.3},{n:"U ≤ 0.3",p:U<=.3}]],
    ["MIDDAY",session.key==="MIDDAY",[{n:"|D| ≤ 0.2",p:Math.abs(D)<=.2},{n:"G ≥ 0.6",p:G>=.6},{n:"|S| ≤ 0.2",p:Math.abs(S)<=.2},{n:"C ≥ 0.6",p:C>=.6},{n:"Z ≥ 0.6",p:Z>=.6},{n:"U ≤ 0.2",p:U<=.2}]],
    ["AFTERNOON",session.key==="AFTERNOON",[{n:"G ≤ -0.3",p:G<=-.3},{n:"S ≥ 0.4",p:S>=.4},{n:"C ≤ -0.3",p:C<=-.3},{n:"Z ≤ -0.3",p:Z<=-.3},{n:"U ≥ 0.4",p:U>=.4},{n:"|D| ≥ 0.3",p:Math.abs(D)>=.3}]],
    ["CLOSING_IMBALANCE",session.key==="CLOSING",[{n:"|ΔG| ≥ 0.5",p:Math.abs(gammaChange)>=.5},{n:"S ≥ 0.5",p:S>=.5},{n:"C ≤ -0.3",p:C<=-.3},{n:"Z ≥ 0.4",p:Z>=.4},{n:"U ≥ 0.7",p:U>=.7},{n:"|D| ≤ 0.4 or flip",p:Math.abs(D)<=.4||deltaSignChanged}]],
    ["POWER_HOUR",session.key==="POWER_HOUR"||session.key==="CLOSING",[{n:"|D| ≥ 0.7",p:Math.abs(D)>=.7},{n:"S ≥ 0.7",p:S>=.7},{n:"C ≥ 0.3",p:C>=.3},{n:"-0.3 ≤ G ≤ 0.3",p:G>=-.3&&G<=.3},{n:"|Z| ≤ 0.3",p:Math.abs(Z)<=.3},{n:"U ≥ 0.4",p:U>=.4}]],
    ["CLOSING_AUCTION",session.key==="CLOSING_AUCTION",[{n:"G ≥ 0.6",p:G>=.6},{n:"S ≤ 0.2",p:S<=.2},{n:"C ≥ 0.6",p:C>=.6},{n:"Z ≥ 0.4",p:Z>=.4},{n:"U ≤ 0.2",p:U<=.2},{n:"|D| ≤ 0.2",p:Math.abs(D)<=.2}]],
  ];
  const candidates=definitions.filter(([,active])=>active).map(([zone,,checks])=>({zone,checks,score:checks.filter(check=>check.p).length/checks.length})),match=candidates.find(candidate=>candidate.checks.every(check=>check.p)),best=candidates.sort((a,b)=>b.score-a.score)[0];
  const warmed=rows.length>=20,zone=warmed&&match?match.zone:"NO_ZONE",checks=match?.checks??best?.checks??[],score=match?.score??best?.score??0,rawDirection=Math.abs(D)>=.3?(D>0?"UP":"DOWN"):Math.abs(S)>=.3?(S>0?"UP":"DOWN"):"NEUTRAL",qualified=warmed&&Boolean(match)&&rawDirection!=="NEUTRAL";
  const confidence=qualified?Math.min(1,.55+.45*score):score*.5,bands=Object.fromEntries(SIX_GREEKS.map(name=>[name,sixGreekBand(scaled[name])]));
  const explanation=!warmed?`Building the rolling z-score baseline: ${rows.length}/20 observations.`:match?`${match.zone.replaceAll("_"," ")} formula passed all ${match.checks.length} gates.`:best?`${best.zone.replaceAll("_"," ")} is the active candidate; ${best.checks.filter(check=>check.p).length}/${best.checks.length} gates pass.`:`No zone formula is active during ${session.label}.`;
  return {available:true,qualified,decision:qualified?rawDirection:"NEUTRAL",raw_direction:rawDirection,zone,score,alignment:score,confidence,session,history_points:rows.length,inputs,scaled,bands,stats,checks,delta_change:deltaChange,gamma_change:gammaChange,explanation};
}
function deriveSixGreekEvents(history,state,symbol){
  const rows=[...history];if(state?.timestamp&&!rows.some(row=>row.timestamp===state.timestamp))rows.push(state);rows.sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
  const events=[];let prior="NO_ZONE",window=[];rows.forEach(row=>{const result=deriveSixGreekDynamics(row,window),decision=result.qualified?result.decision:"NEUTRAL";if(result.qualified&&result.zone!==prior){const datum=number(row?.supporting_indicators?.price,NaN),strike=referenceStrike(row,datum);events.push({id:numericEventId(row.timestamp,4),timestamp:row.timestamp,symbol:row.symbol??symbol,datum,strike,reach:reachFromDatum(datum,decision,row.timestamp),decision,zone:result.zone,score:result.score,confidence:result.confidence,session:result.session,scaled:result.scaled,...result.inputs})}prior=result.qualified?result.zone:"NO_ZONE";window=[...window,row].slice(-100)});return events.reverse();
}

const FORECAST_GREEKS=["delta","gamma","vanna","charm","speed","zomma","color","ultima"];
function forecastVector(row){const indicators=row?.supporting_indicators??{};return [number(row?.explosion?.value),number(row?.direction?.value)/3,number(row?.pressure?.value),number(indicators.options_confidence),number(row?.risk?.value),number(row?.dealer_hedging?.value),...FORECAST_GREEKS.map(name=>number(indicators[`greek_${name}`]))]}
function deriveFiveMinuteForecast(history,state){
  const rows=[...history.filter(row=>row?.timestamp&&Number.isFinite(number(row?.supporting_indicators?.price,NaN)))];
  if(state?.timestamp&&Number.isFinite(number(state?.supporting_indicators?.price,NaN))&&!rows.some(row=>row.timestamp===state.timestamp))rows.push(state);
  rows.sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
  const samples=[];
  for(let index=0;index<rows.length-1;index++){const start=new Date(rows[index].timestamp).getTime(),horizon=start+300000,price=number(rows[index].supporting_indicators.price);let label="WAIT",complete=false,move=0;for(let future=index+1;future<rows.length;future++){const timestamp=new Date(rows[future].timestamp).getTime();if(timestamp>horizon){complete=true;break}const delta=number(rows[future].supporting_indicators.price)-price;if(Math.abs(delta)>Math.abs(move))move=delta;if(delta>=30){label="UP";complete=true;break}if(delta<=-30){label="DOWN";complete=true;break}}if(complete)samples.push({features:forecastVector(rows[index]),label,move})}
  const current=state??rows.at(-1),price=number(current?.supporting_indicators?.price,NaN),eventCount=samples.filter(sample=>sample.label!=="WAIT").length;
  if(!current||!Number.isFinite(price)||samples.length<120)return {ready:false,label:"WAIT",price,samples:samples.length,eventCount,reason:`Need ${Math.max(0,120-samples.length)} more fully labeled five-minute observations.`};
  const width=samples[0].features.length,means=Array.from({length:width},(_,column)=>samples.reduce((sum,sample)=>sum+sample.features[column],0)/samples.length),scales=Array.from({length:width},(_,column)=>Math.sqrt(samples.reduce((sum,sample)=>sum+(sample.features[column]-means[column])**2,0)/samples.length)||1),query=forecastVector(current);
  const ranked=samples.map(sample=>({label:sample.label,distance:Math.sqrt(sample.features.reduce((sum,value,column)=>sum+((value-query[column])/scales[column])**2,0))})).sort((a,b)=>a.distance-b.distance),neighbors=ranked.slice(0,Math.min(41,ranked.length)),weights={UP:0,DOWN:0,WAIT:0};
  neighbors.forEach(neighbor=>weights[neighbor.label]+=1/(neighbor.distance+.15));const total=weights.UP+weights.DOWN+weights.WAIT||1,probabilities=Object.fromEntries(Object.entries(weights).map(([label,value])=>[label,value/total])),label=Object.entries(probabilities).sort((a,b)=>b[1]-a[1])[0][0];
  return {ready:true,label,price,samples:samples.length,eventCount,neighbors:neighbors.length,probabilities,confidence:probabilities[label],reason:eventCount?"Nearest historical options-pressure states with observed five-minute outcomes.":"No 30-point event exists in the loaded labeled history; WAIT is the only observed class."};
}

function Sparkline({ values = [], color = "#4de0bd", fill = true }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const data = values.length > 1 ? values.map(Number) : [0, 0];
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 240;
    const height = canvas.clientHeight || 72;
    canvas.width = width * dpr; canvas.height = height * dpr;
    const ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, width, height);
    const min = Math.min(...data), max = Math.max(...data), pad = 4;
    const pts = data.map((v, i) => [pad + i * (width - pad * 2) / (data.length - 1), height - pad - (v - min) / (max - min || 1) * (height - pad * 2)]);
    if (fill) {
      const grad = ctx.createLinearGradient(0, 0, 0, height); grad.addColorStop(0, `${color}44`); grad.addColorStop(1, `${color}00`);
      ctx.beginPath(); ctx.moveTo(pts[0][0], height); pts.forEach(p => ctx.lineTo(...p)); ctx.lineTo(pts.at(-1)[0], height); ctx.fillStyle = grad; ctx.fill();
    }
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(...p) : ctx.moveTo(...p)); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
  }, [values, color, fill]);
  return <canvas className="sparkline" ref={ref} />;
}

function PriceChart({ history = [] }) {
  const prices = history.map(row => number(row.supporting_indicators?.price)).filter(Boolean);
  return <div className="live-price-chart"><Sparkline values={prices} color="#4de0bd" />
    {!prices.length && <div className="empty-state">Waiting for the first ThetaData market state…</div>}
  </div>;
}

const ALL_GREEKS = Object.values(GREEK_ORDERS).flatMap(order => order.series.map(([name, color]) => [name, color]));

function aggregateGreekRows(history, state, symbol, intervalSeconds) {
  const source=[...history.filter(row=>row.symbol===symbol)];
  if(state?.symbol===symbol){const index=source.findIndex(row=>row.timestamp===state.timestamp);if(index>=0)source[index]=state;else source.push(state)}
  const unique=[...new Map(source.filter(row=>row.timestamp).map(row=>[row.timestamp,row])).values()].sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
  const buckets=new Map();
  unique.forEach((row,rowIndex)=>{
    const bucketMs=Math.floor(new Date(row.timestamp).getTime()/(intervalSeconds*1000))*intervalSeconds*1000;
    if(!Number.isFinite(bucketMs))return;
    const bucket=buckets.get(bucketMs)??{timestamp:new Date(bucketMs).toISOString(),symbol,sums:{},counts:{}};
    ALL_GREEKS.forEach(([name])=>{const value=greekValue(row,name);if(Number.isFinite(value)){bucket.sums[name]=(bucket.sums[name]??0)+value;bucket.counts[name]=(bucket.counts[name]??0)+1}});
    const normalized=row?.zone_intelligence?.normalized??deriveSixGreekDynamics(row,unique.slice(Math.max(0,rowIndex-100),rowIndex)).scaled??{};
    SIX_GREEKS.forEach(name=>{const value=optionalNumber(normalized[name]);if(Number.isFinite(value)){const key=`normalized_${name}`;bucket.sums[key]=(bucket.sums[key]??0)+value;bucket.counts[key]=(bucket.counts[key]??0)+1}});
    buckets.set(bucketMs,bucket);
  });
  return [...buckets.values()].map(bucket=>({timestamp:bucket.timestamp,symbol,supporting_indicators:Object.fromEntries(ALL_GREEKS.map(([name])=>[`greek_${name}`,bucket.counts[name]?bucket.sums[name]/bucket.counts[name]:null])),zone_intelligence:{normalized:Object.fromEntries(SIX_GREEKS.map(name=>{const key=`normalized_${name}`;return [name,bucket.counts[key]?bucket.sums[key]/bucket.counts[key]:null]}))}}));
}

function useGreekViewport(history,state,symbol,intervalSeconds,visibleCount=96){
  const [offset,setOffset]=useState(0);
  const rows=useMemo(()=>aggregateGreekRows(history,state,symbol,intervalSeconds),[history,state,symbol,intervalSeconds]);
  useEffect(()=>setOffset(0),[symbol,intervalSeconds]);
  const maxOffset=Math.max(0,rows.length-visibleCount),safeOffset=Math.min(offset,maxOffset),end=rows.length-safeOffset;
  const visible=rows.slice(Math.max(0,end-visibleCount),end);
  const move=amount=>setOffset(current=>Math.max(0,Math.min(maxOffset,Math.min(current,maxOffset)+amount)));
  return {rows,visible,offset:safeOffset,setOffset,move,isLive:safeOffset===0,maxOffset};
}

function useScoreViewport(history,state,symbol,intervalSeconds,visibleCount=96){
  const [offset,setOffset]=useState(0);
  const rows=useMemo(()=>{
    const source=[...history.filter(row=>row.symbol===symbol)];
    if(state?.symbol===symbol){const index=source.findIndex(row=>row.timestamp===state.timestamp);if(index>=0)source[index]=state;else source.push(state)}
    const unique=[...new Map(source.filter(row=>row.timestamp).map(row=>[row.timestamp,row])).values()].sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
    const buckets=new Map();
    unique.forEach((row,rowIndex)=>{const bucket=Math.floor(new Date(row.timestamp).getTime()/(intervalSeconds*1000))*intervalSeconds*1000;if(Number.isFinite(bucket))buckets.set(bucket,row)});
    return [...buckets.entries()].map(([bucket,row])=>({...row,timestamp:new Date(bucket).toISOString()}));
  },[history,state,symbol,intervalSeconds]);
  useEffect(()=>setOffset(0),[symbol,intervalSeconds]);
  const maxOffset=Math.max(0,rows.length-visibleCount),safeOffset=Math.min(offset,maxOffset),end=rows.length-safeOffset,visible=rows.slice(Math.max(0,end-visibleCount),end);
  const move=amount=>setOffset(current=>Math.max(0,Math.min(maxOffset,Math.min(current,maxOffset)+amount)));
  return {rows,visible,offset:safeOffset,setOffset,move,isLive:safeOffset===0,maxOffset};
}

function ChartShell({expanded,setExpanded,children,className=""}){
  const shellRef=useRef(null);
  useEffect(()=>{if(!expanded)return;const previousOverflow=document.body.style.overflow;document.body.style.overflow="hidden";const svg=shellRef.current?.querySelector(".greek-chart-stage svg"),previousAspect=svg?.getAttribute("preserveAspectRatio");svg?.setAttribute("preserveAspectRatio","none");const close=event=>event.key==="Escape"&&setExpanded(false);window.addEventListener("keydown",close);return()=>{document.body.style.overflow=previousOverflow;if(svg){if(previousAspect===null)svg.removeAttribute("preserveAspectRatio");else svg.setAttribute("preserveAspectRatio",previousAspect)}window.removeEventListener("keydown",close)}},[expanded,setExpanded]);
  const chart=<div ref={shellRef} className={`expandable-chart ${expanded?"chart-expanded":""} ${className}`}>{children}</div>;
  return expanded?createPortal(<div className="chart-modal-backdrop" role="dialog" aria-modal="true" aria-label="Expanded live Greek graph">{chart}</div>,document.body):chart;
}

function ChartTimeControls({intervalSeconds,setIntervalSeconds,isLive,setOffset,expanded,setExpanded,zoom,onZoom}){
  const changeZoom=amount=>onZoom(amount);
  return <div className="greek-chart-controls"><div className="timeframe-buttons" aria-label="Chart aggregation interval">{CHART_INTERVALS.map(([label,seconds])=><button type="button" key={label} className={intervalSeconds===seconds?"active":""} onClick={()=>setIntervalSeconds(seconds)}>{label}</button>)}</div><div className="chart-zoom" aria-label="Coordinate zoom"><button type="button" onClick={()=>changeZoom(-.5)} disabled={zoom<=1}>−</button><span>{zoom.toFixed(1)}×</span><button type="button" onClick={()=>changeZoom(.5)} disabled={zoom>=8}>+</button><button type="button" className="zoom-reset" onClick={()=>changeZoom(1-zoom)} disabled={zoom===1}>RESET</button></div><button type="button" className={`return-live ${isLive?"is-live":"is-back"}`} onClick={()=>setOffset(0)}>{isLive?"● LIVE":"↪ RETURN LIVE"}</button><button type="button" className="expand-chart" onClick={event=>{event.stopPropagation();setExpanded(!expanded)}}>{expanded?"↙ MINIMIZE":"↗ EXPAND"}</button></div>;
}

function chartCursor(event,dims,rowCount,maxAbs){
  const bounds=event.currentTarget.getBoundingClientRect(),svgX=(event.clientX-bounds.left)/Math.max(bounds.width,1)*dims.width,svgY=(event.clientY-bounds.top)/Math.max(bounds.height,1)*dims.height;
  const plotWidth=dims.width-dims.left-dims.right,plotHeight=dims.height-dims.top-dims.bottom,clampedX=Math.max(dims.left,Math.min(dims.width-dims.right,svgX)),clampedY=Math.max(dims.top,Math.min(dims.height-dims.bottom,svgY));
  return {index:Math.max(0,Math.min(rowCount-1,Math.round((clampedX-dims.left)/Math.max(plotWidth,1)*Math.max(rowCount-1,0)))),value:maxAbs-(clampedY-dims.top)/Math.max(plotHeight,1)*maxAbs*2,left:(clampedX/dims.width)*100,top:(clampedY/dims.height)*100};
}

function chartCursorRange(event,dims,rowCount,minValue,maxValue){
  const cursor=chartCursor(event,dims,rowCount,1),bounds=event.currentTarget.getBoundingClientRect(),svgY=(event.clientY-bounds.top)/Math.max(bounds.height,1)*dims.height,plotHeight=dims.height-dims.top-dims.bottom,clampedY=Math.max(dims.top,Math.min(dims.height-dims.bottom,svgY));
  return {...cursor,value:maxValue-(clampedY-dims.top)/Math.max(plotHeight,1)*(maxValue-minValue)};
}

function greekSignedScale(values){
  const finite=values.filter(Number.isFinite),absolute=finite.map(Math.abs),nonZero=absolute.filter(value=>value>0).sort((a,b)=>a-b);
  const rawMax=Math.max(...absolute,1e-12),constant=Math.max(nonZero[Math.floor(nonZero.length*.2)]??rawMax,rawMax*1e-6,1e-12);
  const project=value=>Math.sign(number(value))*Math.log1p(Math.abs(number(value))/constant);
  const unproject=value=>Math.sign(number(value))*constant*Math.expm1(Math.abs(number(value)));
  const projectedMax=Math.max(project(rawMax),1);
  return {projectedMax,project,unproject};
}

function ChartHistoryNavigator({viewport}){
  const position=viewport.maxOffset-viewport.offset;
  const step=Math.max(1,Math.round(viewport.maxOffset*.05));
  return <div className="chart-history"><button type="button" disabled={!viewport.maxOffset||viewport.offset>=viewport.maxOffset} onClick={()=>viewport.move(step)}>← OLDER</button><input type="range" min="0" max={Math.max(1,viewport.maxOffset)} value={viewport.maxOffset?position:1} disabled={!viewport.maxOffset} onChange={event=>viewport.setOffset(viewport.maxOffset-Number(event.target.value))} aria-label="Scroll through previously streamed chart data"/><button type="button" disabled={!viewport.offset} onClick={()=>viewport.move(-step)}>NEWER →</button><button type="button" className={viewport.isLive?"is-live":"is-back"} onClick={()=>viewport.setOffset(0)}>{viewport.isLive?"LIVE · NOW":"RETURN LIVE"}</button><b>{viewport.offset?`${viewport.offset} buckets back`:"Following current stream"}</b></div>;
}

function ChartCoordinateTooltip({cursor,row,series,formatTime,formatValue,seriesValue,cursorValueText}){
  if(!cursor||!row)return null;
  return <div className="chart-coordinate-tooltip" style={{left:`${cursor.left}%`,top:`${Math.max(16,Math.min(82,cursor.top))}%`,transform:cursor.left>68?"translate(calc(-100% - 12px),-50%)":"translate(12px,-50%)"}}><b>{formatTime(row.timestamp)}</b><span>{cursorValueText?cursorValueText(cursor.value):`Cursor Y ${formatValue(cursor.value)}`}</span>{series.map(([name,color])=><span key={name}><i style={{backgroundColor:color}}/>{pretty(name)} {formatValue(seriesValue(row,name))}</span>)}</div>;
}

function GreekOrderChart({ history = [], state, symbol }) {
  const [order,setOrder]=useState("first"),[intervalSeconds,setIntervalSeconds]=useState(5),[expanded,setExpanded]=useState(false),[zoom,setZoom]=useState(1);
  const [cursor,setCursor]=useState(null);
  const drag=useRef(null),config=GREEK_ORDERS[order];
  const viewport=useGreekViewport(history,state,symbol,intervalSeconds,Math.max(12,Math.round((expanded?120:96)/zoom))),rows=viewport.visible;
  const dims={width:1200,height:expanded?Math.max(760,config.series.length*145+70):Math.max(500,config.series.length*112+60),left:138,right:30,top:20,bottom:58};
  const plotWidth=dims.width-dims.left-dims.right,plotHeight=dims.height-dims.top-dims.bottom;
  const seriesValue=(row,name)=>greekValue(row,name);
  const values=rows.flatMap(row=>config.series.map(([name])=>seriesValue(row,name))).filter(Number.isFinite);
  const latestValues=config.series.map(([name])=>seriesValue(rows.at(-1),name));
  const liveSeriesCount=latestValues.filter(Number.isFinite).length;
  const missingSeries=latestValues.filter(value=>!Number.isFinite(value)).length;
  const rejectedFirstOrder=order==="first"&&latestValues.length>0&&latestValues.every(value=>Number.isFinite(value)&&Math.abs(value)<1e-15);
  const seriesRanges=Object.fromEntries(config.series.map(([name])=>{
    const seriesValues=rows.map(row=>seriesValue(row,name)).filter(Number.isFinite),minimum=seriesValues.length?Math.min(...seriesValues):0,maximum=seriesValues.length?Math.max(...seriesValues):0;
    const rawRange=maximum-minimum,center=(maximum+minimum)/2,padding=Math.max(rawRange*.12,Math.abs(center)*.0005,1e-12);
    return [name,{minimum:minimum-padding,maximum:maximum+padding,changing:rawRange>Math.max(Math.abs(center)*1e-9,1e-15)}];
  }));
  const changingSeriesCount=config.series.filter(([name])=>seriesRanges[name].changing).length;
  const x=index=>dims.left+index*plotWidth/Math.max(1,rows.length-1);
  const laneHeight=plotHeight/Math.max(config.series.length,1);
  const y=(value,name)=>{const laneIndex=config.series.findIndex(([seriesName])=>seriesName===name),range=seriesRanges[name],laneTop=dims.top+laneIndex*laneHeight+9,laneBottom=dims.top+(laneIndex+1)*laneHeight-9;return laneTop+(range.maximum-value)*(laneBottom-laneTop)/Math.max(range.maximum-range.minimum,1e-15)};
  const formatValue=value=>{const parsed=optionalNumber(value);if(!Number.isFinite(parsed))return "—";const magnitude=Math.abs(parsed);return magnitude>0&&magnitude<.01?parsed.toExponential(3):parsed.toFixed(4)};
  const formatTime=chartTime;
  const hovered=rows[cursor?.index??rows.length-1];
  const zoomChart=(amount,anchorIndex=cursor?.index??rows.length-1)=>{const next=Math.max(1,Math.min(8,Math.round((zoom+amount)*2)/2));if(next===zoom)return;const fraction=rows.length>1?anchorIndex/(rows.length-1):1,globalIndex=viewport.rows.length-viewport.offset-rows.length+anchorIndex,nextCount=Math.max(12,Math.round((expanded?120:96)/next)),nextIndex=Math.round(fraction*Math.max(nextCount-1,0)),nextOffset=Math.max(0,Math.min(Math.max(0,viewport.rows.length-nextCount),viewport.rows.length-(globalIndex-nextIndex+nextCount)));setZoom(next);viewport.setOffset(nextOffset);setCursor(current=>current?{...current,index:nextIndex}:current)};
  const onPointerMove=event=>{const next=chartCursor(event,dims,rows.length,1);setCursor(next);if(drag.current){const delta=event.clientX-drag.current.x;if(Math.abs(delta)>3)drag.current.moved=true;viewport.setOffset(Math.max(0,Math.min(viewport.maxOffset,drag.current.offset-Math.round(delta/7))))}};
  const onPointerDown=event=>{drag.current={x:event.clientX,offset:viewport.offset,moved:false};event.currentTarget.setPointerCapture(event.pointerId)};
  const onPointerUp=()=>{if(!expanded&&!drag.current?.moved)setExpanded(true);drag.current=null};
  return <ChartShell expanded={expanded} setExpanded={setExpanded} className={`greek-order-chart order-${order}`}>
    <div className="greek-chart-header"><div><span>LIVE OPTIONS GREEKS</span><h2>{symbol} · OI-weighted chain Greeks</h2></div><div className="greek-header-actions"><div className="greek-order-tabs" role="tablist">{Object.entries(GREEK_ORDERS).map(([key,item])=><button role="tab" aria-selected={order===key} className={order===key?"active":""} key={key} onClick={()=>{setOrder(key);setCursor(null)}}>{item.label}</button>)}</div><ChartTimeControls {...{intervalSeconds,setIntervalSeconds,isLive:viewport.isLive,setOffset:viewport.setOffset,expanded,setExpanded,zoom,onZoom:zoomChart}}/></div></div>
    <div className="greek-stream-status" aria-live="polite"><span className={viewport.isLive&&liveSeriesCount?"is-live":"is-waiting"}>● {viewport.isLive&&liveSeriesCount?"STREAMING":"WAITING"}</span><b>{liveSeriesCount}/{config.series.length} series · {rows.length} points · {changingSeriesCount} changing</b><small>{rows.length?`Latest ${formatTime(rows.at(-1)?.timestamp)}`:"No observations yet"}</small></div>
    <div className="greek-chart-legend">{config.series.map(([name,color])=><div key={name}><i style={{backgroundColor:color}}/><span>{pretty(name)}</span><b>{formatValue(seriesValue(rows.at(-1)??{},name))}</b></div>)}</div>
    <div className="first-order-scale-note">SEPARATE VISIBLE-RANGE LANES · every line expands its real minimum-to-maximum movement · legend and hover values remain actual ThetaData values</div>
    {(missingSeries>0||rejectedFirstOrder)&&<div className={`greek-data-warning ${rejectedFirstOrder?"error":""}`} role="status">{rejectedFirstOrder?"ThetaData supplied zero for every first-order Greek in this snapshot. The engine continues streaming the other orders, but does not invent first-order values. Check market hours and the live engine error/status details.":`${missingSeries} ${config.label} series unavailable in the latest persisted state. Missing history is not converted to zero.`}</div>}
    <div className="greek-chart-stage" style={{height:dims.height,minHeight:dims.height}} onWheel={event=>{event.preventDefault();const anchor=chartCursor(event,dims,rows.length,1);setCursor(anchor);if(event.shiftKey)viewport.move(event.deltaY>0?10:-10);else zoomChart(event.deltaY<0?.5:-.5,anchor.index)}} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={()=>{drag.current=null}} onPointerLeave={()=>{drag.current=null;setCursor(null)}}>
      <svg viewBox={`0 0 ${dims.width} ${dims.height}`} role="img" aria-label={`${config.label} live options Greeks over time with signed exposure on the y axis`}>
        <title>{config.label} live options Greeks for {symbol}</title><desc>The horizontal axis is observation time. Every Greek uses a separate real-value lane.</desc>
        {config.series.flatMap(([name,color],laneIndex)=>{const range=seriesRanges[name],laneTop=dims.top+laneIndex*laneHeight,laneBottom=dims.top+(laneIndex+1)*laneHeight,laneMiddle=(laneTop+laneBottom)/2;return <g key={`lane-${name}`}><rect className="first-order-lane" x={dims.left} y={laneTop} width={plotWidth} height={laneHeight}/><text className="first-order-lane-name" x="14" y={laneMiddle+5} style={{fill:color}}>{name.toUpperCase()}</text>{[range.maximum,(range.maximum+range.minimum)/2,range.minimum].map((tickValue,tickIndex)=>{const yy=[laneTop+9,laneMiddle,laneBottom-9][tickIndex];return <g key={`${name}-${tickIndex}`}><line className="greek-grid" x1={dims.left} x2={dims.width-dims.right} y1={yy} y2={yy}/><text className="greek-axis" x={dims.left-10} y={yy+4} textAnchor="end">{formatValue(tickValue)}</text></g>})}</g>})}
        {[0,1,2,3,4,5].map(tick=>{const index=Math.round(tick*Math.max(rows.length-1,0)/5),xx=x(index);return <g key={`gx-${tick}`}><line className="greek-grid" x1={xx} x2={xx} y1={dims.top} y2={dims.height-dims.bottom}/><text className="greek-axis" x={xx} y={dims.height-15} textAnchor="middle">{formatTime(rows[index]?.timestamp)}</text></g>})}
        {config.series.map(([name,color],seriesIndex)=>{let drawing=false;const path=rows.map((row,index)=>{const value=seriesValue(row,name);if(!Number.isFinite(value)){drawing=false;return ""}const command=drawing?"L":"M";drawing=true;return `${command}${x(index).toFixed(1)},${y(value,name).toFixed(1)}`}).filter(Boolean).join(" "),latest=seriesValue(rows.at(-1),name);return <g key={name}><path className="greek-series" d={path} style={{stroke:color}}/>{Number.isFinite(latest)&&<circle className="greek-current-dot" cx={x(rows.length-1)} cy={y(latest,name)} r={3.5+seriesIndex*.35} style={{fill:color}}/>}</g>})}
        {cursor&&<g><line className="greek-crosshair" x1={x(cursor.index)} x2={x(cursor.index)} y1={dims.top} y2={dims.height-dims.bottom}/>{config.series.map(([name,color])=>{const value=seriesValue(hovered,name);return Number.isFinite(value)?<circle key={name} className="greek-hover-dot" cx={x(cursor.index)} cy={y(value,name)} r="4" style={{fill:color}}/>:null})}</g>} 
      </svg>
      <ChartCoordinateTooltip {...{cursor,row:hovered,series:config.series,formatTime,formatValue,seriesValue}} cursorValueText={()=>"Actual values by lane"}/>
      {!rows.length&&<div className="chart-empty">Waiting for the first live Options Pro state…</div>}
    </div>
    <ChartHistoryNavigator viewport={viewport}/><div className="greek-chart-readout"><span>Wheel: zoom at cursor · Shift+wheel/drag: history</span><span>{viewport.isLive?"Following current stream":`${viewport.offset} buckets behind live`}</span><span>X · {formatTime(hovered?.timestamp)}</span>{config.series.map(([name,color])=><span key={name}><i style={{backgroundColor:color}}/>{pretty(name)} Y · {formatValue(seriesValue(hovered??{},name))}</span>)}</div>
  </ChartShell>;
}

function ScoreTimeChart({history=[],state,symbol,metric}){
  const config=metric==="explosion"?{title:"EXPLOSION SCORE",color:"#4de0bd",min:0,max:1,threshold:number(state?.active_thresholds?.explosion_min,.58),format:value=>number(value).toFixed(2)}:{title:"DIRECTION SCORE",color:"#86a7ff",min:-3,max:3,threshold:number(state?.active_thresholds?.direction_min,2),format:value=>`${number(value)>0?"+":""}${number(value).toFixed(0)}`};
  const [intervalSeconds,setIntervalSeconds]=useState(5),[expanded,setExpanded]=useState(false),[zoom,setZoom]=useState(1),[cursor,setCursor]=useState(null);
  const drag=useRef(null),viewport=useScoreViewport(history,state,symbol,intervalSeconds,Math.max(12,Math.round((expanded?140:84)/zoom))),rows=viewport.visible;
  const dims={width:1200,height:expanded?700:380,left:106,right:34,top:26,bottom:68},plotWidth=dims.width-dims.left-dims.right,plotHeight=dims.height-dims.top-dims.bottom;
  const seriesValue=row=>number(row?.[metric]?.value,NaN),x=index=>dims.left+index*plotWidth/Math.max(1,rows.length-1),y=value=>dims.top+(config.max-value)*plotHeight/Math.max(config.max-config.min,1e-9);
  const formatTime=chartTime,hovered=rows[cursor?.index??rows.length-1];
  const zoomChart=(amount,anchorIndex=cursor?.index??rows.length-1)=>{const next=Math.max(1,Math.min(8,Math.round((zoom+amount)*2)/2));if(next===zoom)return;const fraction=rows.length>1?anchorIndex/(rows.length-1):1,globalIndex=viewport.rows.length-viewport.offset-rows.length+anchorIndex,nextCount=Math.max(12,Math.round((expanded?140:84)/next)),nextIndex=Math.round(fraction*Math.max(nextCount-1,0)),nextOffset=Math.max(0,Math.min(Math.max(0,viewport.rows.length-nextCount),viewport.rows.length-(globalIndex-nextIndex+nextCount)));setZoom(next);viewport.setOffset(nextOffset);setCursor(current=>current?{...current,index:nextIndex}:current)};
  const cursorAt=event=>chartCursorRange(event,dims,rows.length,config.min,config.max);
  const onPointerMove=event=>{const next=cursorAt(event);setCursor(next);if(drag.current){const delta=event.clientX-drag.current.x;if(Math.abs(delta)>3)drag.current.moved=true;viewport.setOffset(Math.max(0,Math.min(viewport.maxOffset,drag.current.offset-Math.round(delta/7))))}};
  const onPointerDown=event=>{drag.current={x:event.clientX,offset:viewport.offset,moved:false};event.currentTarget.setPointerCapture(event.pointerId)},onPointerUp=()=>{if(!expanded&&!drag.current?.moved)setExpanded(true);drag.current=null};
  const path=rows.map((row,index)=>`${index?"L":"M"}${x(index).toFixed(1)},${y(seriesValue(row)).toFixed(1)}`).join(" "),thresholds=metric==="direction"?[config.threshold,-config.threshold]:[config.threshold];
  return <ChartShell expanded={expanded} setExpanded={setExpanded} className={`score-time-chart score-time-${metric}`}>
    <div className="greek-chart-header"><div><span>LIVE SCORE HISTORY</span><h2>{symbol} · {config.title} VALUE VS TIME</h2></div><div className="greek-header-actions"><ChartTimeControls {...{intervalSeconds,setIntervalSeconds,isLive:viewport.isLive,setOffset:viewport.setOffset,expanded,setExpanded,zoom,onZoom:zoomChart}}/></div></div>
    <div className="greek-chart-legend"><div><i style={{backgroundColor:config.color}}/><span>{config.title}</span><b>{config.format(seriesValue(rows.at(-1)))}</b></div><div><i className="threshold-key"/><span>ACTIVE THRESHOLD</span><b>{metric==="direction"?`±${config.threshold.toFixed(0)}`:config.threshold.toFixed(2)}</b></div></div>
    <div className="greek-chart-stage" onWheel={event=>{event.preventDefault();const anchor=cursorAt(event);setCursor(anchor);if(event.shiftKey)viewport.move(event.deltaY>0?10:-10);else zoomChart(event.deltaY<0?.5:-.5,anchor.index)}} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={()=>{drag.current=null}} onPointerLeave={()=>{drag.current=null;setCursor(null)}}>
      <svg viewBox={`0 0 ${dims.width} ${dims.height}`} role="img" aria-label={`${config.title} plotted against observation time`}><title>{symbol} {config.title} versus time</title><desc>Live and stored score values with the current alert threshold.</desc>
        {[0,1,2,3,4,5,6].map(tick=>{const value=config.max-tick*(config.max-config.min)/6,yy=y(value);return <g key={`score-y-${tick}`}><line className="greek-grid" x1={dims.left} x2={dims.width-dims.right} y1={yy} y2={yy}/><text className="greek-axis" x={dims.left-10} y={yy+4} textAnchor="end">{metric==="direction"?value.toFixed(0):value.toFixed(2)}</text></g>})}
        {[0,1,2,3,4,5].map(tick=>{const index=Math.round(tick*Math.max(rows.length-1,0)/5),xx=x(index);return <g key={`score-x-${tick}`}><line className="greek-grid" x1={xx} x2={xx} y1={dims.top} y2={dims.height-dims.bottom}/><text className="greek-axis" x={xx} y={dims.height-34} textAnchor="middle">{formatTime(rows[index]?.timestamp)}</text></g>})}
        <text className="score-axis-title" x={dims.left+plotWidth/2} y={dims.height-8} textAnchor="middle">TIME</text><text className="score-axis-title" transform={`translate(23 ${dims.top+plotHeight/2}) rotate(-90)`} textAnchor="middle">SCORE VALUE</text>
        {thresholds.map(value=><line key={value} className="score-threshold" x1={dims.left} x2={dims.width-dims.right} y1={y(value)} y2={y(value)}/>)}
        {metric==="direction"&&<line className="greek-zero" x1={dims.left} x2={dims.width-dims.right} y1={y(0)} y2={y(0)}/>}<path className="score-history-line" d={path} style={{stroke:config.color}}/>
        {rows.length>0&&<circle className="greek-current-dot" cx={x(rows.length-1)} cy={y(seriesValue(rows.at(-1)))} r="4.5" style={{fill:config.color}}/>}
        {cursor&&hovered&&<g><line className="greek-crosshair" x1={x(cursor.index)} x2={x(cursor.index)} y1={dims.top} y2={dims.height-dims.bottom}/><line className="greek-crosshair horizontal" x1={dims.left} x2={dims.width-dims.right} y1={y(cursor.value)} y2={y(cursor.value)}/><circle className="greek-hover-dot" cx={x(cursor.index)} cy={y(seriesValue(hovered))} r="5" style={{fill:config.color}}/></g>}
      </svg>{cursor&&hovered&&<div className="chart-coordinate-tooltip" style={{left:`${cursor.left}%`,top:`${Math.max(16,Math.min(82,cursor.top))}%`,transform:cursor.left>68?"translate(calc(-100% - 12px),-50%)":"translate(12px,-50%)"}}><b>{formatTime(hovered.timestamp)}</b><span>Cursor Y {config.format(cursor.value)}</span><span><i style={{backgroundColor:config.color}}/>{config.title} {config.format(seriesValue(hovered))}</span></div>}{!rows.length&&<div className="chart-empty">Waiting for persisted live score history…</div>}
    </div>
    <ChartHistoryNavigator viewport={viewport}/><div className="greek-chart-readout"><span>Wheel: zoom at cursor · Shift+wheel/drag: history</span><span>{viewport.isLive?"Following current stream":`${viewport.offset} buckets behind live`}</span><span>{formatTime(hovered?.timestamp)} · {config.format(seriesValue(hovered))}</span></div>
  </ChartShell>;
}

function GreekPressureChart({history=[],state,symbol}){
  const [intervalSeconds,setIntervalSeconds]=useState(5),[expanded,setExpanded]=useState(false),[hovered,setHovered]=useState(null);
  const viewport=useGreekViewport(history,state,symbol,intervalSeconds,1),row=viewport.visible.at(-1),drag=useRef(null);
  const values=ALL_GREEKS.map(([name,color])=>({name,color,value:number(greekValue(row,name))})).sort((a,b)=>Math.abs(b.value)-Math.abs(a.value));
  const maxAbs=Math.max(...values.map(item=>Math.abs(item.value)),1e-6),formatValue=value=>Math.abs(value)>0&&Math.abs(value)<.001?value.toExponential(2):value.toFixed(4);
  const onWheel=event=>{event.preventDefault();viewport.move(event.deltaY>0?1:-1)};
  const onPointerDown=event=>{drag.current={x:event.clientX,offset:viewport.offset,moved:false};event.currentTarget.setPointerCapture(event.pointerId)};
  const onPointerMove=event=>{if(!drag.current)return;const delta=event.clientX-drag.current.x;if(Math.abs(delta)>3)drag.current.moved=true;viewport.setOffset(Math.max(0,Math.min(viewport.maxOffset,drag.current.offset-Math.round(delta/24))))};
  const onPointerUp=()=>{if(!expanded&&!drag.current?.moved)setExpanded(true);drag.current=null};
  return <ChartShell expanded={expanded} setExpanded={setExpanded} className="greek-pressure-chart"><div className="greek-chart-header"><div><span>GREEKS PRESSURE</span><h2>{symbol} · signed call/put exposure at {row?`${logDate(row.timestamp)} · ${logTime(row.timestamp)}`:"—"}</h2></div><ChartTimeControls {...{intervalSeconds,setIntervalSeconds,isLive:viewport.isLive,setOffset:viewport.setOffset,expanded,setExpanded}}/></div><div className="pressure-axis"><span>SELL / PUT-SIGNED</span><b>0</b><span>BUY / CALL-SIGNED</span></div><div className="pressure-bars" onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={()=>{drag.current=null;setHovered(null)}}>{values.map(item=><div className={`pressure-bar ${hovered===item.name?"hovered":""}`} key={item.name} onPointerEnter={()=>setHovered(item.name)}><span>{pretty(item.name)}</span><div className="pressure-track"><i className={item.value<0?"negative":"positive"} style={{width:`${Math.max(item.value===0?0:1,Math.abs(item.value)/maxAbs*50)}%`,backgroundColor:item.color}}/></div><b className={item.value<0?"neg":"pos"}>{item.value>=0?"+":""}{formatValue(item.value)}</b></div>)}</div><div className="greek-chart-readout"><span>{viewport.isLive?"Current pressure snapshot":`${viewport.offset} buckets behind live`}</span><span>Wheel or drag to inspect older streamed snapshots</span><span>Scale ±{formatValue(maxAbs)}</span></div><div className="greeks-note">Bars share one centered signed scale. Call exposure is positive and put exposure negative, weighted by open interest. This is a model inference—not observed dealer inventory.</div></ChartShell>;
}

function OverviewSectionHeading({number:sectionNumber,title,description,action}){
  return <div className="overview-section-heading"><div><span>{sectionNumber}</span><div><h2>{title}</h2><p>{description}</p></div></div>{action}</div>;
}

function OverviewDisclosure({id,title,description,children,defaultOpen=false,summaryScore}){
  const storageKey=`axiom-section-open-${id}`;
  const [open,setOpen]=useState(()=>{try{const saved=window.localStorage.getItem(storageKey);return saved===null?defaultOpen:saved==="true"}catch{return defaultOpen}});
  const toggle=event=>{const next=event.currentTarget.open;setOpen(next);try{window.localStorage.setItem(storageKey,String(next))}catch{}};
  return <details id={id} className="overview-disclosure overview-section" open={open} onToggle={toggle}><summary><div><span className="section-index" aria-hidden="true">◆</span><div><small className="section-category">{OVERVIEW_CATEGORIES[id]}</small><b>{title}</b><small>{description}</small></div></div>{summaryScore}<em>{open?"−  COLLAPSE":"+  OPEN"}</em></summary><div className="overview-disclosure-body">{children}</div></details>;
}

function DraggableOverviewModule({id,index,dragged,dragOver,onDragStart,onDragOver,onDrop,onDragEnd,children}){
  const target=dragOver?.id===id&&dragged!==id;
  return <div className={`draggable-overview-module ${dragged===id?"is-dragging":""} ${target?`is-drag-over drop-${dragOver.position}`:""}`} data-module-id={id} style={{order:index}}>
      <button type="button" className="module-drag-handle" draggable="true" onDragStart={event=>onDragStart(event,id)} onDragEnd={onDragEnd} aria-label={`Drag ${OVERVIEW_LABELS[id]} section to reorder`} title="Drag with your cursor to reorder this section"><span>⠿</span><b>REORDER</b><small>Position {index+3}</small></button>
    <div className="module-drop-zone" onDragEnter={event=>onDragOver(event,id)} onDragOver={event=>onDragOver(event,id)} onDrop={event=>onDrop(event,id)}>{children}</div>
  </div>;
}

function GreekMultiSelect({selected,onChange}){
  const toggle=name=>onChange(selected.includes(name)?(selected.length===1?selected:selected.filter(item=>item!==name)):[...selected,name]);
  const title=name=>name.charAt(0).toUpperCase()+name.slice(1);
  return <details className="greek-selector" aria-label="Choose Greek series to display">
    <summary><span>SELECT SERIES · {selected.length}/{ALL_GREEKS.length}</span><b>{selected.map(title).join(" · ")}</b><i>▾</i></summary>
    <div className="greek-selector-content">
      <div className="greek-selector-head"><span>VARIABLES BY GREEK ORDER</span><button type="button" onClick={()=>onChange(ALL_GREEKS.map(([name])=>name))}>Select all</button></div>
      <div className="greek-selector-groups">{Object.entries(GREEK_ORDERS).map(([order,configuration])=><fieldset className={`greek-selector-group order-${order}`} key={order}><legend>{order.toUpperCase()} ORDER</legend><div>{configuration.series.map(([name,color])=>{const metadata=GREEK_CATALOG[name],derivation=metadata.derivedFrom.length?` (${metadata.derivedFrom.join(", ")})`:"";return <label key={name} title={metadata.derivedFrom.length?`${title(name)} is derived from ${metadata.derivedFrom.join(" and ")}`:`${title(name)} is a first-order Greek`}><input type="checkbox" checked={selected.includes(name)} onChange={()=>toggle(name)}/><i style={{backgroundColor:color}}/><span>{title(name)}{derivation}</span></label>})}</div></fieldset>)}</div>
      <small>Choose one or more variables. At least one remains selected.</small>
    </div>
  </details>;
}

function CustomGreekChart({chart,index,history,state,symbol,onChange,onRemove,canRemove}){
  const [intervalSeconds,setIntervalSeconds]=useState(5),[expanded,setExpanded]=useState(false),[zoom,setZoom]=useState(1),[cursor,setCursor]=useState(null);
  const drag=useRef(null),viewport=useGreekViewport(history,state,symbol,intervalSeconds,Math.max(12,Math.round((expanded?120:96)/zoom))),rows=viewport.visible;
  const series=ALL_GREEKS.filter(([name])=>chart.selected.includes(name));
  const normalHeight=Math.min(430,Math.max(330,series.length*95+50));
  const dims={width:expanded?1400:720,height:expanded?700:normalHeight,left:expanded?188:158,right:expanded?34:18,top:12,bottom:expanded?78:58},plotWidth=dims.width-dims.left-dims.right,plotHeight=dims.height-dims.top-dims.bottom,laneHeight=plotHeight/Math.max(series.length,1);
  const seriesValue=(row,name)=>greekValue(row,name),values=rows.flatMap(row=>series.map(([name])=>seriesValue(row,name))).filter(Number.isFinite);
  const maxAbs=Math.max(...values.map(Math.abs),1e-6),ranges=Object.fromEntries(series.map(([name])=>{const points=rows.map(row=>seriesValue(row,name)).filter(Number.isFinite),minimum=points.length?Math.min(...points):0,maximum=points.length?Math.max(...points):0,center=(minimum+maximum)/2,raw=maximum-minimum,padding=Math.max(raw*.14,Math.abs(center)*.002,1e-12);return [name,{minimum:minimum-padding,maximum:maximum+padding}]})),x=point=>dims.left+point*plotWidth/Math.max(1,rows.length-1),y=(value,name)=>{const index=series.findIndex(([key])=>key===name),range=ranges[name],top=dims.top+index*laneHeight+9,bottom=dims.top+(index+1)*laneHeight-9;return top+(range.maximum-value)*(bottom-top)/Math.max(range.maximum-range.minimum,1e-15)};
  const formatValue=value=>{const parsed=optionalNumber(value);if(!Number.isFinite(parsed))return "—";const magnitude=Math.abs(parsed);return magnitude>0&&magnitude<.01?parsed.toExponential(3):parsed.toFixed(4)};
  const formatTime=chartTime,hovered=rows[cursor?.index??rows.length-1];
  const zoomChart=(amount,anchorIndex=cursor?.index??rows.length-1)=>{const next=Math.max(1,Math.min(8,Math.round((zoom+amount)*2)/2));if(next===zoom)return;const fraction=rows.length>1?anchorIndex/(rows.length-1):1,globalIndex=viewport.rows.length-viewport.offset-rows.length+anchorIndex,nextCount=Math.max(12,Math.round((expanded?120:96)/next)),nextIndex=Math.round(fraction*Math.max(nextCount-1,0)),nextOffset=Math.max(0,Math.min(Math.max(0,viewport.rows.length-nextCount),viewport.rows.length-(globalIndex-nextIndex+nextCount)));setZoom(next);viewport.setOffset(nextOffset);setCursor(current=>current?{...current,index:nextIndex}:current)};
  const onPointerMove=event=>{setCursor(chartCursor(event,dims,rows.length,maxAbs));if(drag.current){const delta=event.clientX-drag.current.x;if(Math.abs(delta)>3)drag.current.moved=true;viewport.setOffset(Math.max(0,Math.min(viewport.maxOffset,drag.current.offset-Math.round(delta/7))))}};
  const onPointerDown=event=>{drag.current={x:event.clientX,offset:viewport.offset,moved:false};event.currentTarget.setPointerCapture(event.pointerId)},onPointerUp=()=>{if(!expanded&&!drag.current?.moved)setExpanded(true);drag.current=null};
  useEffect(()=>{
    const wrapper=expanded?document.querySelector(".chart-modal-backdrop .custom-greek-chart"):document.querySelectorAll(".custom-graph-stack .custom-greek-chart")[index];
    const stage=wrapper?.querySelector(".greek-chart-stage");
    if(!stage)return;
    const wheel=event=>{event.preventDefault();event.stopImmediatePropagation();const anchor=chartCursor(event,dims,rows.length,maxAbs);setCursor(anchor);if(event.shiftKey)viewport.move(event.deltaY>0?10:-10);else zoomChart(event.deltaY<0?.5:-.5,anchor.index)};
    stage.addEventListener("wheel",wheel,{passive:false,capture:true});
    return()=>stage.removeEventListener("wheel",wheel,{capture:true});
  },[expanded,index,zoom,rows.length,maxAbs,viewport.offset,viewport.maxOffset]);
  return <ChartShell expanded={expanded} setExpanded={setExpanded} className="custom-greek-chart">
    <div className="greek-chart-header"><div><span>CUSTOM GREEK GRAPH {String(index+1).padStart(2,"0")}</span><h2>{symbol} · selected live exposures</h2></div><div className="custom-chart-actions"><GreekMultiSelect selected={chart.selected} onChange={selected=>onChange({...chart,selected})}/>{canRemove&&<button className="remove-chart" onClick={onRemove}>Remove</button>}</div></div>
    <div className="custom-time-row"><ChartTimeControls {...{intervalSeconds,setIntervalSeconds,isLive:viewport.isLive,setOffset:viewport.setOffset,expanded,setExpanded,zoom,onZoom:zoomChart}}/></div>
    <div className="greek-chart-legend custom-live-values">{series.map(([name,color])=><div key={name}><i style={{backgroundColor:color}}/><span>{pretty(name)}</span><b>{formatValue(seriesValue(rows.at(-1),name))}</b><small>LIVE</small></div>)}</div>
    <div className="greek-chart-stage lane-chart-stage" style={{height:dims.height,minHeight:dims.height}} onWheel={event=>{event.preventDefault();if(event.ctrlKey||event.metaKey)zoomChart(event.deltaY<0?.5:-.5);else viewport.move(event.deltaY>0?10:-10)}} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={()=>{drag.current=null;setCursor(null)}}>
      <svg viewBox={`0 0 ${dims.width} ${dims.height}`} preserveAspectRatio="none" role="img" aria-label={`Custom live Greek chart ${index+1} showing ${chart.selected.join(", ")}`}><title>Custom Greek graph {index+1}</title><desc>Selected open-interest-weighted Greek exposures over streamed time.</desc>
        {series.flatMap(([name,color],laneIndex)=>{const range=ranges[name],top=dims.top+laneIndex*laneHeight,bottom=top+laneHeight,middle=(top+bottom)/2;return <g key={`lane-${name}`}><rect className="first-order-lane" x={dims.left} y={top} width={plotWidth} height={laneHeight}/><text className="first-order-lane-name" x="14" y={middle+5} style={{fill:color}}>{name.toUpperCase()}</text>{[range.maximum,(range.maximum+range.minimum)/2,range.minimum].map((value,tickIndex)=>{const yy=[top+9,middle,bottom-9][tickIndex];return <g key={`${name}-${tickIndex}`}><line className="greek-grid" x1={dims.left} x2={dims.width-dims.right} y1={yy} y2={yy}/><text className="greek-axis" x={dims.left-10} y={yy+4} textAnchor="end">{formatValue(value)}</text></g>})}</g>})}
        {[0,1,2,3,4,5].map(tick=>{const point=Math.round(tick*Math.max(rows.length-1,0)/5),xx=x(point);return <g key={`gx-${tick}`}><line className="greek-grid" x1={xx} x2={xx} y1={dims.top} y2={dims.height-dims.bottom}/><text className="greek-axis" x={xx} y={dims.height-(expanded?28:23)} textAnchor="middle">{formatTime(rows[point]?.timestamp)}</text></g>})}
        {series.map(([name,color])=>{let drawing=false;const path=rows.map((row,point)=>{const value=seriesValue(row,name);if(!Number.isFinite(value)){drawing=false;return ""}const command=drawing?"L":"M";drawing=true;return `${command}${x(point).toFixed(1)},${y(value,name).toFixed(1)}`}).filter(Boolean).join(" "),latest=seriesValue(rows.at(-1),name);return <g key={name}>{path&&<path className="greek-series" d={path} style={{stroke:color}}/>}{Number.isFinite(latest)&&<circle className="greek-current-dot" cx={x(rows.length-1)} cy={y(latest,name)} r="3.5" style={{fill:color}}/>}</g>})}
        {cursor&&<g><line className="greek-crosshair" x1={x(cursor.index)} x2={x(cursor.index)} y1={dims.top} y2={dims.height-dims.bottom}/>{series.map(([name,color])=>{const value=seriesValue(hovered,name);return Number.isFinite(value)?<circle key={name} className="greek-hover-dot" cx={x(cursor.index)} cy={y(value,name)} r="4" style={{fill:color}}/>:null})}</g>}
      </svg>
      <ChartCoordinateTooltip {...{cursor,row:hovered,series,formatTime,formatValue,seriesValue}} cursorValueText={()=>"Actual values by lane"}/>{!rows.length&&<div className="chart-empty">Waiting for live Options Pro states…</div>}
    </div>
    <ChartHistoryNavigator viewport={viewport}/><div className="greek-chart-readout"><span>{viewport.isLive?"Following current stream":`${viewport.offset} buckets behind live`}</span><span>{formatTime(hovered?.timestamp)}</span>{series.map(([name,color])=><span key={name}><i style={{backgroundColor:color}}/>{pretty(name)} {formatValue(seriesValue(hovered,name))}</span>)}</div>
  </ChartShell>;
}

function CustomGreekWorkspace({history,state,symbol}){
  const nextId=useRef(3),[charts,setCharts]=useState([
    {id:1,selected:["delta","theta","vega","rho"]},
    {id:2,selected:["gamma","vanna","charm"]},
  ]);
  const addChart=()=>setCharts(current=>current.length>=10?current:[...current,{id:nextId.current++,selected:["delta","gamma","speed"]}]);
  return <div className="custom-greek-workspace"><OverviewSectionHeading number="04" title="Build your Greek graphs" description="Two graphs per row. Select one, several, or every Greek; each graph follows the live stream independently." action={<button className="add-greek-chart" disabled={charts.length>=10} onClick={addChart}>+ Add graph <span>{charts.length}/10</span></button>}/><div className="custom-graph-stack">{charts.map((chart,index)=><article className="panel chart-panel" key={chart.id}><CustomGreekChart {...{chart,index,history,state,symbol}} onChange={next=>setCharts(current=>current.map(item=>item.id===chart.id?next:item))} onRemove={()=>setCharts(current=>current.filter(item=>item.id!==chart.id))} canRemove={charts.length>1}/></article>)}</div></div>;
}

function StreamingPriceChart({ symbol, liveState, alert }) {
  const [intervalSeconds, setIntervalSeconds] = useState(300);
  const [points, setPoints] = useState([]);
  const [offset, setOffset] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hoverIndex, setHoverIndex] = useState(null);
  const drag = useRef(null);
  const visibleCount = 84;

  const load = async (before = null) => {
    if (before && loadingOlder) return;
    if (before) setLoadingOlder(true);
    try {
      const rows = await fetchChart(symbol, intervalSeconds, before);
      setPoints(current => before
        ? [...rows, ...current].filter((row, index, all) => index === all.findIndex(item => item.timestamp === row.timestamp))
        : rows);
      if (!before) setOffset(0);
    } finally { if (before) setLoadingOlder(false); }
  };

  useEffect(() => { load(); }, [symbol, intervalSeconds]);
  useEffect(() => {
    if (!liveState || liveState.symbol !== symbol) return;
    const price = number(liveState.supporting_indicators?.price, NaN);
    if (!Number.isFinite(price)) return;
    const bucket = Math.floor(new Date(liveState.timestamp).getTime() / 1000 / intervalSeconds) * intervalSeconds * 1000;
    const timestamp = new Date(bucket).toISOString();
    setPoints(current => {
      const next = [...current];
      const last = next.at(-1);
      if (last?.timestamp === timestamp) next[next.length - 1] = { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price, samples: (last.samples ?? 0) + 1 };
      else next.push({ timestamp, open: price, high: price, low: price, close: price, samples: 1 });
      return next.slice(-1200);
    });
  }, [liveState, symbol, intervalSeconds]);

  const maxOffset = Math.max(0, points.length - visibleCount);
  const safeOffset = Math.min(offset, maxOffset);
  const end = points.length - safeOffset;
  const visible = points.slice(Math.max(0, end - visibleCount), end);
  const isLive = safeOffset === 0;
  const values = visible.flatMap(point => [point.low, point.high]).filter(Number.isFinite);
  const minRaw = values.length ? Math.min(...values) : 0;
  const maxRaw = values.length ? Math.max(...values) : 1;
  const padding = Math.max((maxRaw - minRaw) * .12, Math.abs(maxRaw) * .0005, .01);
  const min = minRaw - padding, max = maxRaw + padding;
  const dims = { width: 900, height: 330, left: 72, right: 20, top: 22, bottom: 42 };
  const plotWidth = dims.width - dims.left - dims.right, plotHeight = dims.height - dims.top - dims.bottom;
  const x = index => dims.left + index * plotWidth / Math.max(1, visible.length - 1);
  const y = value => dims.top + (max - value) * plotHeight / Math.max(max - min, .00001);
  const line = visible.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(point.close).toFixed(1)}`).join(" ");
  const priceDigits = maxRaw >= 10000 ? 0 : maxRaw >= 1000 ? 1 : 2;
  const formatPrice = value => number(value).toLocaleString(undefined, { minimumFractionDigits: priceDigits, maximumFractionDigits: priceDigits });
  const formatTime = value => new Date(value).toLocaleString("en-US", intervalSeconds >= 86400
    ? { timeZone:EASTERN_TZ,month:"short",day:"numeric" } : { timeZone:EASTERN_TZ,hour12:true,hour:"2-digit",minute:"2-digit" });

  const moveBack = amount => {
    const next = Math.max(0, Math.min(maxOffset, safeOffset + amount));
    setOffset(next);
    if (next >= maxOffset - 8 && points[0] && !loadingOlder) load(points[0].timestamp);
  };
  const onWheel = event => { event.preventDefault(); moveBack(event.deltaY > 0 ? 8 : -8); };
  const onPointerDown = event => { drag.current = { x: event.clientX, offset: safeOffset }; event.currentTarget.setPointerCapture(event.pointerId); };
  const onPointerMove = event => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const index = Math.round((event.clientX - bounds.left) / bounds.width * (visible.length - 1));
    setHoverIndex(Math.max(0, Math.min(visible.length - 1, index)));
    if (drag.current) setOffset(Math.max(0, Math.min(maxOffset, drag.current.offset + Math.round((event.clientX - drag.current.x) / 7))));
  };
  const hovered = visible[hoverIndex ?? visible.length - 1];
  const alertIndex = alert ? visible.findIndex(point => new Date(point.timestamp) >= new Date(alert.timestamp)) : -1;

  return <div className="stream-chart">
    <div className="stream-chart-toolbar">
      <div><span className="chart-kicker">PRICE CONFIRMATION</span><h2>{symbol} streamed price</h2></div>
      <div className="chart-actions"><div className="timeframe-buttons">{CHART_INTERVALS.map(([label, seconds]) => <button key={label} className={intervalSeconds === seconds ? "active" : ""} onClick={() => setIntervalSeconds(seconds)}>{label}</button>)}</div><button className={`return-live ${isLive ? "is-live" : "is-back"}`} onClick={() => setOffset(0)}>{isLive ? "● LIVE" : "↪ RETURN LIVE"}</button></div>
    </div>
    <div className="stream-chart-stage" onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => { drag.current = null; }} onPointerLeave={() => { drag.current = null; setHoverIndex(null); }}>
      <svg viewBox={`0 0 ${dims.width} ${dims.height}`} role="img" aria-label={`${symbol} price confirmation chart with time and price axes`}>
        {[0,1,2,3,4].map(tick => { const value = max - tick * (max - min) / 4, yy = y(value); return <g key={`y-${tick}`}><line className="chart-grid" x1={dims.left} y1={yy} x2={dims.width-dims.right} y2={yy}/><text className="chart-axis" x={dims.left-10} y={yy+4} textAnchor="end">{formatPrice(value)}</text></g>; })}
        {[0,1,2,3,4,5].map(tick => { const index = Math.round(tick * Math.max(0,visible.length-1) / 5), xx = x(index); return <g key={`x-${tick}`}><line className="chart-grid" x1={xx} y1={dims.top} x2={xx} y2={dims.height-dims.bottom}/><text className="chart-axis" x={xx} y={dims.height-14} textAnchor="middle">{visible[index] ? formatTime(visible[index].timestamp) : "—"}</text></g>; })}
        <path className="price-line-svg" d={line}/>
        {visible.length > 0 && <circle className="current-price-dot" cx={x(visible.length-1)} cy={y(visible.at(-1).close)} r="5"/>}
        {alertIndex >= 0 && <path className="alert-marker" transform={`translate(${x(alertIndex)} ${y(visible[alertIndex].close)-10})`} d="M0,-8 L7,5 L-7,5 Z"/>}
        {hovered && <g><line className="crosshair" x1={x(hoverIndex ?? visible.length-1)} x2={x(hoverIndex ?? visible.length-1)} y1={dims.top} y2={dims.height-dims.bottom}/><circle className="hover-dot" cx={x(hoverIndex ?? visible.length-1)} cy={y(hovered.close)} r="4"/></g>}
      </svg>
      {!points.length && <div className="chart-empty">Waiting for persisted streamed prices…</div>}
    </div>
    <div className="chart-readout"><span>{isLive ? "Following current stream" : `${safeOffset} bars behind live — click RETURN LIVE to catch up`}</span><span>{hovered ? `${formatTime(hovered.timestamp)} · O ${formatPrice(hovered.open)} H ${formatPrice(hovered.high)} L ${formatPrice(hovered.low)} C ${formatPrice(hovered.close)}` : "No price data"}</span></div>
  </div>;
}

function PriorityAlert({ alert, state, symbol }) {
  const decision=deriveOptionsDecision(state),failed=decision.failed;
  if (!decision.qualified) return <article className="priority-alert waiting-alert">
    <div><span className="alert-label">OPTIONS-PRESSURE BIAS</span><h2>{symbol} · WAIT</h2><p>{failed.length ? `Waiting for ${failed.join(", ")} to pass.` : "The engine is warming up its options-chain history."} No price confirmation is claimed.</p></div>
    <div className="watch-levels bias-levels"><div><span>EXPLOSION</span><b>{number(state?.explosion?.value).toFixed(2)}</b></div><div><span>DIRECTION</span><b>{number(state?.direction?.value)>0?"+":""}{number(state?.direction?.value).toFixed(0)}</b></div><div><span>PRESSURE</span><b>{number(state?.pressure?.value)>0?"+":""}{number(state?.pressure?.value).toFixed(2)}</b></div></div>
  </article>;
  const direction = decision.direction;
  const side = biasLabel(direction);
  return <article className={`priority-alert ${direction === "UP" ? "long-alert" : "short-alert"}`}>
    <div><div className="alert-heading"><span className="alert-label">OPTIONS-PRESSURE BIAS · MANUAL PRICE CONFIRMATION REQUIRED</span><span className="alert-confidence">{pct(decision.optionsConfidence)}</span></div><h2>{symbol} · {side} BIAS</h2><p>{state?.explosion?.explanation} {state?.direction?.explanation} {state?.pressure?.explanation}</p><small>{time(state?.timestamp)} · {pretty(state?.profile)} · Options Pro inputs only · not an entry signal</small></div>
    <div className="alert-levels bias-levels"><div><span>BIAS</span><b>{side}</b></div><div><span>EXPLOSION</span><b>{number(state?.explosion?.value).toFixed(2)}</b></div><div><span>PRESSURE</span><b>{number(state?.pressure?.value)>0?"+":""}{number(state?.pressure?.value).toFixed(2)}</b></div><div><span>DIRECTION</span><b>{number(state?.direction?.value)>0?"+":""}{number(state?.direction?.value).toFixed(0)} / 3</b></div></div>
  </article>;
}

const SCORECARD_SYSTEMS=[
  ["GAMMA_DYNAMICS","Gamma Dynamics 1.0"],
  ["GAMMA_DYNAMICS_V2","Gamma Dynamics 2.0"],
  ["DELTA_DYNAMICS","Delta Dynamics"],
];

function medianDuration(values){
  const ordered=values.filter(Number.isFinite).sort((a,b)=>a-b);
  if(!ordered.length)return null;
  const middle=Math.floor(ordered.length/2);
  return ordered.length%2?ordered[middle]:(ordered[middle-1]+ordered[middle])/2;
}

function scorecardCallState(call){
  const outcome=callOutcome(call);
  if(outcome.closed)return outcome.grade==="success"?"succeeded":"failed";
  const entry=number(call.entry_price),current=number(call.current_price??call.final_price??call.minute_bars?.at(-1)?.close,entry);
  return call.direction==="UP"?(current>=entry?"succeeding":"failing"):(current<=entry?"succeeding":"failing");
}

function scorecardRangeTimestamp(date,time,end=false){
  if(!date)return end?Infinity:-Infinity;
  const timestamp=new Date(`${date}T${time||(end?"23:59:59":"00:00:00")}`).getTime();
  return Number.isFinite(timestamp)?timestamp:(end?Infinity:-Infinity);
}

function scorecardDateValue(date){
  return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,10);
}

function filterScorecardCalls(calls,fromDate,fromTime,toDate,toTime){
  const start=scorecardRangeTimestamp(fromDate,fromTime),end=scorecardRangeTimestamp(toDate,toTime,true);
  const allTime=!fromDate&&!fromTime&&!toDate&&!toTime;
  return calls.filter(call=>{const timestamp=new Date(call.alerted_at??call.timestamp??call.created_at??call.entry_at??"").getTime();return allTime||Number.isFinite(timestamp)&&timestamp>=start&&timestamp<=end});
}

function SystemScorecardRow({system,label,calls,overallCalls,state}){
  const logical=dedupeLogicalCalls(calls),counts=logical.reduce((result,call)=>{result[scorecardCallState(call)]+=1;return result},{succeeded:0,failed:0,succeeding:0,failing:0});
  const overallCounts=dedupeLogicalCalls(overallCalls).reduce((result,call)=>{result[scorecardCallState(call)]+=1;return result},{succeeded:0,failed:0,succeeding:0,failing:0});
  const wins=logical.filter(call=>scorecardCallState(call)==="succeeded"),completed=logical.filter(call=>["succeeded","failed"].includes(scorecardCallState(call)));
  const speedBuckets=[
    ["≤10M",seconds=>seconds<=600],
    ["10–30M",seconds=>seconds>600&&seconds<=1800],
    ["30M+",seconds=>seconds>1800],
  ].map(([label,includes])=>({label,count:wins.filter(call=>{const seconds=Number(call.seconds_to_target);return Number.isFinite(seconds)&&includes(seconds)}).length}));
  const scorecardClass={GAMMA_DYNAMICS:"scorecard-gamma-v1",GAMMA_DYNAMICS_V2:"scorecard-gamma-v2",DELTA_DYNAMICS:"scorecard-delta"}[system]??"";
  const model=system==="GAMMA_DYNAMICS"?state?.gamma_dynamics:system==="GAMMA_DYNAMICS_V2"?state?.gamma_dynamics_v2:state?.zone_intelligence;
  const currentDirection=model?.decision??model?.direction??"NEUTRAL",direction=currentDirection==="NEUTRAL"?"—":currentDirection;
  return <tr className={`system-scorecard-row ${scorecardClass}`}><td className="scorecard-system"><b>{label}</b></td><td className="scorecard-succeeded">{counts.succeeded}<small>({overallCounts.succeeded})</small></td><td className="scorecard-failed">{counts.failed}<small>({overallCounts.failed})</small></td><td className="scorecard-succeeding">{counts.succeeding}</td><td className="scorecard-failing">{counts.failing}</td><td className={`scorecard-direction ${direction==="UP"?"up":direction==="DOWN"?"down":""}`}>{direction}</td><td className="scorecard-targets">{speedBuckets.map(bucket=><span key={bucket.label}><b>{bucket.count}</b><small>{bucket.label}</small></span>)}</td></tr>;
}

function SystemScorecard({attribution,state,symbol}){
  const [filterOpen,setFilterOpen]=useState(false),[fromDate,setFromDate]=useState(()=>scorecardDateValue(new Date())),[fromTime,setFromTime]=useState(""),[toDate,setToDate]=useState(()=>scorecardDateValue(new Date())),[toTime,setToTime]=useState("");
  const filterRef=useRef(null);
  useEffect(()=>{if(!filterOpen)return;const closeFilter=event=>{if(!filterRef.current?.contains(event.target))setFilterOpen(false)};document.addEventListener("pointerdown",closeFilter);return()=>document.removeEventListener("pointerdown",closeFilter)},[filterOpen]);
  const updated=state?.timestamp?`${logDate(state.timestamp)} · ${logTime(state.timestamp)} ET`:"WAITING FOR STREAM";
  const hasRange=Boolean(fromDate||fromTime||toDate||toTime),todayDate=scorecardDateValue(new Date()),isToday=fromDate===todayDate&&toDate===todayDate&&!fromTime&&!toTime,rangeLabel=!hasRange?"ALL TIME":isToday?"TODAY":"CUSTOM RANGE",clearRange=()=>{setFromDate("");setFromTime("");setToDate("");setToTime("")},setToday=()=>{const today=scorecardDateValue(new Date());setFromDate(today);setFromTime("");setToDate(today);setToTime("")},setLastWeek=()=>{const now=new Date(),start=new Date(now);start.setDate(now.getDate()-6);setFromDate(scorecardDateValue(start));setFromTime("");setToDate(scorecardDateValue(now));setToTime("")};
  const filterControl=<div className="scorecard-filter-control" ref={filterRef}><button type="button" className={`scorecard-filter-trigger ${filterOpen?"is-open":""}`} onClick={()=>setFilterOpen(open=>!open)} aria-expanded={filterOpen}><i>◷</i><b>{rangeLabel}</b><em>{filterOpen?"⌃":"⌄"}</em></button>{filterOpen&&<div className="scorecard-filter-popover" role="dialog" aria-label="Scorecard date and time filter"><header><div><span>FILTER OUTCOMES</span><b>Choose an alert-time range</b></div><button type="button" onClick={()=>setFilterOpen(false)} aria-label="Close date filter">×</button></header><div className="scorecard-filter-fields"><label><span>FROM DATE</span><input type="date" value={fromDate} onChange={event=>setFromDate(event.target.value)}/></label><label><span>FROM TIME</span><input type="time" value={fromTime} onChange={event=>setFromTime(event.target.value)}/></label><label><span>TO DATE</span><input type="date" value={toDate} onChange={event=>setToDate(event.target.value)}/></label><label><span>TO TIME</span><input type="time" value={toTime} onChange={event=>setToTime(event.target.value)}/></label></div><footer><div><button type="button" onClick={setToday}>TODAY</button><button type="button" onClick={setLastWeek}>LAST 7 DAYS</button><button type="button" onClick={clearRange} disabled={!hasRange}>ALL TIME</button></div></footer></div>}</div>;
  return <section id="system-scorecard" className="overview-section system-scorecard-section"><OverviewSectionHeading number="01" title="System scorecard" description="Outcome briefing across Gamma Dynamics 1.0, Gamma Dynamics 2.0, and Delta Dynamics."/><article className="panel system-scorecard"><header className="panel-head"><div><h2>SYSTEM OUTCOME BRIEFING</h2></div><div className="scorecard-head-actions"><div className="scorecard-updated"><span>LAST UPDATED</span><b>{updated}</b></div>{filterControl}</div></header><div className="system-scorecard-table-wrap"><table className="system-scorecard-table"><thead><tr><th>SYSTEM</th><th>SUCCEEDED</th><th>FAILED</th><th>SUCCEEDING</th><th>FAILING</th><th>DIRECTION</th><th>TARGET HITS</th></tr></thead><tbody>{SCORECARD_SYSTEMS.map(([system,label])=>{const overallCalls=attribution?.systems?.[system]?.calls??[];return <SystemScorecardRow key={system} system={system} label={label} calls={filterScorecardCalls(overallCalls,fromDate,fromTime,toDate,toTime)} overallCalls={overallCalls} state={state}/>})}</tbody></table></div></article></section>;
}

function FocusView({state,symbol,engine,decision,lastQualifiedAlert,clock,attribution,history}) {
  const tone=decision.qualified?(decision.direction==="UP"?"long":"short"):"neutral";
  const label=decision.qualified?biasLabel(decision.direction):"WAIT";
  const lifecycleMessage=decision.lifecycle==="IDLE"?"ENGINE IDLE · WAIT":
    decision.lifecycle==="STALE"?"STALE DATA · WAIT":
    decision.lifecycle==="CONFIRMING"?`CONFIRMING ${decision.entryProgress}/${decision.entryRequired}`:
    decision.lifecycle==="ACTIVE"?`${label} ACTIVE · ${formatAge(decision.ageSeconds)}`:
    decision.lifecycle==="MINIMUM_HOLD"?`HOLD ${label} · ${formatAge(Math.max(0,decision.minHoldSeconds-decision.ageSeconds))} MINIMUM REMAINING`:
    decision.lifecycle==="EXIT_PENDING"?`HOLD ${label} · EXIT CHECK ${decision.exitProgress}/${decision.exitRequired}`:
    decision.lifecycle==="REVERSAL_PENDING"?`HOLD ${label} · OPPOSITE CHECK ${decision.entryProgress}/${decision.entryRequired}`:"WAITING FOR QUALIFIED PRESSURE";
  const directionThreshold=number(state?.active_thresholds?.direction_min,2);
  const session=state?.session_analysis??{},sessionWeights=session.active_alert_weights??{},wallPhase=easternMarketPhase(clock);
  const staleClosed=["CLOSED","WEEKEND_CLOSED"].includes(session.detected_session),displaySession=staleClosed&&wallPhase!=="RTH"?wallPhase:(session.detected_session??"waiting");
  const sessionNote=["PREMARKET","PRE_MARKET"].includes(displaySession)?"PRE-MARKET SESSION ACTIVE · RTH OPENS 9:30 ET":displaySession==="AFTER_HOURS"?"OPTIONS RTH CLOSED":`${pretty(session.session_state??"current")} · clock ${pretty(session.clock_session??"waiting")}`;
  const missingConfirmations=session?.unavailable_confirmations??[];
  const metrics=[
    ["Explosion",number(state?.explosion?.value).toFixed(2),`Ideal ≥ ${number(decision.thresholds?.explosion,.58).toFixed(2)}`,decision.checks.explosion],
    ["Direction",`${number(state?.direction?.value)>0?"+":""}${number(state?.direction?.value).toFixed(0)} / 3`,`Ideal |score| ≥ ${directionThreshold.toFixed(0)}`,decision.checks.direction],
    ["Pressure",`${number(state?.pressure?.value)>0?"+":""}${number(state?.pressure?.value).toFixed(2)}`,`Ideal aligned ≥ ${number(decision.thresholds?.pressure,.15).toFixed(2)}`,decision.checks.pressure_alignment],
    ["Options confidence",pct(decision.optionsConfidence),`Ideal ≥ ${pct(decision.thresholds?.confidence,.68)}`,decision.checks.confidence],
    ["Risk",pct(state?.risk?.value),`Ideal < ${pct(decision.thresholds?.risk,.88)}`,decision.checks.risk],
  ];
  return <section id="decision" className={`focus-view focus-view-${tone} overview-section`} aria-live="polite">
    <div className="focus-heading"><div><span>ONE-SCREEN OPTIONS FOCUS</span><h2>{symbol} · {label}</h2><small>{engine.running?"● LIVE OPTIONS PRO":"○ ENGINE IDLE"} · {time(state?.timestamp)} · {pretty(state?.regime??"waiting")}</small></div><div className="focus-alert"><span>{decision.lifecycle.replaceAll("_"," ")}</span><b>{lifecycleMessage}</b><small>Bias state only · never a safety or execution guarantee</small></div></div>
    <div className="focus-hold-policy"><span><b>ENTRY</b> {decision.entryRequired} consecutive qualified snapshots</span><span><b>MINIMUM HOLD</b> {decision.minHoldSeconds}s</span><span><b>EXIT</b> {decision.exitRequired} consecutive failed snapshots after minimum hold</span><span><b>RAW NOW</b> {decision.rawQualified?"QUALIFIED":"NOT QUALIFIED"}</span></div>
    <DynamicsScorecard attribution={attribution} state={state} history={history}/>
    <div className="session-weight-strip">
      <div><span>MARKET PHASE / SESSION</span><b>{pretty(displaySession)}</b><small>{sessionNote}</small></div>
      <div><span>TRANSITION CONFIDENCE</span><b>{number(session.transition_confidence).toFixed(0)}%</b><small>Candidate {number(session.candidate_session_score).toFixed(2)} · current {number(session.current_session_score).toFixed(2)}</small></div>
      <div><span>ACTIVE GREEK WEIGHTS</span><b>Γ {pct(sessionWeights.gamma)} · V {pct(sessionWeights.vanna)} · C {pct(sessionWeights.charm)}</b><small>Main Greek · {pretty(session.main_greek??"waiting")}</small></div>
      <div><span>WEIGHTED ALIGNMENT</span><b>{number(session.active_greek_score)>0?"+":""}{number(session.active_greek_score).toFixed(2)}</b><small>{session.directional_qualified?"2 Greeks + price confirmed":session.main_greek==="VANNA"&&missingConfirmations.includes("overnight_iv_shift")?"Vanna direction unavailable · live IV shift required":"No directional confirmation"}</small></div>
      <em><b>SESSION-CHANGE CONFIRMATION</b>{session.expected_confirmation??"Waiting for an active phase"}<small>{missingConfirmations.length?`Unavailable inputs: ${missingConfirmations.map(pretty).join(", ")}`:"All configured inputs observable"} · initial hypothesis, not walk-forward validated</small></em>
    </div>
    <div className={`last-qualified-bias ${lastQualifiedAlert?"has-alert":"no-alert"}`}><div><span>LAST QUALIFIED BIAS</span><b>{lastQualifiedAlert?`${lastQualifiedAlert.symbol} · ${biasLabel(lastQualifiedAlert.direction)}`:"NONE RECORDED"}</b></div>{lastQualifiedAlert?<><div><span>QUALIFIED AT</span><b>{logDate(lastQualifiedAlert.timestamp)} · {logTime(lastQualifiedAlert.timestamp)}</b></div><div><span>GATES AT EVENT</span><b>EXP {lastQualifiedAlert.explosion} · DIR {lastQualifiedAlert.score} · PRESSURE {lastQualifiedAlert.pressure>=0?"+":""}{number(lastQualifiedAlert.pressure).toFixed(2)}</b></div><div><span>OPTIONS CONFIDENCE</span><b>{pct(lastQualifiedAlert.confidence)}</b></div></>:<small>A historical LONG or SHORT appears here after the confirmation sequence completes.</small>}</div>
    <div className="focus-score-grid">{metrics.map(([name,value,ideal,passed])=><div className={`focus-score ${passed?"gate-pass":"gate-fail"}`} key={name}><span>{name}</span><b>{value}</b><small>{passed?"PASS":"WAIT"} · {ideal}</small></div>)}</div>
  </section>;
}

function GammaDynamicsV2Metrics({model}){
  // This panel is intentionally removed from the dashboard.  Keep the
  // component stub temporarily so older layout references remain harmless,
  // without building its hidden card/wall payload on every live update.
  return null;
  const metrics=model?.chain_metrics??{},checks=model?.alert_checks??{};
  const compact=value=>{const numeric=optionalNumber(value);if(!Number.isFinite(numeric))return "—";const absolute=Math.abs(numeric);if(absolute>=1e9)return `${numeric<0?"-":""}${(absolute/1e9).toFixed(2)}B`;if(absolute>=1e6)return `${numeric<0?"-":""}${(absolute/1e6).toFixed(2)}M`;if(absolute>=1e3)return `${numeric<0?"-":""}${(absolute/1e3).toFixed(1)}K`;return numeric.toFixed(3)};
  const priceMetric=value=>{const numeric=optionalNumber(value);return Number.isFinite(numeric)?numeric.toFixed(2):"—"};
  const walls=Array.isArray(metrics.gex_walls)?metrics.gex_walls:[];
  const cards=[
    ["REGIME",metrics.regime??"WAIT","FADE = hedge reversion; AMP = directional hedge expansion","IDEAL · FADE OR AMP",checks.regime],
    ["WARM-UP",`${number(model?.history_points)} / 720`,`Five-second chain snapshots required before Gamma 2.0 can qualify`,`IDEAL · 720 SNAPSHOTS`,checks.baseline],
    ["FINAL CLEAN",compact(metrics.final_score_clean),"Filtered setup score; logged for comparison, not a ranking gate","EXPECTED · LOGGED, NOT A GATE",null],
    ["SPOT",priceMetric(metrics.spot),"Underlying price used in chain exposure calculations","EXPECTED · LIVE UNDERLYING",null],
    ["GEX REAL",compact(metrics.gex_real),"Raw GEX adjusted with the inferred OI-delay flow","EXPECTED · CONTEXT ONLY",checks.density],
    ["GEX $ DENSITY",compact(metrics.gex_dollar_density),"Local net GEX density inside plus/minus 0.5 percent of spot","FADE IDEAL · > 100M",checks.density],
    ["TW GEX",compact(metrics.tw_gex),"Mean of the latest 12 GEX-density readings","FADE IDEAL · > 0.700",checks.persistence],
    ["SPOOF",compact(metrics.spoof_score),"dGEX divided by inferred volume; must be below 2","IDEAL · < 2.000",checks.spoof],
    ["RR T+10",compact(metrics.rr_t10),"Projected positive-to-negative inferred flow ratio","FADE IDEAL · > 1.200",checks.flow_ratio],
    ["DR T+10",compact(metrics.dr_t10),"Projected negative inferred-flow pressure ratio","AMP IDEAL · > 0.700",checks.flow_ratio],
    ["EDGE",compact(metrics.edge),"Projected support-to-resistance width divided by ATM spread","IDEAL · > 4.000",checks.edge],
    ["LIQ SCORE",compact(metrics.liquidity_score),"ATM spread divided by key-level displayed depth","IDEAL · < 0.600",checks.liquidity],
    ["ZERO GAMMA",priceMetric(metrics.zero_gamma),"Open-interest-weighted real zero-gamma level","FADE TARGET · Zg",null],
    ["K SUP T+10",priceMetric(metrics.ksup_t10),"Support projected ten minutes forward using Charm exposure","FADE ENTRY · PROJECTED",null],
    ["K RES T+10",priceMetric(metrics.kres_t10),"Resistance projected ten minutes forward using Charm exposure","AMP ENTRY · PROJECTED",null],
    ["ENTRY",priceMetric(metrics.entry),"Model entry level for the active FADE or AMP regime","EXPECTED · ACTIVE REGIME LEVEL",checks.regime],
  ];
  return <section className="gamma-v2-metrics" aria-label="Gamma Dynamics 2.0 live hedge-flow metrics"><header><div><span>LIVE HEDGE-FLOW METRICS</span><small>Current chain confluence · updates every observed snapshot</small></div><b className={`gamma-v2-regime ${(metrics.regime??"WAIT").toLowerCase()}`}>{metrics.regime??"WAIT"}</b></header><div>{cards.map(([label,value,description,expected,passed])=><article className={passed===true?"passed":passed===false?"failed":"neutral"} key={label} title={description}><span>{label}</span><b>{value}</b><small><em>{passed===true?"PASS":passed===false?"WAIT":"INFO"}</em>{expected}</small></article>)}</div><section className="gamma-v2-walls" aria-label="Gamma Dynamics 2.0 GEX walls"><header><span>GEX WALLS · {metrics.pin_status??"OUTSIDE"}</span><small>Largest signed open-interest gamma exposures by strike</small></header><div className="gamma-v2-wall-badges"><b className="call-wall" title="Largest positive signed GEX strike"><small>CALL WALL</small>{priceMetric(metrics.call_wall_strike)} <em>{compact(metrics.call_wall_gex)}</em></b><b className="put-wall" title="Most negative signed GEX strike"><small>PUT WALL</small>{priceMetric(metrics.put_wall_strike)} <em>{compact(metrics.put_wall_gex)}</em></b><b className="zero-gamma-wall" title="Open-interest-weighted real zero gamma"><small>ZG</small>{priceMetric(metrics.zero_gamma)}</b></div>{walls.length?<ol>{walls.map((wall,index)=><li key={`${wall.strike}-${index}`} className={number(wall.side)>=0?"positive":"negative"}><span>#{index+1} · {priceMetric(wall.strike)}</span><b>{compact(wall.gex)}</b><small>{number(wall.distance_pct)>=0?"+":""}{number(wall.distance_pct).toFixed(2)}% · OI {compact(wall.open_interest)}</small></li>)}</ol>:<p>Waiting for a current option-chain wall snapshot.</p>}</section></section>;
}

function DailyMicrostructureModule({report,symbol}){
  const [microSystem,setMicroSystem]=useState("GAMMA_DYNAMICS");
  const formatMicroValue=value=>{const item=optionalNumber(value);if(!Number.isFinite(item))return "—";return Math.abs(item)>=1e9?`${item<0?"-":""}${(Math.abs(item)/1e9).toFixed(2)}B`:Math.abs(item)>=1e6?`${item<0?"-":""}${(Math.abs(item)/1e6).toFixed(1)}M`:item.toFixed(2)};
  const compact=formatMicroValue;
  const tabs=[["GAMMA_DYNAMICS","Gamma Dynamics 1.0"],["GAMMA_DYNAMICS_V2","Gamma Dynamics 2.0"],["DELTA_DYNAMICS","Delta Dynamics"]];
  const selected=tabs.find(([key])=>key===microSystem)?.[1]??"Gamma Dynamics 2.0";
  const tabRows=microSystem==="GAMMA_DYNAMICS_V2"?(report?.key_levels??[]).map(level=>[pretty(level.type),number(level.strike).toFixed(2),compact(level.gex_dollar),`${number(level.distance_pct)>=0?"+":""}${number(level.distance_pct).toFixed(2)}%`]):[["STREAM CONTEXT",microSystem==="GAMMA_DYNAMICS"?"Zomma · Color · Speed · Gamma":"Delta · Gamma · Speed · Color · Zone","LIVE SYSTEM DATA","NO INDEPENDENT WALLS"]];
  const shiftRows=microSystem==="GAMMA_DYNAMICS_V2"?(report?.paradigm_shift_levels??[]):[];
  return <article className="panel daily-microstructure"><header className="panel-head"><div><span>DAILY MICROSTRUCTURE LEVELS</span><h2>{symbol} · {selected}</h2></div><b>{microSystem==="GAMMA_DYNAMICS_V2"?(report?.date??"WAITING"):"STREAM CONTEXT"}</b></header><nav className="daily-micro-tabs" aria-label="Daily Microstructure system tabs">{tabs.map(([key,label])=><button type="button" className={microSystem===key?"active":""} onClick={()=>setMicroSystem(key)} key={key}>{label}</button>)}</nav>{microSystem==="GAMMA_DYNAMICS_V2"?<div className="daily-micro-counts"><span><small>TOTAL WALLS</small><b>{report?.total_levels_count??0}</b></span><span><small>CALL</small><b>{report?.call_levels_count??0}</b></span><span><small>PUT</small><b>{report?.put_levels_count??0}</b></span><span><small>DENSE</small><b>{report?.dense_levels_count??0}</b></span></div>:<div className="daily-micro-counts system-context-counts"><span><small>DAILY STREAM</small><b>LIVE</b></span><span><small>MODEL</small><b>{microSystem==="GAMMA_DYNAMICS"?"4G":"6G"}</b></span><span><small>WALL DATA</small><b>N/A</b></span><span><small>CONTEXT</small><b>CHAIN</b></span></div>}<div className="daily-micro-grid"><section><h3>{microSystem==="GAMMA_DYNAMICS_V2"?"KEY LEVELS":"SUPPORTED DAILY CONTEXT"}</h3><table><thead><tr><th>TYPE</th><th>{microSystem==="GAMMA_DYNAMICS_V2"?"STRIKE":"INPUTS"}</th><th>{microSystem==="GAMMA_DYNAMICS_V2"?"GEX $":"STREAM"}</th><th>{microSystem==="GAMMA_DYNAMICS_V2"?"DISTANCE":"WALL STATUS"}</th></tr></thead><tbody>{tabRows.map((row,index)=><tr key={index}><td>{row[0]}</td><td>{row[1]}</td><td className={String(row[2]).startsWith("-")?"negative":"positive"}>{row[2]}</td><td>{row[3]}</td></tr>)}</tbody></table></section><section><h3>{microSystem==="GAMMA_DYNAMICS_V2"?"PARADIGM SHIFTS":"MODEL NOTE"}</h3>{microSystem==="GAMMA_DYNAMICS_V2"?<table><thead><tr><th>TYPE</th><th>STRIKE</th><th>BEFORE</th><th>AFTER</th></tr></thead><tbody>{shiftRows.map((shift,index)=><tr className={shift.type==="ZERO_CROSS"?"zero-cross":""} key={index}><td>{pretty(shift.type)}</td><td>{number(shift.strike).toFixed(2)}</td><td>{compact(shift.cumulative_gex_before)}</td><td>{compact(shift.cumulative_gex_after)}</td></tr>)}</tbody></table>:<p>This tab uses its own streamed Greek or zone logic. It receives Gamma 2.0’s chain map as context only, and never fabricates a separate call or put wall.</p>}{microSystem==="GAMMA_DYNAMICS_V2"&&!shiftRows.length&&<p>Waiting for enough chain history to identify a level shift.</p>}</section></div><footer>{microSystem==="GAMMA_DYNAMICS_V2"?"Full daily wall and GEX analysis from the per-strike Gamma 2.0 chain.":"System-specific daily context based only on observable inputs."}</footer></article>;
  if(microSystem!=="GAMMA_DYNAMICS_V2")return <article className="panel daily-microstructure"><header className="panel-head"><div><span>DAILY MICROSTRUCTURE LEVELS</span><h2>{symbol} · {selected}</h2></div><b>STREAM CONTEXT</b></header><nav className="daily-micro-tabs">{tabs.map(([key,label])=><button type="button" className={microSystem===key?"active":""} onClick={()=>setMicroSystem(key)} key={key}>{label}</button>)}</nav><div className="daily-micro-counts system-context-counts"><span><small>DAILY STREAM</small><b>LIVE</b></span><span><small>MODEL</small><b>{microSystem==="GAMMA_DYNAMICS"?"4G":"6G"}</b></span><span><small>WALL DATA</small><b>N/A</b></span><span><small>CONTEXT</small><b>CHAIN</b></span></div><div className="daily-micro-grid"><section><h3>SUPPORTED DAILY CONTEXT</h3><table><thead><tr><th>MODEL</th><th>OBSERVABLE INPUTS</th><th>WALL STATUS</th></tr></thead><tbody><tr><td>{selected}</td><td>{microSystem==="GAMMA_DYNAMICS"?"Zomma · Color · Speed · Gamma":"Delta · Gamma · Speed · Color · Zone"}</td><td>NO INDEPENDENT PER-STRIKE GEX</td></tr></tbody></table></section><section><h3>MODEL NOTE</h3><p>This system uses its own streamed Greek / zone logic. Gamma 2.0's wall map remains visible only in its dedicated tab, so no separate walls are fabricated.</p></section></div><footer>System-specific daily context only · shared option-chain structure is not re-labeled as a 1.0 or Delta wall.</footer></article>;
  const legacyCompact=value=>{const item=optionalNumber(value);if(!Number.isFinite(item))return "—";return Math.abs(item)>=1e9?`${item<0?"-":""}${(Math.abs(item)/1e9).toFixed(2)}B`:Math.abs(item)>=1e6?`${item<0?"-":""}${(Math.abs(item)/1e6).toFixed(1)}M`:item.toFixed(2)};
  const levels=report?.key_levels??[],shifts=report?.paradigm_shift_levels??[];
  return <article className="panel daily-microstructure"><header className="panel-head"><div><span>DAILY MICROSTRUCTURE LEVELS</span><h2>{symbol} · full-day shared option-chain structure</h2></div><b>{report?.date??"WAITING"}</b></header><div className="daily-micro-counts"><span><small>TOTAL WALLS</small><b>{report?.total_levels_count??0}</b></span><span><small>CALL</small><b>{report?.call_levels_count??0}</b></span><span><small>PUT</small><b>{report?.put_levels_count??0}</b></span><span><small>DENSE</small><b>{report?.dense_levels_count??0}</b></span></div><div className="daily-micro-grid"><section><h3>KEY LEVELS</h3><table><thead><tr><th>TYPE</th><th>STRIKE</th><th>GEX $</th><th>OI</th><th>DISTANCE</th></tr></thead><tbody>{levels.map((level,index)=><tr key={`${level.type}-${index}`}><td>{pretty(level.type)}</td><td>{number(level.strike).toFixed(2)}</td><td className={number(level.side)>=0?"positive":"negative"}>{compact(level.gex_dollar)}</td><td>{number(level.oi).toLocaleString()}</td><td>{number(level.distance_pct)>=0?"+":""}{number(level.distance_pct).toFixed(2)}%</td></tr>)}</tbody></table></section><section><h3>PARADIGM SHIFTS</h3><table><thead><tr><th>TYPE</th><th>STRIKE</th><th>BEFORE</th><th>AFTER</th></tr></thead><tbody>{shifts.map((shift,index)=><tr className={shift.type==="ZERO_CROSS"?"zero-cross":""} key={`${shift.type}-${index}`}><td>{pretty(shift.type)}</td><td>{number(shift.strike).toFixed(2)}</td><td>{compact(shift.cumulative_gex_before)}</td><td>{compact(shift.cumulative_gex_after)}</td></tr>)}</tbody></table>{!shifts.length&&<p>Waiting for enough chain history to identify a level shift.</p>}</section></div><footer>Gamma 2.0 uses the complete wall/GEX model. Gamma 1.0 and Delta Dynamics share this daily chain map as market context; they do not fabricate separate wall calculations.</footer></article>;
}

function GammaDynamicsModule({state,history,symbol,engine,version=1}){
  const v2=version===2,quartet=v2?deriveGammaDynamicsV2(state,history):deriveGammaDynamics(state,history),greekNames=v2?GAMMA_DYNAMICS_V2_GREEKS:GAMMA_DYNAMICS_GREEKS,tone=!quartet.qualified?"wait":quartet.decision==="UP"?"long":"short",label=quartet.qualified?(quartet.decision==="UP"?"UPWARD PRESSURE":"DOWNWARD PRESSURE"):"WAIT";
  const metadata={zomma:["VOLATILITY INTENSITY","Gamma sensitivity to implied volatility"],color:["TIME INTENSITY","Gamma sensitivity to time"],speed:["SPOT PRESSURE","Gamma sensitivity to spot"],gamma:["CURVATURE BASE","Delta sensitivity to spot"],ultima:["VOLATILITY INSTABILITY","Vomma sensitivity to implied volatility"],vomma:["VOLATILITY CONVEXITY","Vega sensitivity to implied volatility"]};
  const normalizedSpeed=number(quartet.normalized?.speed),normalizedGamma=number(quartet.normalized?.gamma),aligned=v2?((normalizedSpeed>=GAMMA_DYNAMICS_V2_IDEALS.speed.threshold&&normalizedGamma>=GAMMA_DYNAMICS_V2_IDEALS.gamma.threshold)||(normalizedSpeed<=-GAMMA_DYNAMICS_V2_IDEALS.speed.threshold&&normalizedGamma<=-GAMMA_DYNAMICS_V2_IDEALS.gamma.threshold)):Math.abs(number(quartet.inputs?.speed))>1e-12&&Math.abs(number(quartet.inputs?.gamma))>1e-12,warmed=number(quartet.history_points)>=(v2?720:20),warmupRequired=v2?720:20,intensityPassed=number(quartet.intensity)>=number(quartet.intensity_threshold,.65);
  const datum=number(state?.supporting_indicators?.price,NaN),target=gammaReachFromDatum(datum,quartet.decision==="NEUTRAL"?(number(quartet.inputs?.speed)>=0?"UP":"DOWN"):quartet.decision,state?.timestamp);
  const greekGroups=v2?[greekNames.slice(0,4),greekNames.slice(4)]:[greekNames];
  return <section className={`gamma-dynamics gamma-dynamics-${tone} ${v2?"gamma-dynamics-v2":"gamma-dynamics-v1"}`} aria-live="polite"><header><div><span>GAMMA DYNAMICS {version}.0 · {v2?"SIX":"FOUR"}-GREEK ENGINE</span><h2>{symbol} · {label}</h2><small>{engine.running?"● LIVE OPTIONS PRO":"○ ENGINE IDLE"} · relative to the latest {quartet.history_points??0} observations</small></div><div className="gamma-dynamics-score"><span>DYNAMICS INTENSITY</span><b>{pct(quartet.intensity)}</b><small>Ideal ≥ {pct(quartet.intensity_threshold??.65)}</small></div><div className="gamma-dynamics-score pressure"><span>CURVATURE PRESSURE</span><b>{number(quartet.pressure)>0?"+":""}{number(quartet.pressure).toFixed(2)}</b><small>Direction: Speed · Base: Gamma magnitude</small></div></header><div className="gamma-six-target"><span>QQQ SESSION TARGET <b>{gammaTargetPoints(state?.timestamp).toFixed(2)} PT</b></span><span>PROJECTED REACH <b>{Number.isFinite(target)?target.toFixed(4):"—"}</b></span><small>1.25 points from 9:30 AM–12:00 PM EST · 0.75 points at all other times</small></div>{v2&&<GammaDynamicsV2Metrics model={quartet}/>}<div className="gamma-dynamics-ideals"><span className={intensityPassed?"passed":"waiting"}><b>{intensityPassed?"PASS":"WAIT"}</b> Weighted |normalized| intensity ≥ {pct(quartet.intensity_threshold??.65)}</span><span className={aligned?"passed":"waiting"}><b>{aligned?"PASS":"WAIT"}</b> Speed directional + Gamma active</span><span className={warmed?"passed":"waiting"}><b>{warmed?"PASS":"WAIT"}</b> Baseline ≥ {warmupRequired} observations</span></div><div className="gamma-greek-groups">{greekGroups.map((group,groupIndex)=><section className="gamma-greek-group" key={`greek-group-${groupIndex}`}><div className="gamma-dynamics-grid gamma-actual-grid gamma-four-grid">{group.map(name=>{const value=quartet.inputs?.[name],ideal=gammaGreekIdeal(name,quartet),closeness=gammaGreekCloseness(name,quartet,v2);return <article className={ideal?"greek-ideal":"greek-not-ideal"} key={name}><div><span>{name.toUpperCase()}</span><small>{metadata[name][0]}</small></div><b>{signedGreek(value)} <small>RAW</small><small className={`ideal-distance ${ideal?"above":"below"}`}>{closeness.toFixed(1)}% OF IDEAL</small></b><i><em style={{width:`${Math.max(2,closeness)}%`}}/></i><p>{metadata[name][1]}</p></article>})}</div><div className="gamma-ideal-values-grid gamma-four-grid">{group.map(name=>{const scaled=number(quartet.normalized?.[name]),spec=gammaGreekIdealSpec(name,v2);return <article key={name}><span>{name.toUpperCase()} · NORMALIZED / IDEAL</span><div><b>{scaled>=0?"+":""}{scaled.toFixed(3)} <small>CURRENT NORM</small></b><strong>{spec.label}</strong></div><small>{spec.description}</small></article>})}</div></section>)}</div><footer><b>Interpretation:</b> {quartet.explanation}<small>Each raw-value row is followed by its matching normalized/ideal row. Each percentage measures progress toward that Greek's own deterministic threshold and is capped at 100%.</small></footer></section>;
}

function deltaDynamicsMinuteRows(history=[],state,symbol){
  const stream=[...history.filter(row=>row?.timestamp&&row?.symbol===symbol)];
  if(state?.timestamp&&state?.symbol===symbol&&!stream.some(row=>row.timestamp===state.timestamp))stream.push(state);
  stream.sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
  const minutes=new Map(),rolling=[];
  stream.forEach(row=>{
    const model=deriveSixGreekDynamics(row,rolling);
    const eastern=easternFilterParts(row.timestamp),key=`${eastern.date} ${eastern.time}`;
    minutes.set(key,{timestamp:row.timestamp,symbol:row.symbol??symbol,inputs:Object.fromEntries(SIX_GREEKS.map(name=>[name,greekValue(row,name)])),qualified:Boolean(model.qualified),zone:model.zone,decision:model.decision,score:model.score});
    rolling.push(row);if(rolling.length>100)rolling.shift();
  });
  return [...minutes.values()];
}

function SixGreekDynamicsModule({state,history,symbol,engine}){
  const model=deriveSixGreekDynamics(state,history),direction=model.qualified?model.decision:"WAIT",tone=direction==="UP"?"long":direction==="DOWN"?"short":"wait";
  const datum=number(state?.supporting_indicators?.price,NaN),strike=referenceStrike(state,datum),reach=reachFromDatum(datum,model.raw_direction,state?.timestamp);
  const roles={ultima:"VOL CONVEXITY",zomma:"VOL → GAMMA",gamma:"CURVATURE",speed:"SPOT ACCELERATION",color:"TIME DECAY",delta:"PRIMARY DIRECTION"};
  return <section className={`gamma-dynamics six-greek-dynamics gamma-dynamics-${tone}`}>
    <header><div><span>DELTA DYNAMICS</span><h2>{symbol} · {direction==="UP"?"LONG":direction==="DOWN"?"SHORT":"WAIT"}</h2><small>{engine.running?"● LIVE OPTIONS PRO":"○ ENGINE IDLE"} · {model.session.label} · {model.history_points} rolling observations</small></div><div className="gamma-dynamics-score"><span>ACTIVE ZONE</span><b className="zone-name">{pretty(model.zone??"NO_ZONE")}</b><small>{model.checks?.filter(check=>check.p).length??0} / {model.checks?.length??0} formula gates</small></div><div className="gamma-dynamics-score pressure"><span>ZONE MATCH SCORE</span><b>{pct(model.score)}</b><small>Confidence {pct(model.confidence)}</small></div></header>
    <div className="six-greek-price-strip"><span>SESSION TARGET · {sessionTargetPoints(state?.timestamp).toFixed(2)} PT <b>{Number.isFinite(reach)?reach.toFixed(4):"—"}</b></span><span>DATUM <b>{Number.isFinite(datum)?datum.toFixed(4):"—"}</b></span><span>{strike.estimated?"REFERENCE STRIKE":"STRIKE"} <b>{Number.isFinite(strike.value)?strike.value.toFixed(2):"—"}</b></span><span>MARKET HOUR <b>{model.session.label}</b></span></div>
    <div className="gamma-dynamics-ideals">{(model.checks??[]).map(check=><span className={check.p?"passed":"waiting"} key={check.n}><b>{check.p?"PASS":"WAIT"}</b> {check.n}</span>)}</div>
    <div className="gamma-dynamics-grid six-greek-grid">{SIX_GREEKS.map(name=>{const scaled=number(model.scaled?.[name]);return <article key={name}><div><span>{name.toUpperCase()}</span><small>{roles[name]}</small></div><b>{scaled>=0?"+":""}{scaled.toFixed(3)}</b><i><em style={{width:`${Math.max(2,Math.abs(scaled)*100)}%`}}/></i><p>Raw {signedGreek(model.inputs?.[name])} · z-score scaled</p><strong>{model.bands?.[name]??"WAITING"}</strong></article>})}</div>
    <footer><b>Interpretation:</b> {model.explanation}<small>Each Greek is normalized as clip((value − rolling mean) / rolling standard deviation, −3, 3) / 3. Calls require every numerical gate for the active Eastern-time zone.</small></footer>
  </section>;
}

function SixGreekDynamicsCharts({history=[],state,symbol}){
  const rows=[...history.filter(row=>row?.symbol===symbol)];if(state?.symbol===symbol&&!rows.some(row=>row.timestamp===state.timestamp))rows.push(state);
  const visible=rows.sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp)).slice(-90);
  const normalized=visible.map((row,index)=>deriveSixGreekDynamics(row,visible.slice(Math.max(0,index-100),index)));
  return <article className="panel six-greek-chart-panel"><header className="panel-head"><div><span>DELTA DYNAMICS · NORMALIZED GRAPH LOGS</span><h2>{symbol} · normalized [-1, 1] · latest 90 observations</h2></div></header><div className="six-greek-sparklines">{SIX_GREEKS.map(name=>{const values=normalized.map(model=>model.scaled?.[name]).filter(Number.isFinite);return <div key={name}><header><b>{name.toUpperCase()}</b><span>{number(values.at(-1))>=0?"+":""}{number(values.at(-1)).toFixed(3)}</span></header><Sparkline values={values} color={GREEK_COLORS[name]}/><small>{values.length?`${sixGreekBand(number(values.at(-1)))} · ${values.length} points`:"Waiting for stream"}</small></div>})}</div></article>;
}

function SixGreekDynamicsLog({history,state,symbol,calls=[]}){
  const events=useMemo(()=>{
    const persisted=calls.map(call=>{const snapshot=call.zone_intelligence_at_signal??{},datum=number(call.entry_price),strike=referenceStrike(call,datum);return {
      id:visibleCallId(call,"DELTA_DYNAMICS"),timestamp:call.alerted_at,symbol:call.symbol??symbol,datum,strike,
      reach:number(call.target_price,reachFromDatum(datum,call.direction,call.alerted_at)),decision:call.direction,zone:snapshot.zone??"NO_ZONE",
      score:number(snapshot.score),confidence:number(snapshot.confidence),session:{label:pretty(snapshot.zone??marketHourLabel(call.alerted_at))},
      scaled:snapshot.normalized??{},persisted:true,call};});
    return [...new Map([...persisted,...deriveSixGreekEvents(history,state,symbol)].map(event=>[event.id,event])).values()].sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp));
  },[history,state,symbol,calls]);
  return <article className="panel gamma-dynamics-log six-greek-log"><header className="panel-head"><div><span>DELTA DYNAMICS EVENT LOG</span><h2>Qualified zone formulas · session-aware target reach</h2></div><b>{events.length} EVENTS</b></header><div className="gamma-log-scroll"><table><thead><tr><th>CALL</th><th>ZONE</th><th>STREAM DURATION</th><th>TIME · MS</th><th>DATE · EASTERN</th><th>MARKET HOUR</th><th>SYMBOL</th><th>DATUM</th><th>SESSION TARGET</th><th>STRIKE / REFERENCE</th><th>MATCH</th><th>CONFIDENCE</th>{SIX_GREEKS.map(name=><th key={name}>{name.toUpperCase()} · SCALED</th>)}<th>EVENT ID</th></tr></thead><tbody>{events.map(event=><tr key={event.id}><td><span className={`direction-pill ${event.decision.toLowerCase()}`}>{biasLabel(event.decision)}</span></td><td>{pretty(event.zone)}</td><td className="stream-duration">{event.call?callStreamDuration(event.call):"—"}</td><td>{logTime(event.timestamp)}</td><td>{logDate(event.timestamp)}</td><td><span className="market-hour">{event.session.label}</span></td><td>{event.symbol}</td><td className="extreme-price">{event.datum.toFixed(4)}</td><td className="extreme-price">{event.reach.toFixed(4)}</td><td className="extreme-price">{event.strike.estimated?"REF ":""}{event.strike.value.toFixed(2)}</td><td>{pct(event.score)}</td><td>{pct(event.confidence)}</td>{SIX_GREEKS.map(name=><td key={name}>{number(event.scaled?.[name])>=0?"+":""}{number(event.scaled?.[name]).toFixed(3)}</td>)}<td><button type="button" className="call-id" onClick={()=>navigator.clipboard.writeText(event.id)}>{event.id}</button></td></tr>)}</tbody></table>{!events.length&&<div className="gamma-log-empty"><b>NO QUALIFIED DELTA DYNAMICS ZONE YET</b><p>Calls require 20 rolling observations and every numerical gate in the active market-time formula.</p></div>}</div></article>;
}

function DeltaDynamicsEventLogLegacy({history,state,symbol,calls=[]}){
  const [sortOrder,setSortOrder]=useState("newest"),[filterDate,setFilterDate]=useState(""),[fromTime,setFromTime]=useState(""),[toTime,setToTime]=useState(""),[copied,setCopied]=useState(false);
  const rows=useMemo(()=>calls.map(call=>{const snapshot=call.zone_intelligence_at_signal??{},datum=number(call.entry_price),strike=referenceStrike(call,datum);return {id:visibleCallId(call,"DELTA_DYNAMICS"),timestamp:call.alerted_at,symbol:call.symbol??symbol,datum,strike,reach:number(call.target_price,reachFromDatum(datum,call.direction,call.alerted_at)),decision:call.direction,zone:snapshot.zone??"NO_ZONE",score:number(snapshot.score),confidence:number(snapshot.confidence),scaled:snapshot.normalized??{},call}}),[calls,symbol]);
  const visible=useMemo(()=>rows.filter(row=>{const parts=easternFilterParts(row.timestamp);return (!filterDate||parts.date===filterDate)&&timeRangeMatches(parts.time,fromTime,toTime)}).sort((a,b)=>(sortOrder==="oldest"?1:-1)*(new Date(a.timestamp)-new Date(b.timestamp))),[rows,sortOrder,filterDate,fromTime,toTime]);
  const copy=async()=>{
    const headers=["Direction","Zone","Stream Duration","High Change","Time · MS","Date · Eastern","Market Hour","Source","Datum / Alert Price","Session Target","Strike / Reference","Dynamic / Extreme High","Time to High","Dynamic / Extreme Low","Low Change","Time to Low","Current / Final","Call State","Zone Match","Confidence",...SIX_GREEKS.flatMap(name=>[`${name.toUpperCase()} High`,`${name.toUpperCase()} Low`]),"Event ID"];
    const parentRows=visible.map(row=>{const call=row.call,high=number(call.highest_price,call.dynamic_high),low=number(call.lowest_price,call.dynamic_low),current=number(call.current_price??call.final_price??call.minute_bars?.at(-1)?.close,NaN),change=value=>Number.isFinite(value)?(value-row.datum).toFixed(4):"";return [row.decision==="UP"?"UPWARD":"DOWNWARD",pretty(row.zone),callStreamDuration(call),change(high),logTime(row.timestamp),logDate(row.timestamp),marketHourLabel(row.timestamp),row.symbol,row.datum.toFixed(4),row.reach.toFixed(4),`${row.strike.estimated?"REF ":""}${row.strike.value.toFixed(2)}`,Number.isFinite(high)?high.toFixed(4):"—",duration(call.seconds_to_high),Number.isFinite(low)?low.toFixed(4):"—",change(low),duration(call.seconds_to_low),Number.isFinite(current)?current.toFixed(4):"—",call.status??"TRACKING",pct(row.score),pct(row.confidence),...SIX_GREEKS.flatMap(name=>{const signal=call.greek_values_at_signal?.[name];return [signedGreek(call.greek_values_highest?.[name]??signal),signedGreek(call.greek_values_lowest?.[name]??signal)]}),row.id]});
    const childHeaders=["Parent Event ID","Leg","Child ID","Role","Status","Activated · ET","Datum","Current / Final","Leg P/L"];
    const childRows=visible.flatMap(row=>(row.call.family_legs??[]).map(leg=>{const price=leg.final_price!=null?number(leg.final_price):number(row.call.current_price??row.call.final_price,leg.datum),pl=leg.current_pl_points!=null?number(leg.current_pl_points):(row.call.direction==="UP"?price-number(leg.datum):number(leg.datum)-price);return [row.id,leg.leg_number,leg.call_id,leg.role,leg.status??"TRACKING",`${logDate(leg.activated_at)} · ${logTime(leg.activated_at)}`,number(leg.datum).toFixed(4),price.toFixed(4),`${pl>=0?"+":""}${pl.toFixed(4)} pts`]}));
    try{await navigator.clipboard.writeText([exportTsv(`DELTA DYNAMICS EVENT LOG · ${symbol} · EASTERN TIME`,headers,parentRows),exportTsv("DELTA DYNAMICS CHILD LEGS",childHeaders,childRows)].join("\n\n"));setCopied(true);setTimeout(()=>setCopied(false),1200)}catch{setCopied(false)}
  };
  return <article className="panel gamma-dynamics-log delta-dynamics-log"><header className="panel-head"><div><span>DELTA DYNAMICS EVENT LOG</span><h2>Every qualified call · observed minute high/low path</h2></div><div className="gamma-log-actions"><button type="button" className="copy-table" onClick={copy} disabled={!visible.length}>{copied?"✓ COPIED":"COPY SUMMARIES"}</button><b>{visible.length} EVENTS</b></div></header>
    <div className="gamma-log-controls"><label>SORT<select value={sortOrder} onChange={event=>setSortOrder(event.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label><label>DATE<input type="date" value={filterDate} onChange={event=>setFilterDate(event.target.value)}/></label><CompactEventTimeFilter label="FROM" value={fromTime} onChange={setFromTime}/><CompactEventTimeFilter label="TO" value={toTime} onChange={setToTime}/><button type="button" onClick={()=>{setFilterDate("");setFromTime("");setToTime("")}}>CLEAR FILTER</button></div>
    <div className="gamma-log-scroll"><table><thead><tr><th>DIRECTION</th><th>ZONE</th><th>STREAM DURATION</th><th>HIGH CHANGE</th><th>TIME · MS</th><th>DATE · EASTERN</th><th>MARKET HOUR</th><th>SOURCE</th><th>DATUM / ALERT PRICE</th><th>1.25-PT REACH</th><th>STRIKE / REFERENCE</th><th>DYNAMIC / EXTREME HIGH</th><th>TIME TO HIGH</th><th>DYNAMIC / EXTREME LOW</th><th>LOW CHANGE</th><th>TIME TO LOW</th><th>CURRENT / FINAL</th><th>CALL STATE</th><th>ZONE MATCH</th><th>CONFIDENCE</th>{SIX_GREEKS.flatMap(name=>[<th key={`${name}-high`}>{name.toUpperCase()} HIGH</th>,<th key={`${name}-low`}>{name.toUpperCase()} LOW</th>])}<th>EVENT ID</th></tr></thead><tbody>{visible.map(row=>{const call=row.call,high=number(call.highest_price,call.dynamic_high),low=number(call.lowest_price,call.dynamic_low),current=number(call.current_price??call.final_price??call.minute_bars?.at(-1)?.close,NaN),change=value=>Number.isFinite(value)?`${value-row.datum>=0?"+":""}${(value-row.datum).toFixed(4)} pts`:"—";return <Fragment key={row.id}><tr className={row.decision==="UP"?"gamma-call-tracking-success":"gamma-call-tracking-failing"}><td><span className={`direction-pill ${row.decision.toLowerCase()}`}>{row.decision==="UP"?"UPWARD":"DOWNWARD"}</span></td><td>{pretty(row.zone)}</td><td className="stream-duration">{callStreamDuration(call)}</td><td>{change(high)}</td><td>{logTime(row.timestamp)}</td><td>{logDate(row.timestamp)}</td><td><span className="market-hour">{marketHourLabel(row.timestamp)}</span></td><td>{row.symbol}</td><td className="extreme-price">{row.datum.toFixed(4)}</td><td className="extreme-price">{row.reach.toFixed(4)}</td><td className="extreme-price">{row.strike.estimated?"REF ":""}{row.strike.value.toFixed(2)}</td><td className="extreme-price">{Number.isFinite(high)?high.toFixed(4):"—"}</td><td>{duration(call.seconds_to_high)}</td><td className="extreme-price">{Number.isFinite(low)?low.toFixed(4):"—"}</td><td>{change(low)}</td><td>{duration(call.seconds_to_low)}</td><td className="extreme-price">{Number.isFinite(current)?current.toFixed(4):"—"}</td><td><span className={`gamma-call-state ${call.status==="TARGET_REACHED"?"success":"tracking-success"}`}>{call.status??"TRACKING"}</span></td><td>{pct(row.score)}</td><td>{pct(row.confidence)}</td>{SIX_GREEKS.flatMap(name=>{const signal=call.greek_values_at_signal?.[name];return [<td className="greek-extreme-high" key={`${name}-high`}>{signedGreek(call.greek_values_highest?.[name]??signal)}</td>,<td className="greek-extreme-low" key={`${name}-low`}>{signedGreek(call.greek_values_lowest?.[name]??signal)}</td>]})}<td><button type="button" className="call-id" onClick={()=>navigator.clipboard.writeText(row.id)}>{row.id}</button></td></tr>{call.family_legs?.length>0&&<tr className="gamma-family-dropdown-row"><td colSpan={33}><details><summary>SHOW CHILD LEGS · {call.family_stage} · AVG DATUM {number(call.family_average_datum).toFixed(4)} · AVG P/L {number(call.family_average_pl_points)>=0?"+":""}{number(call.family_average_pl_points).toFixed(4)} PTS</summary><div className="risk-leg-table-wrap"><table className="risk-leg-table"><thead><tr><th>LEG</th><th>CHILD ID</th><th>ROLE</th><th>STATUS</th><th>ACTIVATED · ET</th><th>DATUM</th><th>CURRENT / FINAL</th><th>LEG P/L</th></tr></thead><tbody>{call.family_legs.map(leg=>{const price=number(call.current_price??call.final_price,leg.datum),pl=call.direction==="UP"?price-number(leg.datum):number(leg.datum)-price;return <tr key={leg.call_id}><td>{leg.leg_number}</td><td><button type="button" className="call-id" onClick={()=>navigator.clipboard.writeText(leg.call_id)}>{leg.call_id}</button></td><td>{leg.role}</td><td>{leg.status??"TRACKING"}</td><td>{logDate(leg.activated_at)} · {logTime(leg.activated_at)}</td><td>{number(leg.datum).toFixed(4)}</td><td>{price.toFixed(4)}</td><td>{pl>=0?"+":""}{pl.toFixed(4)} pts</td></tr>})}</tbody></table></div></details></td></tr>}</Fragment>})}</tbody></table>{!visible.length&&<div className="gamma-log-empty"><b>NO QUALIFIED DELTA DYNAMICS EVENT YET</b><p>Calls appear after the active market-zone formulas qualify.</p></div>}</div>
  </article>;
}

function GammaDynamicsChart({history=[],state,symbol,deltaMode=false,gammaVersion=1}){
  const v2=gammaVersion===2,series=deltaMode?[["ultima","#c77dff","VOL CONVEXITY"],["zomma","#06d6a0","VOL TO GAMMA"],["gamma","#4cc9f0","CURVATURE"],["speed","#ef476f","SPOT ACCELERATION"],["color","#f4d35e","TIME DECAY"],["delta","#ff5c8a","PRIMARY DIRECTION"]]:v2?[["zomma","#06d6a0","VOL INTENSITY"],["color","#f4d35e","TIME INTENSITY"],["speed","#ef476f","SPOT PRESSURE"],["gamma","#4cc9f0","CURVATURE"],["vomma","#ff9f1c","VOL CONVEXITY"],["ultima","#c77dff","VOL INSTABILITY"]]:[["zomma","#06d6a0","VOL INTENSITY"],["color","#f4d35e","TIME INTENSITY"],["speed","#ef476f","SPOT PRESSURE"],["gamma","#4cc9f0","CURVATURE"]];
  const [intervalSeconds,setIntervalSeconds]=useState(5),[expanded,setExpanded]=useState(false),[zoom,setZoom]=useState(1),[cursor,setCursor]=useState(null),[showMinuteStream,setShowMinuteStream]=useState(false),[streamCopied,setStreamCopied]=useState(false),[greeksCopied,setGreeksCopied]=useState(false);
  const drag=useRef(null),viewport=useGreekViewport(history,state,symbol,intervalSeconds,Math.max(12,Math.round((expanded?140:90)/zoom))),rows=viewport.visible,streamRows=viewport.rows;
  const minuteStream=useMemo(()=>deltaMode?deltaDynamicsMinuteRows(history,state,symbol):[],[deltaMode,history,state,symbol]);
  const copyMinuteStream=async()=>{
    const headers=["Date · Eastern","Time · Eastern","Symbol","Confluence","Zone","Direction",...SIX_GREEKS.map(name=>name.toUpperCase())];
    const values=minuteStream.map(row=>[logDate(row.timestamp),logTime(row.timestamp),row.symbol,row.qualified?"YES":"NO",pretty(row.zone),biasLabel(row.decision),...SIX_GREEKS.map(name=>Number.isFinite(row.inputs[name])?row.inputs[name]:"")]);
    try{await navigator.clipboard.writeText(exportTsv(`DELTA DYNAMICS MINUTE STREAM · ${symbol} · EASTERN TIME`,headers,values));setStreamCopied(true);setShowMinuteStream(true);setTimeout(()=>setStreamCopied(false),1800)}catch{setStreamCopied(false)}
  };
  const dims={width:1200,height:expanded?(deltaMode?820:860):(deltaMode?610:650),left:deltaMode?190:150,right:30,top:20,bottom:58},plotWidth=dims.width-dims.left-dims.right,plotHeight=dims.height-dims.top-dims.bottom,laneHeight=plotHeight/series.length;
  const gammaModelFor=row=>v2?deriveGammaDynamicsV2(row?{...row,gamma_dynamics_v2:null}:row,rows.filter(candidate=>new Date(candidate.timestamp)<new Date(row?.timestamp)).slice(-100)):deriveGammaDynamics(row?{...row,gamma_dynamics:null}:row,rows.filter(candidate=>new Date(candidate.timestamp)<new Date(row?.timestamp)).slice(-100)),valueFor=(row,name)=>deltaMode?optionalNumber(row?.zone_intelligence?.normalized?.[name]??greekValue(row,name)):optionalNumber((v2?row?.gamma_dynamics_v2:row?.gamma_dynamics)?.normalized?.[name]??gammaModelFor(row).normalized?.[name]),rawValueFor=(row,name)=>deltaMode?optionalNumber(greekValue(row,name)):optionalNumber((v2?row?.gamma_dynamics_v2:row?.gamma_dynamics)?.inputs?.[name]??gammaModelFor(row).inputs?.[name]),formatValue=value=>Number.isFinite(Number(value))?`${number(value)>=0?"+":""}${number(value).toFixed(3)}`:"--",formatTime=chartTime;
  const copyChartGreeks=async()=>{
    const headers=["Date · Eastern","Time · Eastern","Symbol",...series.flatMap(([name])=>[`${name.toUpperCase()} · RAW`,`${name.toUpperCase()} · NORMALIZED`])];
    const values=streamRows.map(row=>[logDate(row.timestamp),logTime(row.timestamp),row.symbol??symbol,...series.flatMap(([name])=>{const raw=rawValueFor(row,name),normalized=valueFor(row,name);return [Number.isFinite(raw)?raw:"",Number.isFinite(normalized)?normalized:""]})]);
    try{await navigator.clipboard.writeText(exportTsv(`${deltaMode?"DELTA DYNAMICS":`GAMMA DYNAMICS ${gammaVersion}.0`} · GREEKS AT TIMESTAMPS · ${symbol} · EASTERN TIME`,headers,values));setGreeksCopied(true);setTimeout(()=>setGreeksCopied(false),1800)}catch{setGreeksCopied(false)};
  };
  const ranges=Object.fromEntries(series.map(([name])=>{const values=rows.map(row=>valueFor(row,name)).filter(Number.isFinite),minimum=values.length?Math.min(...values):0,maximum=values.length?Math.max(...values):0,center=(minimum+maximum)/2,raw=maximum-minimum,padding=Math.max(raw*.14,Math.abs(center)*.002,1e-12);return [name,{minimum:minimum-padding,maximum:maximum+padding}]}));
  const x=index=>dims.left+index*plotWidth/Math.max(1,rows.length-1),y=(value,name)=>{const index=series.findIndex(([key])=>key===name),range=ranges[name],top=dims.top+index*laneHeight+10,bottom=dims.top+(index+1)*laneHeight-10;return top+(range.maximum-value)*(bottom-top)/Math.max(range.maximum-range.minimum,1e-15)};
  const hovered=rows[cursor?.index??rows.length-1],zoomChart=(amount,anchorIndex=cursor?.index??rows.length-1)=>{const next=Math.max(1,Math.min(8,Math.round((zoom+amount)*2)/2));if(next===zoom)return;const fraction=rows.length>1?anchorIndex/(rows.length-1):1,globalIndex=viewport.rows.length-viewport.offset-rows.length+anchorIndex,nextCount=Math.max(12,Math.round((expanded?140:90)/next)),nextIndex=Math.round(fraction*Math.max(nextCount-1,0)),nextOffset=Math.max(0,Math.min(Math.max(0,viewport.rows.length-nextCount),viewport.rows.length-(globalIndex-nextIndex+nextCount)));setZoom(next);viewport.setOffset(nextOffset);setCursor(current=>current?{...current,index:nextIndex}:current)};
  const cursorAt=event=>chartCursor(event,dims,rows.length,1),onPointerMove=event=>{const next=cursorAt(event);setCursor(next);if(drag.current){const delta=event.clientX-drag.current.x;if(Math.abs(delta)>3)drag.current.moved=true;viewport.setOffset(Math.max(0,Math.min(viewport.maxOffset,drag.current.offset-Math.round(delta/7))))}},onPointerDown=event=>{drag.current={x:event.clientX,offset:viewport.offset,moved:false};event.currentTarget.setPointerCapture(event.pointerId)},onPointerUp=()=>{if(!expanded&&!drag.current?.moved)setExpanded(true);drag.current=null};
  return <ChartShell expanded={expanded} setExpanded={setExpanded} className={`gamma-dynamics-history-chart gamma-dynamics-chart ${deltaMode?"delta-dynamics-chart":v2?"gamma-dynamics-v2-chart":""}`}>
    <div className="greek-chart-header"><div><span>{deltaMode?"DELTA DYNAMICS HISTORY":`GAMMA DYNAMICS ${gammaVersion}.0 HISTORY · NORMALIZED LIVE STREAM`}</span><h2>{symbol} · {deltaMode?"Ultima / Zomma / Gamma / Speed / Color / Delta":series.map(item=>pretty(item[0])).join(" / ")}</h2></div><div className="greek-header-actions">{deltaMode&&<button type="button" className="copy-table delta-minute-stream-button" onClick={copyMinuteStream} disabled={!minuteStream.length}>{streamCopied?"✓ COPIED":"COPY MINUTE STREAM"}</button>}<button type="button" className="copy-table" onClick={copyChartGreeks} disabled={!streamRows.length}>{greeksCopied?"✓ COPIED":"COPY GREEKS"}</button><ChartTimeControls {...{intervalSeconds,setIntervalSeconds,isLive:viewport.isLive,setOffset:viewport.setOffset,expanded,setExpanded,zoom,onZoom:zoomChart}}/></div></div>
    <div className="greek-chart-legend">{series.map(([name,color,role])=><div key={name}><i style={{backgroundColor:color}}/><span>{name.toUpperCase()} · {role}</span><b>{formatValue(valueFor(rows.at(-1),name))}</b></div>)}</div>
    <div className="triad-chart-note">{deltaMode?"Each variable uses its own visible-range scale so small real values remain legible. Hover values stay unscaled.":"Every live lane uses its rolling clipped z-score scale [-1, +1], making unlike Greek units comparable without altering stored raw values."}</div>
    <div className="greek-chart-stage" onWheel={event=>{event.preventDefault();const anchor=cursorAt(event);setCursor(anchor);if(event.shiftKey)viewport.move(event.deltaY>0?10:-10);else zoomChart(event.deltaY<0?.5:-.5,anchor.index)}} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={()=>{drag.current=null}} onPointerLeave={()=>{drag.current=null;setCursor(null)}}>
      <svg viewBox={`0 0 ${dims.width} ${dims.height}`} role="img" aria-label={deltaMode?"Ultima, Zomma, Gamma, Speed, Color, and Delta plotted over time":"Zomma, Color, Speed, and Gamma plotted over time"}>
        {series.flatMap(([name,color,role],laneIndex)=>{const range=ranges[name],top=dims.top+laneIndex*laneHeight,bottom=top+laneHeight,middle=(top+bottom)/2;return <g key={`lane-${name}`}><rect className="first-order-lane" x={dims.left} y={top} width={plotWidth} height={laneHeight}/><text className="triad-lane-name" x="12" y={middle-5} style={{fill:color}}>{name.toUpperCase()}</text><text className="triad-lane-role" x="12" y={middle+14}>{role}</text>{[range.maximum,(range.maximum+range.minimum)/2,range.minimum].map((tickValue,tickIndex)=>{const yy=[top+10,middle,bottom-10][tickIndex];return <g key={`${name}-${tickIndex}`}><line className="greek-grid" x1={dims.left} x2={dims.width-dims.right} y1={yy} y2={yy}/><text className="greek-axis" x={dims.left-10} y={yy+4} textAnchor="end">{formatValue(tickValue)}</text></g>})}</g>})}
        {[0,1,2,3,4,5].map(tick=>{const index=Math.round(tick*Math.max(rows.length-1,0)/5),xx=x(index);return <g key={`x-${tick}`}><line className="greek-grid" x1={xx} x2={xx} y1={dims.top} y2={dims.height-dims.bottom}/><text className="greek-axis" x={xx} y={dims.height-18} textAnchor="middle">{formatTime(rows[index]?.timestamp)}</text></g>})}
        {series.map(([name,color])=>{let drawing=false;const path=rows.map((row,index)=>{const value=valueFor(row,name);if(!Number.isFinite(value)){drawing=false;return ""}const command=drawing?"L":"M";drawing=true;return `${command}${x(index).toFixed(1)},${y(value,name).toFixed(1)}`}).filter(Boolean).join(" "),latest=valueFor(rows.at(-1),name);return <g key={name}>{path&&<path className="greek-series" d={path} style={{stroke:color}}/>}{Number.isFinite(latest)&&<circle className="greek-current-dot" cx={x(rows.length-1)} cy={y(latest,name)} r="4" style={{fill:color}}/>}</g>})}
        {cursor&&<g><line className="greek-crosshair" x1={x(cursor.index)} x2={x(cursor.index)} y1={dims.top} y2={dims.height-dims.bottom}/>{series.map(([name,color])=>{const value=valueFor(hovered,name);return Number.isFinite(value)?<circle key={name} className="greek-hover-dot" cx={x(cursor.index)} cy={y(value,name)} r="5" style={{fill:color}}/>:null})}</g>}
      </svg><ChartCoordinateTooltip {...{cursor,row:hovered,series:series.map(([name,color])=>[name,color]),formatTime,formatValue,seriesValue:valueFor}} cursorValueText={()=>"Actual values by lane"}/>{!rows.length&&<div className="chart-empty">Waiting for streamed {deltaMode?"Delta Dynamics":"Gamma Dynamics"} history...</div>}
    </div>
    <ChartHistoryNavigator viewport={viewport}/><div className="greek-chart-readout"><span>Wheel: zoom at cursor · Shift+wheel/drag: history</span><span>{viewport.isLive?"Following current stream":`${viewport.offset} buckets behind live`}</span><span>{formatTime(hovered?.timestamp)}</span>{series.map(([name,color])=><span key={name}><i style={{backgroundColor:color}}/>{name} {formatValue(valueFor(hovered,name))}</span>)}</div>
    {deltaMode&&showMinuteStream&&<section className="delta-minute-stream"><header><div><span>DELTA DYNAMICS · MINUTE STREAM</span><h3>One Greek snapshot per minute · Eastern time</h3></div><div><b>{minuteStream.length} MINUTES</b><button type="button" onClick={()=>setShowMinuteStream(false)}>HIDE</button></div></header><p><b>GREEN</b> means the Delta Dynamics confluence qualified at that minute. The same tab-separated rows are in your clipboard.</p><div><table><thead><tr><th>DATE · EASTERN</th><th>TIME · EASTERN</th><th>SYMBOL</th><th>CONFLUENCE</th><th>ZONE</th><th>DIRECTION</th>{SIX_GREEKS.map(name=><th key={name}>{name.toUpperCase()}</th>)}</tr></thead><tbody>{minuteStream.map(row=><tr className={row.qualified?"aligned":""} key={row.timestamp}><td>{logDate(row.timestamp)}</td><td>{logTime(row.timestamp)}</td><td>{row.symbol}</td><td><span className={`delta-alignment-badge ${row.qualified?"yes":"no"}`}>{row.qualified?"YES":"NO"}</span></td><td>{pretty(row.zone)}</td><td>{biasLabel(row.decision)}</td>{SIX_GREEKS.map(name=><td key={name}>{signedGreek(row.inputs[name])}</td>)}</tr>)}</tbody></table></div></section>}
  </ChartShell>;
}

function gammaLogVisualState(call){
  if(!call)return {key:"tracking-failing",label:"FAILING"};
  if(String(call.status).toUpperCase()==="REVERSED")return {key:"failed",label:"REVERSED"};
  const outcome=callOutcome(call),datum=number(call.entry_price),price=number(call.current_price??call.final_price??call.minute_bars?.at(-1)?.close,datum);
  const legs=call.family_legs??[],parent=legs.find(leg=>leg.role==="PARENT")??legs[0];
  const legPl=leg=>{const stored=Number(leg?.current_pl_points);if(leg?.current_pl_points!=null&&Number.isFinite(stored))return stored;const legDatum=number(leg?.datum,datum),legPrice=leg?.final_price!=null?number(leg.final_price):price;return call.direction==="UP"?legPrice-legDatum:legDatum-legPrice};
  const parentPl=parent?legPl(parent):call.direction==="UP"?price-datum:datum-price,children=legs.filter(leg=>leg.role==="CHILD"),calculatedTotal=legs.reduce((sum,leg)=>sum+legPl(leg),0),storedTotal=Number(call.family_total_pl_points),familyTotal=call.family_total_pl_points!=null&&Number.isFinite(storedTotal)?storedTotal:calculatedTotal;
  const childRescued=outcome.closed&&parentPl<=0&&familyTotal>0&&children.some(leg=>legPl(leg)>0);
  if(childRescued)return {key:"child-rescued",label:"SUCCESS · CHILD RESCUE"};
  if(outcome.closed)return outcome.grade==="success"?{key:"success",label:outcome.basis==="directional"?"SUCCESS · DIRECTIONAL":"SUCCESS"}:{key:"failed",label:"FAILED"};
  const succeeding=call.direction==="UP"?price>=datum:price<=datum;
  return succeeding?{key:"tracking-success",label:"SUCCEEDING"}:{key:"tracking-failing",label:"FAILING"};
}

function dynamicsScore(calls=[]){
  return dedupeLogicalCalls(calls).reduce((score,call)=>{
    const state=gammaLogVisualState(call).key;
    score.total+=1;
    if(state==="success"||state==="child-rescued")score.succeeded+=1;
    else if(state==="failed")score.failed+=1;
    else if(state==="tracking-success")score.trackingSucceeded+=1;
    else score.trackingFailed+=1;
    return score;
  },{total:0,succeeded:0,failed:0,trackingSucceeded:0,trackingFailed:0});
}

function scorePercent(value,total){return total?Math.round(value/total*100):0}

const DYNAMICS_MARKET_HOURS=["PRE-MARKET","OPENING HOUR","MORNING","MIDDAY","AFTERNOON","POWER HOUR","AFTER HOURS"];
function dynamicsTimeScores(calls=[]){
  const buckets=Object.fromEntries(DYNAMICS_MARKET_HOURS.map(hour=>[hour,{succeeded:0,failed:0}]));
  dedupeLogicalCalls(calls).forEach(call=>{
    const state=gammaLogVisualState(call).key;
    if(state!=="success"&&state!=="child-rescued"&&state!=="failed")return;
    const bucket=buckets[marketHourLabel(call.alerted_at)];
    if(!bucket)return;
    if(state==="failed")bucket.failed+=1;else bucket.succeeded+=1;
  });
  return buckets;
}

function averageTimeToTarget(calls=[]){
  const durations=dedupeLogicalCalls(calls).filter(call=>{
    const state=gammaLogVisualState(call).key;
    return (state==="success"||state==="child-rescued")&&Number.isFinite(Number(call.seconds_to_target));
  }).map(call=>Number(call.seconds_to_target));
  return durations.length?durations.reduce((sum,value)=>sum+value,0)/durations.length:null;
}

function DynamicsScoreSummary({calls=[]}){
  const score=dynamicsScore(calls);
  return <span className="module-score-summary" title={`${score.total} recorded calls`}><b>{scorePercent(score.succeeded,score.total)}% S</b><b>{scorePercent(score.failed,score.total)}% F</b><b>{scorePercent(score.trackingSucceeded,score.total)}% TS</b><b>{scorePercent(score.trackingFailed,score.total)}% TF</b></span>;
}

function DynamicsScorecard({attribution,state,history=[]}){
  const systems=[
    ["GAMMA DYNAMICS 1.0","GAMMA_DYNAMICS","gamma-v1"],
    ["GAMMA DYNAMICS 2.0","GAMMA_DYNAMICS_V2","gamma-v2"],
    ["DELTA DYNAMICS","DELTA_DYNAMICS","delta"],
  ];
  const models={GAMMA_DYNAMICS:deriveGammaDynamics(state,history),GAMMA_DYNAMICS_V2:deriveGammaDynamicsV2(state,history),DELTA_DYNAMICS:deriveSixGreekDynamics(state,history)};
  return <section className="dynamics-scorecard" aria-label="Dynamics call performance scorecard"><header><div><span>DYNAMICS PERFORMANCE SCORECARD</span><b>Completed outcomes and live call direction</b></div><small>TS is tracking/succeeding; TF is tracking/failing.</small></header><div className="dynamics-scorecard-grid">{systems.map(([label,key,tone])=>{const calls=attribution?.systems?.[key]?.calls??[],score=dynamicsScore(calls),hours=dynamicsTimeScores(calls),open=score.trackingSucceeded+score.trackingFailed,averageSeconds=averageTimeToTarget(calls),model=models[key],bias=model?.qualified?(model.decision==="UP"?"UPWARD":model.decision==="DOWN"?"DOWNWARD":"WAIT"):"WAIT";return <article className={tone} key={key}><header><b>{label}</b><small>{score.total} TOTAL CALL{score.total===1?"":"S"}</small></header><div className="dynamics-live-summary"><span className={`bias ${bias.toLowerCase()}`}><b>{bias}</b>ACTIVE BIAS</span><span className={`target-time ${averageSeconds!=null&&averageSeconds<=600?"within-target":"over-target"}`}><b>{averageSeconds==null?"—":duration(averageSeconds)}</b>AVG TARGET · 10M</span><span className="open-calls"><b>{open}</b>OPEN · <i>TS {score.trackingSucceeded}</i> / <strong>TF {score.trackingFailed}</strong></span></div><div><span className="succeeded"><b>{score.succeeded}</b>SUCCEEDED <i>{scorePercent(score.succeeded,score.total)}%</i></span><span className="failed"><b>{score.failed}</b>FAILED <i>{scorePercent(score.failed,score.total)}%</i></span><span className="tracking-success"><b>{score.trackingSucceeded}</b>TS <i>{scorePercent(score.trackingSucceeded,score.total)}%</i></span><span className="tracking-failing"><b>{score.trackingFailed}</b>TF <i>{scorePercent(score.trackingFailed,score.total)}%</i></span></div><section className="dynamics-time-breakdown"><b>COMPLETED S / F BY ALERT MARKET HOUR</b><div>{DYNAMICS_MARKET_HOURS.map(hour=><span key={hour}><b>{hour}</b><i><em>S {hours[hour].succeeded}</em> / <strong>F {hours[hour].failed}</strong></i></span>)}</div></section></article>})}</div></section>;
}

function GammaDynamicsLog({history,state,symbol,calls=[],version=1}){
  const v2=version===2,systemKey=v2?"GAMMA_DYNAMICS_V2":"GAMMA_DYNAMICS",snapshotKey=v2?"gamma_dynamics_v2_at_signal":"gamma_dynamics_at_signal",greekNames=v2?GAMMA_DYNAMICS_V2_GREEKS:GAMMA_DYNAMICS_GREEKS,versionLabel=`GAMMA DYNAMICS ${version}.0`,current=v2?deriveGammaDynamicsV2(state,history):deriveGammaDynamics(state,history);
  const [copied,setCopied]=useState(false);
  const [sortOrder,setSortOrder]=useState("newest");
  const [filterDate,setFilterDate]=useState("");
  const [fromTime,setFromTime]=useState("");
  const [toTime,setToTime]=useState("");
  const [callStateFilters,setCallStateFilters]=useState(()=>GAMMA_CALL_STATES.map(([value])=>value));
  const [expandedDashboardId,setExpandedDashboardId]=useState(null);
  const [scrollSize,setScrollSize]=useState({width:0,height:0});
  const topScrollRef=useRef(null),bottomScrollRef=useRef(null),leftScrollRef=useRef(null),rightScrollRef=useRef(null),bodyScrollRef=useRef(null),tableRef=useRef(null),stateFilterRef=useRef(null);
  useEffect(()=>{
    const closeOnOutside=event=>{const menu=stateFilterRef.current;if(menu?.open&&!menu.contains(event.target))menu.removeAttribute("open")};
    const closeOnEscape=event=>{if(event.key==="Escape")stateFilterRef.current?.removeAttribute("open")};
    document.addEventListener("pointerdown",closeOnOutside);
    document.addEventListener("keydown",closeOnEscape);
    return()=>{document.removeEventListener("pointerdown",closeOnOutside);document.removeEventListener("keydown",closeOnEscape)};
  },[]);
  const events=useMemo(()=>{
    const derived=deriveGammaDynamicsEvents(history,state,symbol,version);
    const persisted=calls.map(call=>{
      const snapshot=call?.[snapshotKey]??{},inputs=snapshot.inputs??call.greek_values_at_signal??{};
      return {
        id:visibleCallId(call,systemKey),timestamp:call.alerted_at,symbol:call.symbol??symbol,
        price:number(call.entry_price,NaN),decision:call.direction,
        intensity:Number(snapshot.intensity),pressure:Number(snapshot.pressure),
        normalized:snapshot.normalized??{},...Object.fromEntries(greekNames.map(name=>[name,Number(inputs[name])])),
        persisted:true,
      };
    });
    return [...new Map([...persisted,...derived].map(event=>[event.id,event])).values()]
      .sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp));
  },[history,state,symbol,calls]);
  const visibleEvents=useMemo(()=>events.filter(event=>{
    const eastern=easternFilterParts(event.timestamp);
    if(filterDate&&eastern.date!==filterDate)return false;
    if(!timeRangeMatches(eastern.time,fromTime,toTime))return false;
    const call=calls.find(item=>visibleCallId(item,systemKey)===event.id),key=gammaLogVisualState(call).key;
    const stateKey=key==="child-rescued"?"CHILD_RESCUED":key==="success"?"SUCCESS":key==="failed"?"FAILED":"TRACKING";
    return callStateFilters.includes(stateKey);
  }).sort((a,b)=>(sortOrder==="oldest"?1:-1)*(new Date(a.timestamp)-new Date(b.timestamp))),[events,calls,filterDate,fromTime,toTime,callStateFilters,sortOrder]);
  const graphEvent=expandedDashboardId?(()=>{const event=events.find(item=>item.id===expandedDashboardId),call=event&&calls.find(item=>visibleCallId(item,systemKey)===event.id);return event&&call?{event,call}:null})():null;
  useEffect(()=>{
    const update=()=>{
      const table=tableRef.current;
      if(table)setScrollSize({width:table.scrollWidth,height:table.scrollHeight});
    };
    update();
    const observer=new ResizeObserver(update);
    if(tableRef.current)observer.observe(tableRef.current);
    return()=>observer.disconnect();
  },[visibleEvents.length]);
  const syncFromBody=event=>{
    if(topScrollRef.current&&topScrollRef.current.scrollLeft!==event.currentTarget.scrollLeft)topScrollRef.current.scrollLeft=event.currentTarget.scrollLeft;
    if(bottomScrollRef.current&&bottomScrollRef.current.scrollLeft!==event.currentTarget.scrollLeft)bottomScrollRef.current.scrollLeft=event.currentTarget.scrollLeft;
    if(leftScrollRef.current&&leftScrollRef.current.scrollTop!==event.currentTarget.scrollTop)leftScrollRef.current.scrollTop=event.currentTarget.scrollTop;
    if(rightScrollRef.current&&rightScrollRef.current.scrollTop!==event.currentTarget.scrollTop)rightScrollRef.current.scrollTop=event.currentTarget.scrollTop;
  };
  const syncHorizontal=event=>{if(bodyScrollRef.current)bodyScrollRef.current.scrollLeft=event.currentTarget.scrollLeft};
  const syncVertical=event=>{if(bodyScrollRef.current)bodyScrollRef.current.scrollTop=event.currentTarget.scrollTop};
  const linkedCall=event=>calls.find(call=>visibleCallId(call,systemKey)===event.id);
  const visualState=gammaLogVisualState;
  const callRankings=(call,phase)=>{if(!call)return {};const stored=call[`greek_rankings_at_${phase}`];if(stored&&Object.keys(stored).length)return stored;const scores=call[`greek_scores_at_${phase}`]??(phase==="failure"&&!call.target_reached_at&&callOutcome(call).closed?call.greek_scores_current:null);return scores&&Object.keys(scores).length?greekRankings(scores):{}};
  const finalCallRankings=call=>call&&callOutcome(call).closed?callRankings(call,call.target_reached_at?"target":"failure"):{};
  const scoreBoard=useMemo(()=>visibleEvents.reduce((scores,event)=>{const key=visualState(linkedCall(event)).key;if(key==="failed")scores.failed+=1;else if(key==="success"||key==="child-rescued")scores.succeeded+=1;else if(key==="tracking-success")scores.trackingSucceeded+=1;else scores.trackingFailed+=1;return scores},{failed:0,succeeded:0,trackingFailed:0,trackingSucceeded:0}),[visibleEvents,calls]);
  const toggleCallState=value=>setCallStateFilters(selected=>selected.includes(value)?selected.filter(item=>item!==value):[...selected,value]);
  const priceValue=(call,value)=>!call||!Number.isFinite(Number(value))?"—":number(value).toFixed(4);
  const pointValue=(call,value)=>{if(!call||!Number.isFinite(Number(value)))return <span className="point-delta flat">—</span>;const delta=number(value)-number(call.entry_price),tone=delta>0?"up":delta<0?"down":"flat";return <span className={`point-delta ${tone}`}>{delta>=0?"+":""}{delta.toFixed(4)} pts</span>};
  const extremeTime=(call,seconds,finished)=>!call?"—":finished?duration(seconds):"TRACKING";
  const legMetrics=(call,leg)=>{
    const activated=new Date(leg.activated_at).getTime(),finalized=leg.final_price_at?new Date(leg.final_price_at).getTime():Infinity,bars=(call.minute_bars??[]).filter(bar=>{const timestamp=new Date(bar.timestamp).getTime();return timestamp>=activated&&timestamp<=finalized});
    const datum=number(leg.datum),price=leg.final_price!=null?number(leg.final_price):number(call.current_price??call.final_price??call.minute_bars?.at(-1)?.close,datum);
    const highBar=bars.reduce((best,bar)=>!best||number(bar.high)>number(best.high)?bar:best,null);
    const lowBar=bars.reduce((best,bar)=>!best||number(bar.low)<number(best.low)?bar:best,null);
    const high=highBar?number(highBar.high):Math.max(datum,price),low=lowBar?number(lowBar.low):Math.min(datum,price);
    const calculatedPl=call.direction==="UP"?price-datum:datum-price;
    const pl=Number.isFinite(Number(leg.current_pl_points))?number(leg.current_pl_points):calculatedPl;
    const status=leg.status??(pl>0?"SUCCEEDED":pl<0?"FAILED":"FLAT");
    return {datum,price,high,low,pl,status,tone:pl>0?"profit":pl<0?"loss":"flat",timeHigh:highBar?duration(Math.max(0,(new Date(highBar.timestamp)-activated)/1000)):"0.0s",timeLow:lowBar?duration(Math.max(0,(new Date(lowBar.timestamp)-activated)/1000)):"0.0s"};
  };
  const copySummaries=async()=>{
    const headers=["Direction","Call State","Stream Duration","High Change","Time · MS","Date · Eastern","Market Hour","Source","Datum / Alert Price","Session Target","Strike / Reference","Dynamic / Extreme High","Time to High","Dynamic / Extreme Low","Low Change","Time to Low","Current / Final","Current / Final Change","Strongest Greek","Weakest Greek","Intensity","Pressure",...greekNames.flatMap(name=>[`${name.toUpperCase()} @ Strike · Raw`,`${name.toUpperCase()} @ Strike · Normalized`,`${name.toUpperCase()} High`,`${name.toUpperCase()} Low`]),...(["Strike","Final"].flatMap(phase=>GAMMA_RANKS.map(rank=>`${phase} · ${pretty(rank)}`))),"Event ID"];
    const parentRows=visibleEvents.map(event=>{const call=linkedCall(event),view=visualState(call),finished=Boolean(call&&callOutcome(call).closed),high=call?number(call.highest_price,call.dynamic_high):NaN,low=call?number(call.lowest_price,call.dynamic_low):NaN,datum=number(call?.entry_price,event.price),currentPrice=number(call?.current_price??call?.final_price??call?.minute_bars?.at(-1)?.close,NaN),strike=referenceStrike(call??event,datum),signalRanks=callRankings(call,"signal"),finalRanks=finalCallRankings(call),change=value=>Number.isFinite(value)?(value-datum).toFixed(4):"";return [event.decision==="UP"?"UPWARD":"DOWNWARD",view.label,callStreamDuration(call),change(high),logTime(event.timestamp),logDate(event.timestamp),marketHourLabel(event.timestamp),event.symbol,datum.toFixed(4),number(call?.target_price,gammaReachFromDatum(datum,event.decision,event.timestamp)).toFixed(4),Number.isFinite(strike.value)?`${strike.estimated?"REF ":""}${strike.value.toFixed(2)}`:"—",Number.isFinite(high)?high.toFixed(4):"—",finished?duration(call?.seconds_to_high):"TRACKING",Number.isFinite(low)?low.toFixed(4):"—",change(low),finished?duration(call?.seconds_to_low):"TRACKING",Number.isFinite(currentPrice)?currentPrice.toFixed(4):"—",change(currentPrice),call?.strongest_greek_current??call?.strongest_greek??"—",call?.weakest_greek_current??call?.weakest_greek??"—",Number.isFinite(event.intensity)?pct(event.intensity):"—",Number.isFinite(event.pressure)?`${event.pressure>0?"+":""}${event.pressure.toFixed(2)}`:"—",...greekNames.flatMap(name=>{const strikeValue=call?.greek_values_at_signal?.[name]??event[name],normalized=call?.[snapshotKey]?.normalized?.[name]??event.normalized?.[name];return [signedGreek(strikeValue),Number.isFinite(Number(normalized))?number(normalized).toFixed(3):"—",signedGreek(call?.greek_values_highest?.[name]??strikeValue),signedGreek(call?.greek_values_lowest?.[name]??strikeValue)]}),...GAMMA_RANKS.map(rank=>rankingText(signalRanks,rank)),...GAMMA_RANKS.map(rank=>rankingText(finalRanks,rank)),event.id]});
    const childHeaders=["Parent Event ID","Leg","Child ID","Role","Status","Trigger","Activated · ET","Datum","Current / Final","Leg P/L","Extreme High","Time to High","Extreme Low","Time to Low"];
    const childRows=visibleEvents.flatMap(event=>{const call=linkedCall(event);return (call?.family_legs??[]).map(leg=>{const metric=legMetrics(call,leg);return [event.id,leg.leg_number,leg.call_id,leg.role,metric.status,leg.trigger_adverse_points===0?"0":`${call.direction==="UP"?"-":"+"}${number(leg.trigger_adverse_points).toFixed(0)} PTS`,`${logDate(leg.activated_at)} · ${logTime(leg.activated_at)}`,metric.datum.toFixed(4),metric.price.toFixed(4),`${metric.pl>=0?"+":""}${metric.pl.toFixed(4)} pts`,metric.high.toFixed(4),metric.timeHigh,metric.low.toFixed(4),metric.timeLow]})});
    try{await navigator.clipboard.writeText([exportTsv(`${versionLabel} EVENT LOG · ${symbol} · EASTERN TIME`,headers,parentRows),exportTsv(`${versionLabel} CHILD LEGS`,childHeaders,childRows)].join("\n\n"));setCopied(true);window.setTimeout(()=>setCopied(false),1800)}catch{setCopied(false)}
  };
  const gateItems=v2?[
    ["BASELINE",Boolean(current.alert_checks?.baseline),`${number(current.history_points).toFixed(0)} / 20 observations`],
    ["SQUEEZE",Boolean(current.alert_checks?.squeeze),`${number(current.squeeze_score).toFixed(3)} / ${number(current.intensity_threshold,.65).toFixed(2)}`],
    ["SPEED",Boolean(current.alert_checks?.speed),signedGreek(current.normalized_features?.weighted_speed)],
    ["COLOR",Boolean(current.alert_checks?.color),signedGreek(current.normalized_features?.weighted_color)],
  ]:[
    ["BASELINE",number(current.history_points)>=20,`${number(current.history_points).toFixed(0)} / 20 observations`],
    ["INTENSITY",number(current.intensity)>=number(current.intensity_threshold,.65),`${pct(current.intensity)} / ${pct(current.intensity_threshold??.65)}`],
    ["SPEED",Math.abs(number(current.inputs?.speed))>1e-12,signedGreek(current.inputs?.speed)],
    ["GAMMA",Math.abs(number(current.inputs?.gamma))>1e-12,signedGreek(current.inputs?.gamma)],
  ];
  return <article className={`panel gamma-dynamics-log ${v2?"gamma-dynamics-log-v2":""}`}>
    <header className="panel-head"><div><span>{versionLabel} EVENT LOG</span><h2>Every qualified call · observed minute high/low path</h2></div><div className="gamma-log-actions"><button type="button" className="copy-table" onClick={copySummaries} disabled={!visibleEvents.length}>{copied?"✓ COPIED":"COPY SUMMARIES"}</button><b>{visibleEvents.length}{visibleEvents.length!==events.length?` / ${events.length}`:""} EVENTS</b></div></header>
    <div className="gamma-log-controls">
      <label>SORT<select value={sortOrder} onChange={event=>setSortOrder(event.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label>
      <div className="gamma-state-filter"><span>CALL STATE</span><details ref={stateFilterRef}><summary>{callStateFilters.length===GAMMA_CALL_STATES.length?"All states":callStateFilters.length?`${callStateFilters.length} selected`:"None selected"}</summary><div className="gamma-state-menu"><div><button type="button" onClick={()=>setCallStateFilters(GAMMA_CALL_STATES.map(([value])=>value))}>SELECT ALL</button><button type="button" onClick={()=>setCallStateFilters([])}>CLEAR</button></div>{GAMMA_CALL_STATES.map(([value,label])=><label key={value}><input type="checkbox" checked={callStateFilters.includes(value)} onChange={()=>toggleCallState(value)}/><span>{label}</span></label>)}</div></details></div>
      <label>DATE<input type="date" value={filterDate} onChange={event=>setFilterDate(event.target.value)}/></label>
      <CompactEventTimeFilter label="FROM" value={fromTime} onChange={setFromTime}/>
      <CompactEventTimeFilter label="TO" value={toTime} onChange={setToTime}/>
      <button type="button" onClick={()=>{setCallStateFilters(GAMMA_CALL_STATES.map(([value])=>value));setFilterDate("");setFromTime("");setToTime("");}}>CLEAR FILTER</button>
    </div>
    <div className="gamma-event-scoreboard"><article className="failed"><span>FAILED</span><b>{scoreBoard.failed}</b><small>Completed calls</small></article><article className="succeeded"><span>SUCCEEDED</span><b>{scoreBoard.succeeded}</b><small>Includes child rescue</small></article><article className="tracking-failed"><span>FAILING</span><b>{scoreBoard.trackingFailed}</b><small>Direction currently adverse</small></article><article className="tracking-succeeded"><span>SUCCEEDING</span><b>{scoreBoard.trackingSucceeded}</b><small>Direction currently favorable</small></article></div>
    <div className="gamma-log-scroll-shell">
      <div className="gamma-log-scroll-top" ref={topScrollRef} onScroll={syncHorizontal}><div style={{width:scrollSize.width}}/></div>
      <div className="gamma-log-scroll-row">
        <div className="gamma-log-scroll-left" ref={leftScrollRef} onScroll={syncVertical}><div style={{height:scrollSize.height}}/></div>
        <div className="gamma-log-scroll" ref={bodyScrollRef} onScroll={syncFromBody}><table ref={tableRef}>
      <thead><tr><th>DIRECTION</th><th>CALL STATE</th>{v2&&<th>EVENT DASHBOARD</th>}<th>STREAM DURATION</th><th>HIGH CHANGE</th><th>TIME · MS</th><th>DATE · EASTERN</th><th>MARKET HOUR</th><th>SOURCE</th><th>DATUM / ALERT PRICE</th><th>SESSION TARGET</th><th>STRIKE / REFERENCE</th><th>DYNAMIC / EXTREME HIGH</th><th>TIME TO HIGH</th><th>DYNAMIC / EXTREME LOW</th><th>LOW CHANGE</th><th>TIME TO LOW</th><th>CURRENT / FINAL</th><th>CURRENT / FINAL CHANGE</th><th>STRONGEST GREEK</th><th>WEAKEST GREEK</th><th>INTENSITY</th><th>PRESSURE</th>{greekNames.flatMap(name=>[<th key={`${name}-strike`}>{name.toUpperCase()} @ STRIKE · RAW</th>,<th key={`${name}-normalized`}>{name.toUpperCase()} @ STRIKE · NORM</th>,<th key={`${name}-high`}>{name.toUpperCase()} HIGH</th>,<th key={`${name}-low`}>{name.toUpperCase()} LOW</th>])}{["STRIKE","FINAL"].flatMap(phase=>GAMMA_RANKS.map(rank=><th className={`greek-rank-head ${rank}`} key={`${phase}-${rank}`}>{phase} · {rank.toUpperCase()}</th>))}<th>EVENT ID</th></tr></thead>
      <tbody>{visibleEvents.map((event,index)=>{
        const call=linkedCall(event),expired=call&&callDeadlinePassed(call),snapshot=call?deadlineSnapshot(call):{},livePrice=expired?snapshot.price:(call?.current_price??call?.final_price??call?.minute_bars?.at(-1)?.close),outcome=callOutcome(call),view=visualState(call),finished=outcome.closed;
        const datum=number(call?.entry_price,event.price),trackingHigh=number(call?.dynamic_high,number(call?.highest_price,number(snapshot.high,livePrice))),trackingLow=number(call?.dynamic_low,number(call?.lowest_price,number(snapshot.low,livePrice))),high=call?(expired?number(snapshot.high,trackingHigh):trackingHigh):NaN,low=call?(expired?number(snapshot.low,trackingLow):trackingLow):NaN,strike=referenceStrike(call??event,datum),signalRanks=callRankings(call,"signal"),finalRanks=finalCallRankings(call);
        return <Fragment key={`${event.timestamp}-${event.decision}-${index}`}>
          <tr className={`gamma-call-${view.key}`}><td><span className={`direction-pill ${event.decision.toLowerCase()}`}>{event.decision==="UP"?"UPWARD":"DOWNWARD"}</span></td><td><span className={`gamma-call-state ${view.key}`}>{view.label}</span></td>{v2&&<td><button type="button" className="view-event-graph" disabled={!call} onClick={()=>setExpandedDashboardId(current=>current===event.id?null:event.id)}>{call?(expandedDashboardId===event.id?"HIDE DASHBOARD":"VIEW DASHBOARD"):"UNAVAILABLE"}</button></td>}<td className="stream-duration">{v2?callStreamDuration(call):<button type="button" className="view-event-graph" disabled={!call} onClick={()=>setExpandedDashboardId(current=>current===event.id?null:event.id)}>{call?(expandedDashboardId===event.id?"HIDE DASHBOARD":"VIEW DASHBOARD"):"UNAVAILABLE"}</button>}</td><td>{pointValue(call,high)}</td><td>{logTime(event.timestamp)}</td><td>{logDate(event.timestamp)}</td><td><span className="market-hour">{marketHourLabel(event.timestamp)}</span></td><td>{event.symbol}</td><td className="extreme-price">{Number.isFinite(datum)?datum.toFixed(4):"—"}</td><td className="extreme-price">{Number.isFinite(datum)?number(call?.target_price,gammaReachFromDatum(datum,event.decision,event.timestamp)).toFixed(4):"—"}</td><td className="extreme-price">{Number.isFinite(strike.value)?`${strike.estimated?"REF ":""}${strike.value.toFixed(2)}`:"—"}</td><td className="extreme-price">{priceValue(call,high)}</td><td className="extreme-time">{extremeTime(call,call?.seconds_to_high,finished)}</td><td className="extreme-price">{priceValue(call,low)}</td><td>{pointValue(call,low)}</td><td className="extreme-time">{extremeTime(call,call?.seconds_to_low,finished)}</td><td className="extreme-price">{priceValue(call,livePrice)}</td><td>{pointValue(call,livePrice)}</td><td><GreekAuditBadge label={call?.strongest_greek_current??call?.strongest_greek}/></td><td><GreekAuditBadge label={call?.weakest_greek_current??call?.weakest_greek}/></td><td>{Number.isFinite(event.intensity)?pct(event.intensity):"—"}</td><td>{Number.isFinite(event.pressure)?`${event.pressure>0?"+":""}${event.pressure.toFixed(2)}`:"—"}</td>{greekNames.flatMap(name=>{const strikeValue=call?.greek_values_at_signal?.[name]??event[name],normalized=call?.[snapshotKey]?.normalized?.[name]??event.normalized?.[name];return [<td key={`${name}-strike`}>{signedGreek(strikeValue)}</td>,<td className="greek-normalized" key={`${name}-normalized`}>{Number.isFinite(Number(normalized))?`${number(normalized)>=0?"+":""}${number(normalized).toFixed(3)}`:"—"}</td>,<td className="greek-extreme-high" key={`${name}-high`}>{signedGreek(call?.greek_values_highest?.[name]??strikeValue)}</td>,<td className="greek-extreme-low" key={`${name}-low`}>{signedGreek(call?.greek_values_lowest?.[name]??strikeValue)}</td>]})}{GAMMA_RANKS.map(rank=><td className={`greek-rank-cell ${rank}`} key={`signal-${rank}`}>{rankingText(signalRanks,rank)}</td>)}{GAMMA_RANKS.map(rank=><td className={`greek-rank-cell ${rank}`} key={`final-${rank}`}>{rankingText(finalRanks,rank)}</td>)}<td><button type="button" className="call-id" onClick={()=>navigator.clipboard.writeText(event.id)} title="Copy event ID">{event.id}</button></td></tr>
          {call?.family_legs?.length>0&&<tr className="gamma-family-dropdown-row"><td colSpan="34"><details><summary>SHOW CHILD LEGS · {call.family_stage} · AVG DATUM {number(call.family_average_datum).toFixed(4)} · AVG P/L {number(call.family_average_pl_points)>=0?"+":""}{number(call.family_average_pl_points).toFixed(4)} PTS</summary><div className="risk-leg-table-wrap"><table className="risk-leg-table"><thead><tr><th>LEG</th><th>CHILD ID</th><th>ROLE</th><th>STATUS</th><th>TRIGGER</th><th>ACTIVATED · ET</th><th>DATUM</th><th>CURRENT / FINAL</th><th>LEG P/L</th><th>EXTREME HIGH</th><th>TIME TO HIGH</th><th>EXTREME LOW</th><th>TIME TO LOW</th></tr></thead><tbody>{call.family_legs.map(leg=>{const metric=legMetrics(call,leg);return <tr className={`risk-leg-row ${metric.tone}`} key={leg.call_id}><td>{leg.leg_number}</td><td><button type="button" className="call-id" onClick={()=>navigator.clipboard.writeText(leg.call_id)}>{leg.call_id}</button></td><td>{leg.role}</td><td><span className={`leg-status ${metric.tone}`}>{metric.status}</span></td><td>{leg.trigger_adverse_points===0?"0":`${call.direction==="UP"?"-":"+"}${number(leg.trigger_adverse_points).toFixed(0)} PTS`}</td><td>{logDate(leg.activated_at)} · {logTime(leg.activated_at)}</td><td className="extreme-price">{metric.datum.toFixed(4)}</td><td className="extreme-price">{metric.price.toFixed(4)}</td><td><span className={`family-pl ${metric.tone}`}>{metric.pl>=0?"+":""}{metric.pl.toFixed(4)} pts</span></td><td className="extreme-price">{metric.high.toFixed(4)}</td><td>{metric.timeHigh}</td><td className="extreme-price">{metric.low.toFixed(4)}</td><td>{metric.timeLow}</td></tr>})}</tbody></table></div></details></td></tr>}
        </Fragment>
      })}</tbody>
    </table>{!visibleEvents.length&&<div className="gamma-log-empty"><b>{events.length?"NO EVENTS MATCH THIS RANGE":"NO QUALIFIED EVENT YET"}</b><p>{events.length?"Clear or widen the date/time filter.":current.explanation}</p>{!events.length&&<><div>{gateItems.map(([name,passed,detail])=><span className={passed?"passed":"waiting"} key={name}><b>{passed?"PASS":"WAIT"} · {name}</b><small>{detail}</small></span>)}</div><small>The log does not manufacture rows from unqualified states. A row is written when baseline, intensity, Speed direction, and active Gamma pass together.</small></>}</div>}</div>
        <div className="gamma-log-scroll-right" ref={rightScrollRef} onScroll={syncVertical}><div style={{height:scrollSize.height}}/></div>
      </div>
      <div className="gamma-log-scroll-bottom" ref={bottomScrollRef} onScroll={syncHorizontal}><div style={{width:scrollSize.width}}/></div>
    </div>
    {graphEvent&&<GammaEventGraphModal {...graphEvent} version={version} onClose={()=>setExpandedDashboardId(null)}/>}</article>;
}

function RiskManagementEventLog({calls=[],symbol}){
  const [sortOrder,setSortOrder]=useState("newest");
  const [copied,setCopied]=useState(false);
  const [scrollWidth,setScrollWidth]=useState(0);
  const topRef=useRef(null),bodyRef=useRef(null),bottomRef=useRef(null),tableRef=useRef(null);
  const families=useMemo(()=>calls.filter(call=>call.family_legs?.length).sort((a,b)=>(sortOrder==="oldest"?1:-1)*(new Date(a.alerted_at)-new Date(b.alerted_at))),[calls,sortOrder]);
  useEffect(()=>{
    const update=()=>setScrollWidth(tableRef.current?.scrollWidth??0);
    update();
    const observer=new ResizeObserver(update);
    if(tableRef.current)observer.observe(tableRef.current);
    return()=>observer.disconnect();
  },[families.length]);
  const syncBody=event=>{
    if(topRef.current)topRef.current.scrollLeft=event.currentTarget.scrollLeft;
    if(bottomRef.current)bottomRef.current.scrollLeft=event.currentTarget.scrollLeft;
  };
  const syncBar=event=>{if(bodyRef.current)bodyRef.current.scrollLeft=event.currentTarget.scrollLeft};
  const tone=call=>number(call.family_average_pl_points)>0?"profit":number(call.family_average_pl_points)<0?"loss":"flat";
  const currentPrice=call=>number(call.current_price??call.final_price??call.minute_bars?.at(-1)?.close,call.entry_price);
  const remaining=call=>callOutcome(call).closed?"COMPLETE":duration(Math.max(0,(new Date(call.expires_at).getTime()-Date.now())/1000));
  const nextTrigger=call=>{if(call.family_next_trigger_points==null)return "ALL ACTIVE";const points=number(call.family_next_trigger_points),recheck=call.family_gamma_rechecks?.[String(Math.round(points))],label=`${call.direction==="UP"?"-":"+"}${points.toFixed(0)} PTS`;return recheck?.qualified===false?`${label} · GAMMA WAIT`:points>=4&&["GAMMA_DYNAMICS","GAMMA_DYNAMICS_V2"].includes(call.system)?`${label} · RECHECK`:label};
  const legMetrics=(call,leg)=>{
    const activated=new Date(leg.activated_at).getTime(),finalized=leg.final_price_at?new Date(leg.final_price_at).getTime():Infinity,bars=(call.minute_bars??[]).filter(bar=>{const timestamp=new Date(bar.timestamp).getTime();return timestamp>=activated&&timestamp<=finalized});
    const datum=number(leg.datum),price=Number.isFinite(Number(leg.final_price))?number(leg.final_price):currentPrice(call);
    const highBar=bars.reduce((best,bar)=>!best||number(bar.high)>number(best.high)?bar:best,null);
    const lowBar=bars.reduce((best,bar)=>!best||number(bar.low)<number(best.low)?bar:best,null);
    const high=highBar?number(highBar.high):Math.max(datum,price),low=lowBar?number(lowBar.low):Math.min(datum,price);
    const calculatedPl=call.direction==="UP"?price-datum:datum-price;
    const pl=Number.isFinite(Number(leg.current_pl_points))?number(leg.current_pl_points):calculatedPl;
    const status=leg.status??(pl>0?"SUCCEEDED":pl<0?"FAILED":"FLAT");
    return {datum,price,high,low,pl,status,tone:pl>0?"profit":pl<0?"loss":"flat",timeHigh:highBar?duration(Math.max(0,(new Date(highBar.timestamp)-activated)/1000)):"0.0s",timeLow:lowBar?duration(Math.max(0,(new Date(lowBar.timestamp)-activated)/1000)):"0.0s"};
  };
  const copy=async()=>{
    const lines=families.flatMap(call=>[
      `${call.family_id??call.call_id} | ${call.direction==="UP"?"LONG":"SHORT"} | ${call.family_stage} | average datum ${number(call.family_average_datum).toFixed(4)} | average P/L ${number(call.family_average_pl_points)>=0?"+":""}${number(call.family_average_pl_points).toFixed(4)} pts | total P/L ${number(call.family_total_pl_points)>=0?"+":""}${number(call.family_total_pl_points).toFixed(4)} pts`,
      ...(call.family_legs??[]).map(leg=>`  ${leg.call_id} | ${leg.role} | datum ${number(leg.datum).toFixed(4)} | trigger ${leg.trigger_adverse_points===0?"0":`${call.direction==="UP"?"-":"+"}${number(leg.trigger_adverse_points).toFixed(0)}`} | P/L ${number(leg.current_pl_points)>=0?"+":""}${number(leg.current_pl_points).toFixed(4)} pts | ${logDate(leg.activated_at)} ${logTime(leg.activated_at)}`),
      "",
    ]);
    try{await navigator.clipboard.writeText([`RISK MANAGEMENT FAMILY SUMMARY · ${symbol} · EASTERN TIME`,"",...lines].join("\n"));setCopied(true);window.setTimeout(()=>setCopied(false),1800)}catch{setCopied(false)}
  };
  return <article className="panel risk-management-log">
    <header className="panel-head"><div><span>RISK MANAGEMENT EVENT LOG</span><h2>Equal-weight family tracking · 0 / 4 / 6 / 8 adverse points · one-hour window</h2></div><div className="gamma-log-actions"><button type="button" className="copy-table" onClick={copy} disabled={!families.length}>{copied?"✓ COPIED":"COPY FAMILIES"}</button><b>{families.length} FAMILIES</b></div></header>
    <div className="gamma-log-controls"><label>SORT<select value={sortOrder} onChange={event=>setSortOrder(event.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label></div>
    <div className="risk-scroll-top" ref={topRef} onScroll={syncBar}><div style={{width:scrollWidth}}/></div>
    <div className="risk-log-scroll" ref={bodyRef} onScroll={syncBody}>
      <table ref={tableRef}>
        <thead><tr><th>DIRECTION</th><th>PARENT ID</th><th>DATE · EASTERN</th><th>TIME · MS</th><th>MARKET HOUR</th><th>PARENT DATUM</th><th>CURRENT / FINAL</th><th>ACTIVE LEGS</th><th>FAMILY STAGE</th><th>AVERAGE DATUM</th><th>AVG P/L</th><th>TOTAL P/L</th><th>NEXT CHILD</th><th>EXTREME HIGH</th><th>EXTREME LOW</th><th>TIME LEFT</th><th>STRONGEST GREEK</th><th>WEAKEST GREEK</th><th>FAMILY STATE</th></tr></thead>
        <tbody>{families.map(call=>{
          const callTone=tone(call),price=currentPrice(call);
          return <Fragment key={call.id??call.call_id}>
            <tr className={`risk-family-row ${callTone}`}><td><span className={`direction-pill ${call.direction.toLowerCase()}`}>{call.direction==="UP"?"LONG":"SHORT"}</span></td><td><button type="button" className="call-id" onClick={()=>navigator.clipboard.writeText(call.family_id??call.call_id)}>{call.family_id??call.call_id}</button></td><td>{logDate(call.alerted_at)}</td><td>{logTime(call.alerted_at)}</td><td><span className="market-hour">{marketHourLabel(call.alerted_at)}</span></td><td className="extreme-price">{number(call.entry_price).toFixed(4)}</td><td className="extreme-price">{price.toFixed(4)}</td><td className="family-legs-count">{call.family_active_legs??call.family_legs.length} / {call.family_trigger_levels?.length??4}</td><td>{call.family_stage}</td><td className="extreme-price">{number(call.family_average_datum).toFixed(4)}</td><td><span className={`family-pl ${callTone}`}>{number(call.family_average_pl_points)>=0?"+":""}{number(call.family_average_pl_points).toFixed(4)} pts</span></td><td><span className={`family-pl ${callTone}`}>{number(call.family_total_pl_points)>=0?"+":""}{number(call.family_total_pl_points).toFixed(4)} pts</span></td><td className="family-next">{nextTrigger(call)}</td><td className="extreme-price">{number(call.highest_price).toFixed(4)}</td><td className="extreme-price">{number(call.lowest_price).toFixed(4)}</td><td className="extreme-time">{remaining(call)}</td><td><GreekAuditBadge label={call.strongest_greek_current??call.strongest_greek}/></td><td><GreekAuditBadge label={call.weakest_greek_current??call.weakest_greek}/></td><td><span className={`gamma-family-state ${callTone}`}>{call.family_outcome_state}</span></td></tr>
            <tr className="risk-family-expand"><td colSpan="19"><details><summary>SHOW LEG ROWS + FAMILY GRAPH</summary><div className="risk-leg-table-wrap"><table className="risk-leg-table"><thead><tr><th>LEG</th><th>CHILD ID</th><th>ROLE</th><th>STATUS</th><th>TRIGGER</th><th>ACTIVATED · ET</th><th>DATUM</th><th>CURRENT / FINAL</th><th>LEG P/L</th><th>EXTREME HIGH</th><th>TIME TO HIGH</th><th>EXTREME LOW</th><th>TIME TO LOW</th></tr></thead><tbody>{call.family_legs.map(leg=>{const metric=legMetrics(call,leg);return <tr className={`risk-leg-row ${metric.tone}`} key={leg.call_id}><td>{leg.leg_number}</td><td><button type="button" className="call-id" onClick={()=>navigator.clipboard.writeText(leg.call_id)}>{leg.call_id}</button></td><td>{leg.role}</td><td><span className={`leg-status ${metric.tone}`}>{metric.status}</span></td><td>{leg.trigger_adverse_points===0?"0":`${call.direction==="UP"?"-":"+"}${number(leg.trigger_adverse_points).toFixed(0)} PTS`}</td><td>{logDate(leg.activated_at)} · {logTime(leg.activated_at)}</td><td className="extreme-price">{metric.datum.toFixed(4)}</td><td className="extreme-price">{metric.price.toFixed(4)}</td><td><span className={`family-pl ${metric.tone}`}>{metric.pl>=0?"+":""}{metric.pl.toFixed(4)} pts</span></td><td className="extreme-price">{metric.high.toFixed(4)}</td><td>{metric.timeHigh}</td><td className="extreme-price">{metric.low.toFixed(4)}</td><td>{metric.timeLow}</td></tr>})}</tbody></table></div><FiftyPointPathChart call={call}/></details></td></tr>
          </Fragment>;
        })}</tbody>
      </table>
      {!families.length&&<div className="gamma-log-empty"><b>NO RISK FAMILIES YET</b><p>A family appears when a new Gamma Dynamics call begins.</p></div>}
    </div>
    <div className="risk-scroll-bottom" ref={bottomRef} onScroll={syncBar}><div style={{width:scrollWidth}}/></div>
  </article>;
}

const SYSTEM_OUTCOME_LABELS={PRIMARY_OPTIONS:"Primary Options Bias",GAMMA_DYNAMICS:"Gamma Dynamics 1.0",GAMMA_DYNAMICS_V2:"Gamma Dynamics 2.0",DELTA_DYNAMICS:"Delta Dynamics"};
const SYSTEM_OUTCOME_STREAMS={PRIMARY_OPTIONS:1,GAMMA_DYNAMICS:3,DELTA_DYNAMICS:4,GAMMA_DYNAMICS_V2:5};
const visibleCallId=(call,system)=>/^\d{19}$/.test(String(call?.call_id??""))?String(call.call_id):numericEventId(call?.alerted_at,SYSTEM_OUTCOME_STREAMS[system]??0);
const duration=value=>{const seconds=Math.max(0,number(value));if(seconds<60)return `${seconds.toFixed(1)}s`;const minutes=Math.floor(seconds/60),rest=(seconds-minutes*60).toFixed(1);return `${minutes}m ${rest}s`};
const callStreamSeconds=call=>{if(!call)return NaN;if(Number.isFinite(Number(call.seconds_observed))&&String(call.status).toUpperCase()!=="TRACKING")return number(call.seconds_observed);const start=new Date(call.alerted_at).getTime(),end=new Date(call.final_price_at??call.current_price_at??call.price_observed_at??call.alerted_at).getTime();return Number.isFinite(start)&&Number.isFinite(end)?Math.max(0,(end-start)/1000):NaN};
const callStreamDuration=call=>Number.isFinite(callStreamSeconds(call))?duration(callStreamSeconds(call)):"—";
const callDeadlinePassed=call=>{const deadline=new Date(call?.expires_at).getTime();return !call?.target_reached_at&&Number.isFinite(deadline)&&Date.now()>=deadline};
const deadlineBars=call=>{const deadline=new Date(call?.expires_at).getTime();return (call?.minute_bars??[]).filter(bar=>{const timestamp=new Date(bar.timestamp).getTime();return Number.isFinite(timestamp)&&(!Number.isFinite(deadline)||timestamp<=deadline)})};
const deadlineSnapshot=call=>{const bars=deadlineBars(call),last=bars.at(-1),values=bars.flatMap(bar=>[number(bar.high,NaN),number(bar.low,NaN)]).filter(Number.isFinite);return {bars,last,high:values.length?Math.max(...values):number(call?.highest_price,NaN),low:values.length?Math.min(...values):number(call?.lowest_price,NaN),price:number(call?.final_price??last?.close??call?.entry_price,NaN)}};
const callTargetPoints=call=>{
  const stored=Number(call?.target_points);
  if(Number.isFinite(stored)&&stored>0)return stored;
  const entry=Number(call?.entry_price),target=Number(call?.target_price);
  return Number.isFinite(entry)&&Number.isFinite(target)?Math.abs(target-entry):50;
};
const callTargetLabel=call=>call?.target_label??`50 ${call?.symbol??"INSTRUMENT"} POINTS`;
const callPartialLabel=call=>call?.target_basis==="NQ_50_POINT_EQUIVALENT"?"30 NQ-POINT EQUIV.":`${(callTargetPoints(call)*.6).toFixed(4)} ${call?.symbol??""} PTS`;
const callOutcome=call=>{
  if(!call)return {grade:"tracking",favorable:0,closed:false};
  const snapshot=deadlineSnapshot(call),datum=number(call.entry_price),favorable=call.direction==="UP"?Math.max(0,number(snapshot.high,datum)-datum):Math.max(0,datum-number(snapshot.low,datum));
  const closed=Boolean(call.target_reached_at)||["COMPLETE","EXPIRED","INTERRUPTED","REVERSED"].includes(String(call.status).toUpperCase())||callDeadlinePassed(call);
  const stored=String(call.outcome_grade??"").toLowerCase(),finalPrice=number(snapshot.price,datum),directionalSuccess=closed&&(call.direction==="UP"?finalPrice>datum:finalPrice<datum);
  const partialThreshold=number(call.partial_target_points,callTargetPoints(call)*.6);
  const grade=!closed?"tracking":stored==="success"||call.target_reached_at||directionalSuccess?"success":stored==="partial"||favorable>=partialThreshold?"partial":"failed",basis=call.target_reached_at||call.success_basis==="TARGET"?"target":directionalSuccess||call.success_basis==="DIRECTIONAL_FINAL"?"directional":null;
  return {grade,favorable,closed,basis,directionalSuccess};
};
const easternFilterParts=value=>{const date=new Date(value);if(Number.isNaN(date.getTime()))return {date:"",time:""};const parts=Object.fromEntries(easternIdFormatter.formatToParts(date).filter(part=>part.type!=="literal").map(part=>[part.type,part.value]));return {date:`${parts.year}-${parts.month}-${parts.day}`,time:`${parts.hour}:${parts.minute}:${parts.second}`}};
const marketHourLabel=value=>{
  const {time}=easternFilterParts(value),[hour=0,minute=0]=time.split(":").map(Number),clock=hour*60+minute;
  if(clock<240)return "OVERNIGHT";
  if(clock<570)return "PRE-MARKET";
  if(clock<630)return "OPENING HOUR";
  if(clock<720)return "MORNING";
  if(clock<840)return "MIDDAY";
  if(clock<900)return "AFTERNOON";
  if(clock<960)return "POWER HOUR";
  if(clock<1200)return "AFTER HOURS";
  return "OVERNIGHT";
};
function GreekAuditBadge({label,tone="neutral",detail=null}){
  return <span className={`greek-audit-badge ${tone}`}>{label?pretty(label).toUpperCase():"—"}{detail&&<small>{detail}</small>}</span>;
}

function GammaDynamicsV2FlowLog({history=[],state,symbol}){
  const source=[...history.filter(row=>row?.symbol===symbol),state].filter(Boolean);
  const rows=[...new Map(source.map(row=>[row.timestamp,row])).values()].sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp)).map(row=>({timestamp:row.timestamp,model:row.gamma_dynamics_v2,metrics:row.gamma_dynamics_v2?.chain_metrics??{}})).filter(row=>Number(row.metrics.chain_available)>0).slice(0,90);
  const [scrollSize,setScrollSize]=useState({width:0,height:0});
  const topScrollRef=useRef(null),bottomScrollRef=useRef(null),leftScrollRef=useRef(null),rightScrollRef=useRef(null),bodyScrollRef=useRef(null),tableRef=useRef(null);
  useEffect(()=>{const update=()=>{const table=tableRef.current;if(table)setScrollSize({width:table.scrollWidth,height:table.scrollHeight})};update();const observer=new ResizeObserver(update);if(tableRef.current)observer.observe(tableRef.current);return()=>observer.disconnect()},[rows.length]);
  const syncFromBody=event=>{if(topScrollRef.current)topScrollRef.current.scrollLeft=event.currentTarget.scrollLeft;if(bottomScrollRef.current)bottomScrollRef.current.scrollLeft=event.currentTarget.scrollLeft;if(leftScrollRef.current)leftScrollRef.current.scrollTop=event.currentTarget.scrollTop;if(rightScrollRef.current)rightScrollRef.current.scrollTop=event.currentTarget.scrollTop};
  const syncHorizontal=event=>{if(bodyScrollRef.current)bodyScrollRef.current.scrollLeft=event.currentTarget.scrollLeft};
  const syncVertical=event=>{if(bodyScrollRef.current)bodyScrollRef.current.scrollTop=event.currentTarget.scrollTop};
  const value=value=>Number.isFinite(Number(value))?number(value).toFixed(4):"—";
  const price=value=>Number.isFinite(Number(value))?number(value).toFixed(2):"—";
  const score=value=>Number.isFinite(Number(value))?number(value).toFixed(3):"—";
  return <article className="panel gamma-v2-flow-log"><header className="panel-head"><div><span>GAMMA DYNAMICS 2.0 · LIVE HEDGE-FLOW LOG</span><h2>Qualified hedge-flow setups · real GEX, filters, levels, and execution</h2></div><b>{rows.length} QUALIFIED SETUPS</b></header><div className="gamma-log-scroll-shell gamma-v2-flow-scroll-shell"><div className="gamma-log-scroll-top" ref={topScrollRef} onScroll={syncHorizontal}><div style={{width:scrollSize.width}}/></div><div className="gamma-log-scroll-row"><div className="gamma-log-scroll-left" ref={leftScrollRef} onScroll={syncVertical}><div style={{height:scrollSize.height}}/></div><div className="gamma-log-scroll" ref={bodyScrollRef} onScroll={syncFromBody}><table ref={tableRef}><thead><tr><th>TIME · EASTERN</th><th>REGIME</th><th>FINAL · CLEAN</th><th>FADE</th><th>AMP</th><th>ENTRY</th><th>SL</th><th>TP</th><th>SPOT</th><th>ZERO GAMMA</th><th>SUPPORT · T+10</th><th>RESISTANCE · T+10</th><th>GEX · REAL</th><th>GEX · RAW</th><th>GEX $ DENSITY</th><th>TW GEX</th><th>SPOOF</th><th>FLOW HACK</th><th>VOL HACK</th><th>RR · T+10</th><th>DR · T+10</th><th>EDGE</th><th>LIQ</th><th>URGENCY · MIN</th></tr></thead><tbody>{rows.map(({timestamp,metrics})=>{const regime=metrics.regime??"WAIT";return <tr key={timestamp}><td>{logDate(timestamp)} · {logTime(timestamp)}</td><td><span className={`gamma-v2-regime ${regime.toLowerCase()}`}>{regime}</span></td><td>{score(metrics.final_score_clean)}</td><td>{score(metrics.fade_score)}</td><td>{score(metrics.amp_score)}</td><td>{price(metrics.entry)}</td><td>{price(metrics.stop_loss)}</td><td>{price(metrics.take_profit)}</td><td>{price(metrics.spot)}</td><td>{price(metrics.zero_gamma)}</td><td>{price(metrics.ksup_t10)}</td><td>{price(metrics.kres_t10)}</td><td>{value(metrics.gex_real)}</td><td>{value(metrics.gex_raw)}</td><td>{value(metrics.gex_dollar_density)}</td><td>{score(metrics.tw_gex)}</td><td>{score(metrics.spoof_score)}</td><td>{value(metrics.flow_hack)}</td><td>{score(metrics.vol_hack)}</td><td>{score(metrics.rr_t10)}</td><td>{score(metrics.dr_t10)}</td><td>{score(metrics.edge)}</td><td>{score(metrics.liquidity_score)}</td><td>{score(metrics.urgency_minutes)}</td></tr>})}</tbody></table>{!rows.length&&<div className="gamma-log-empty"><b>NO QUALIFIED HEDGE-FLOW SETUP YET</b><p>Rows appear only when every Gamma Dynamics 2.0 gate passes; ordinary streamed snapshots are intentionally excluded.</p></div>}</div><div className="gamma-log-scroll-right" ref={rightScrollRef} onScroll={syncVertical}><div style={{height:scrollSize.height}}/></div></div><div className="gamma-log-scroll-bottom" ref={bottomScrollRef} onScroll={syncHorizontal}><div style={{width:scrollSize.width}}/></div></div></article>;
}

function DeltaEventGraphModal({event,onClose}){
  const call=event.call;
  useEffect(()=>{const close=keyEvent=>keyEvent.key==="Escape"&&onClose();window.addEventListener("keydown",close);return()=>window.removeEventListener("keydown",close)},[onClose]);
  const snapshot=call.zone_intelligence_at_signal??{},datum=number(call.entry_price),strike=referenceStrike(call,datum),view=gammaLogVisualState(call);
  const values=[["DIRECTION",biasLabel(call.direction)],["CALL STATE",view.label],["ZONE",pretty(snapshot.zone??"NO_ZONE")],["ZONE MATCH",pct(snapshot.score)],["CONFIDENCE",pct(snapshot.confidence)],["DATUM",datum.toFixed(4)],["SESSION TARGET",number(call.target_price,reachFromDatum(datum,call.direction,call.alerted_at)).toFixed(4)],["STRIKE / REFERENCE",`${strike.estimated?"REF ":""}${strike.value.toFixed(2)}`]];
  return createPortal(<div className="event-graph-backdrop" role="dialog" aria-modal="true" aria-label="Delta Dynamics event dashboard" onPointerDown={pointerEvent=>{if(pointerEvent.target===pointerEvent.currentTarget)onClose()}}><section className="event-graph-dialog event-call-dialog"><header><div><span>DELTA DYNAMICS · EVENT DASHBOARD</span><b>{call.symbol} · {biasLabel(call.direction)} · {logDate(call.alerted_at)} {logTime(call.alerted_at)}</b></div><button type="button" onClick={onClose}>CLOSE</button></header><div className="event-call-dialog-body"><div className="event-popup-summary"><table><thead><tr>{values.map(([label])=><th key={label}>{label}</th>)}</tr></thead><tbody><tr>{values.map(([label,value])=><td className={label==="DIRECTION"?(call.direction==="UP"?"positive":"negative"):""} key={label}>{value}</td>)}</tr></tbody></table></div><div className="event-popup-summary"><table><thead><tr>{SIX_GREEKS.map(name=><th key={name}>{name.toUpperCase()} · SIGNAL</th>)}</tr></thead><tbody><tr>{SIX_GREEKS.map(name=><td key={name}>{signedGreek(call.greek_values_at_signal?.[name])}</td>)}</tr></tbody></table></div><FiftyPointOutcomeCard call={call} system="DELTA_DYNAMICS"/></div></section></div>,document.body);
}

function DeltaDynamicsEventLog({symbol,calls=[]}){
  const [sortOrder,setSortOrder]=useState("newest"),[filterDate,setFilterDate]=useState(""),[fromTime,setFromTime]=useState(""),[toTime,setToTime]=useState(""),[copied,setCopied]=useState(false),[expandedId,setExpandedId]=useState(null);
  const [callStateFilters,setCallStateFilters]=useState(()=>GAMMA_CALL_STATES.map(([value])=>value));
  const [scrollSize,setScrollSize]=useState({width:0,height:0});
  const topScrollRef=useRef(null),bottomScrollRef=useRef(null),leftScrollRef=useRef(null),rightScrollRef=useRef(null),bodyScrollRef=useRef(null),tableRef=useRef(null),stateFilterRef=useRef(null);
  const rows=useMemo(()=>calls.map(call=>{const snapshot=call.zone_intelligence_at_signal??{},datum=number(call.entry_price),strike=referenceStrike(call,datum);return {id:visibleCallId(call,"DELTA_DYNAMICS"),timestamp:call.alerted_at,symbol:call.symbol??symbol,datum,strike,reach:number(call.target_price,reachFromDatum(datum,call.direction,call.alerted_at)),decision:call.direction,zone:snapshot.zone??"NO_ZONE",score:number(snapshot.score),confidence:number(snapshot.confidence),call}}),[calls,symbol]);
  const visible=useMemo(()=>rows.filter(row=>{const parts=easternFilterParts(row.timestamp),key=gammaLogVisualState(row.call).key,stateKey=key==="child-rescued"?"CHILD_RESCUED":key==="success"?"SUCCESS":key==="failed"?"FAILED":"TRACKING";return (!filterDate||parts.date===filterDate)&&timeRangeMatches(parts.time,fromTime,toTime)&&callStateFilters.includes(stateKey)}).sort((a,b)=>(sortOrder==="oldest"?1:-1)*(new Date(a.timestamp)-new Date(b.timestamp))),[rows,sortOrder,filterDate,fromTime,toTime,callStateFilters]);
  const scoreBoard=useMemo(()=>visible.reduce((scores,row)=>{const key=gammaLogVisualState(row.call).key;if(key==="failed")scores.failed+=1;else if(key==="success"||key==="child-rescued")scores.succeeded+=1;else if(key==="tracking-success")scores.trackingSucceeded+=1;else scores.trackingFailed+=1;return scores},{failed:0,succeeded:0,trackingFailed:0,trackingSucceeded:0}),[visible]);
  useEffect(()=>{const closeOnOutside=event=>{const menu=stateFilterRef.current;if(menu?.open&&!menu.contains(event.target))menu.removeAttribute("open")},closeOnEscape=event=>event.key==="Escape"&&stateFilterRef.current?.removeAttribute("open");document.addEventListener("pointerdown",closeOnOutside);document.addEventListener("keydown",closeOnEscape);return()=>{document.removeEventListener("pointerdown",closeOnOutside);document.removeEventListener("keydown",closeOnEscape)}},[]);
  useEffect(()=>{const update=()=>{const table=tableRef.current;if(table)setScrollSize({width:table.scrollWidth,height:table.scrollHeight})};update();const observer=new ResizeObserver(update);if(tableRef.current)observer.observe(tableRef.current);return()=>observer.disconnect()},[visible.length]);
  const syncFromBody=event=>{for(const ref of [topScrollRef,bottomScrollRef])if(ref.current&&ref.current.scrollLeft!==event.currentTarget.scrollLeft)ref.current.scrollLeft=event.currentTarget.scrollLeft;for(const ref of [leftScrollRef,rightScrollRef])if(ref.current&&ref.current.scrollTop!==event.currentTarget.scrollTop)ref.current.scrollTop=event.currentTarget.scrollTop};
  const syncHorizontal=event=>{if(bodyScrollRef.current)bodyScrollRef.current.scrollLeft=event.currentTarget.scrollLeft},syncVertical=event=>{if(bodyScrollRef.current)bodyScrollRef.current.scrollTop=event.currentTarget.scrollTop};
  const toggleCallState=value=>setCallStateFilters(selected=>selected.includes(value)?selected.filter(item=>item!==value):[...selected,value]);
  const copy=async()=>{const headers=["Direction","Call State","Stream Duration","Time · Eastern","Market Hour","Source","Datum / Alert Price","Session Target","Strike / Reference","Current / Final","Current / Final Change","Zone","Zone Match","Confidence",...SIX_GREEKS.map(name=>name.toUpperCase()),"Event ID"],data=visible.map(row=>{const call=row.call,current=number(call.current_price??call.final_price??call.minute_bars?.at(-1)?.close,NaN),change=Number.isFinite(current)?`${current-row.datum>=0?"+":""}${(current-row.datum).toFixed(4)} pts`:"—";return [biasLabel(row.decision),gammaLogVisualState(call).label,callStreamDuration(call),`${logDate(row.timestamp)} ${logTime(row.timestamp)}`,marketHourLabel(row.timestamp),row.symbol,row.datum.toFixed(4),row.reach.toFixed(4),`${row.strike.estimated?"REF ":""}${row.strike.value.toFixed(2)}`,Number.isFinite(current)?current.toFixed(4):"—",change,pretty(row.zone),pct(row.score),pct(row.confidence),...SIX_GREEKS.map(name=>signedGreek(call.greek_values_at_signal?.[name])),row.id]});try{await navigator.clipboard.writeText(exportTsv(`DELTA DYNAMICS EVENT LOG · ${symbol} · EASTERN TIME`,headers,data));setCopied(true);setTimeout(()=>setCopied(false),1800)}catch{setCopied(false)}};
  const expanded=rows.find(row=>row.id===expandedId);
  return <article className="panel gamma-dynamics-log delta-dynamics-log"><header className="panel-head"><div><span>DELTA DYNAMICS EVENT LOG</span><h2>Qualified calls · live outcome tracking and Delta-zone context</h2></div><div className="gamma-log-actions"><button type="button" className="copy-table" onClick={copy} disabled={!visible.length}>{copied?"✓ COPIED":"COPY SUMMARIES"}</button><b>{visible.length}{visible.length!==rows.length?` / ${rows.length}`:""} EVENTS</b></div></header><div className="gamma-log-controls"><label>SORT<select value={sortOrder} onChange={event=>setSortOrder(event.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label><div className="gamma-state-filter"><span>CALL STATE</span><details ref={stateFilterRef}><summary>{callStateFilters.length===GAMMA_CALL_STATES.length?"All states":callStateFilters.length?`${callStateFilters.length} selected`:"None selected"}</summary><div className="gamma-state-menu"><div><button type="button" onClick={()=>setCallStateFilters(GAMMA_CALL_STATES.map(([value])=>value))}>SELECT ALL</button><button type="button" onClick={()=>setCallStateFilters([])}>CLEAR</button></div>{GAMMA_CALL_STATES.map(([value,label])=><label key={value}><input type="checkbox" checked={callStateFilters.includes(value)} onChange={()=>toggleCallState(value)}/><span>{label}</span></label>)}</div></details></div><label>DATE<input type="date" value={filterDate} onChange={event=>setFilterDate(event.target.value)}/></label><CompactEventTimeFilter label="FROM" value={fromTime} onChange={setFromTime}/><CompactEventTimeFilter label="TO" value={toTime} onChange={setToTime}/><button type="button" onClick={()=>{setCallStateFilters(GAMMA_CALL_STATES.map(([value])=>value));setFilterDate("");setFromTime("");setToTime("")}}>CLEAR FILTER</button></div><div className="gamma-event-scoreboard"><article className="failed"><span>FAILED</span><b>{scoreBoard.failed}</b><small>Completed calls</small></article><article className="succeeded"><span>SUCCEEDED</span><b>{scoreBoard.succeeded}</b><small>Includes child rescue</small></article><article className="tracking-failed"><span>FAILING</span><b>{scoreBoard.trackingFailed}</b><small>Direction currently adverse</small></article><article className="tracking-succeeded"><span>SUCCEEDING</span><b>{scoreBoard.trackingSucceeded}</b><small>Direction currently favorable</small></article></div><div className="gamma-log-scroll-shell"><div className="gamma-log-scroll-top" ref={topScrollRef} onScroll={syncHorizontal}><div style={{width:scrollSize.width}}/></div><div className="gamma-log-scroll-row"><div className="gamma-log-scroll-left" ref={leftScrollRef} onScroll={syncVertical}><div style={{height:scrollSize.height}}/></div><div className="gamma-log-scroll" ref={bodyScrollRef} onScroll={syncFromBody}><table ref={tableRef}><thead><tr><th>DIRECTION</th><th>CALL STATE</th><th>EVENT DASHBOARD</th><th>STREAM DURATION</th><th>TIME · EASTERN</th><th>MARKET HOUR</th><th>SOURCE</th><th>DATUM / ALERT PRICE</th><th>SESSION TARGET</th><th>STRIKE / REFERENCE</th><th>CURRENT / FINAL</th><th>CURRENT / FINAL CHANGE</th><th>ZONE</th><th>ZONE MATCH</th><th>CONFIDENCE</th>{SIX_GREEKS.map(name=><th key={name}>{name.toUpperCase()} · SIGNAL</th>)}<th>EVENT ID</th></tr></thead><tbody>{visible.map(row=>{const call=row.call,view=gammaLogVisualState(call),current=number(call.current_price??call.final_price??call.minute_bars?.at(-1)?.close,NaN),change=Number.isFinite(current)?current-row.datum:NaN;return <Fragment key={row.id}><tr className={`gamma-call-${view.key}`}><td><span className={`direction-pill ${row.decision.toLowerCase()}`}>{biasLabel(row.decision)}</span></td><td><span className={`gamma-call-state ${view.key}`}>{view.label}</span></td><td><button type="button" className="view-event-graph" onClick={()=>setExpandedId(currentId=>currentId===row.id?null:row.id)}>{expandedId===row.id?"HIDE DASHBOARD":"VIEW DASHBOARD"}</button></td><td className="stream-duration">{callStreamDuration(call)}</td><td>{logDate(row.timestamp)} · {logTime(row.timestamp)}</td><td><span className="market-hour">{marketHourLabel(row.timestamp)}</span></td><td>{row.symbol}</td><td className="extreme-price">{row.datum.toFixed(4)}</td><td className="extreme-price">{row.reach.toFixed(4)}</td><td className="extreme-price">{row.strike.estimated?"REF ":""}{row.strike.value.toFixed(2)}</td><td className="extreme-price">{Number.isFinite(current)?current.toFixed(4):"—"}</td><td><span className={`point-delta ${change>0?"up":change<0?"down":"flat"}`}>{Number.isFinite(change)?`${change>=0?"+":""}${change.toFixed(4)} pts`:"—"}</span></td><td>{pretty(row.zone)}</td><td>{pct(row.score)}</td><td>{pct(row.confidence)}</td>{SIX_GREEKS.map(name=><td key={name}>{signedGreek(call.greek_values_at_signal?.[name])}</td>)}<td><button type="button" className="call-id" onClick={()=>navigator.clipboard.writeText(row.id)}>{row.id}</button></td></tr>{call.family_legs?.length>0&&<tr className="gamma-family-dropdown-row"><td colSpan={22}><details><summary>SHOW CHILD LEGS · {call.family_stage} · AVG DATUM {number(call.family_average_datum).toFixed(4)} · AVG P/L {number(call.family_average_pl_points)>=0?"+":""}{number(call.family_average_pl_points).toFixed(4)} PTS</summary><div className="risk-leg-table-wrap"><table className="risk-leg-table"><thead><tr><th>LEG</th><th>CHILD ID</th><th>ROLE</th><th>STATUS</th><th>ACTIVATED · ET</th><th>DATUM</th><th>CURRENT / FINAL</th><th>LEG P/L</th></tr></thead><tbody>{call.family_legs.map(leg=>{const price=number(call.current_price??call.final_price,leg.datum),pl=call.direction==="UP"?price-number(leg.datum):number(leg.datum)-price;return <tr key={leg.call_id}><td>{leg.leg_number}</td><td><button type="button" className="call-id" onClick={()=>navigator.clipboard.writeText(leg.call_id)}>{leg.call_id}</button></td><td>{leg.role}</td><td>{leg.status??"TRACKING"}</td><td>{logDate(leg.activated_at)} · {logTime(leg.activated_at)}</td><td>{number(leg.datum).toFixed(4)}</td><td>{price.toFixed(4)}</td><td className={pl>=0?"positive":"negative"}>{pl>=0?"+":""}{pl.toFixed(4)} pts</td></tr>})}</tbody></table></div></details></td></tr>}</Fragment>})}</tbody></table>{!visible.length&&<div className="gamma-log-empty"><b>{rows.length?"NO EVENTS MATCH THIS RANGE":"NO QUALIFIED DELTA DYNAMICS EVENT YET"}</b><p>{rows.length?"Clear or widen the date, time, or call-state filter.":"Calls appear after the active market-zone formulas qualify."}</p></div>}</div><div className="gamma-log-scroll-right" ref={rightScrollRef} onScroll={syncVertical}><div style={{height:scrollSize.height}}/></div></div><div className="gamma-log-scroll-bottom" ref={bottomScrollRef} onScroll={syncHorizontal}><div style={{width:scrollSize.width}}/></div></div>{expanded&&<DeltaEventGraphModal event={expanded} onClose={()=>setExpandedId(null)}/>}</article>;
}

function GammaEventLogSummary({event,call}){
  const view=gammaLogVisualState(call),datum=number(call.entry_price,event.price),high=number(call.highest_price,call.dynamic_high),low=number(call.lowest_price,call.dynamic_low),current=number(call.current_price??call.final_price??call.minute_bars?.at(-1)?.close,NaN),strike=referenceStrike(call,datum),finished=callOutcome(call).closed,change=value=>Number.isFinite(value)?`${value-datum>=0?"+":""}${(value-datum).toFixed(4)} pts`:"—",signalRanks=call.greek_rankings_at_signal??greekRankings(call.greek_scores_at_signal??{}),finalRanks=call.greek_rankings_at_target??call.greek_rankings_at_failure??greekRankings(call.greek_scores_current??{});
  const headers=["DIRECTION","CALL STATE","STREAM DURATION","HIGH CHANGE","TIME · MS","DATE · EASTERN","MARKET HOUR","SOURCE","DATUM / ALERT PRICE","SESSION TARGET","STRIKE / REFERENCE","DYNAMIC / EXTREME HIGH","TIME TO HIGH","DYNAMIC / EXTREME LOW","LOW CHANGE","TIME TO LOW","CURRENT / FINAL","CURRENT / FINAL CHANGE","STRONGEST GREEK","WEAKEST GREEK","INTENSITY","PRESSURE",...GAMMA_DYNAMICS_GREEKS.flatMap(name=>[`${name.toUpperCase()} @ STRIKE · RAW`,`${name.toUpperCase()} @ STRIKE · NORM`,`${name.toUpperCase()} HIGH`,`${name.toUpperCase()} LOW`]),...["STRIKE","FINAL"].flatMap(phase=>GAMMA_RANKS.map(rank=>`${phase} · ${rank.toUpperCase()}`)),"EVENT ID"];
  const values=[biasLabel(call.direction),view.label,callStreamDuration(call),change(high),logTime(call.alerted_at),logDate(call.alerted_at),marketHourLabel(call.alerted_at),call.symbol,datum.toFixed(4),number(call.target_price,gammaReachFromDatum(datum,call.direction,call.alerted_at)).toFixed(4),`${strike.estimated?"REF ":""}${strike.value.toFixed(2)}`,Number.isFinite(high)?high.toFixed(4):"—",finished?duration(call.seconds_to_high):"TRACKING",Number.isFinite(low)?low.toFixed(4):"—",change(low),finished?duration(call.seconds_to_low):"TRACKING",Number.isFinite(current)?current.toFixed(4):"—",change(current),call.strongest_greek_current??call.strongest_greek??"—",call.weakest_greek_current??call.weakest_greek??"—",pct(event.intensity),Number.isFinite(event.pressure)?`${event.pressure>0?"+":""}${event.pressure.toFixed(2)}`:"—",...GAMMA_DYNAMICS_GREEKS.flatMap(name=>{const signal=call.greek_values_at_signal?.[name]??event[name],normalized=call.gamma_dynamics_at_signal?.normalized?.[name]??event.normalized?.[name];return [signedGreek(signal),Number.isFinite(Number(normalized))?`${number(normalized)>=0?"+":""}${number(normalized).toFixed(3)}`:"—",signedGreek(call.greek_values_highest?.[name]??signal),signedGreek(call.greek_values_lowest?.[name]??signal)]}),...GAMMA_RANKS.map(rank=>rankingText(signalRanks,rank)),...GAMMA_RANKS.map(rank=>rankingText(finalRanks,rank)),event.id];
  const valueTone=(value,header)=>{const text=String(value);if(header==="DIRECTION")return text.includes("UP")?"positive":"negative";return text.startsWith("+")?"positive":text.startsWith("-")?"negative":""};
  return <><div className="event-popup-summary"><table><thead><tr>{headers.map(header=><th key={header}>{header}</th>)}</tr></thead><tbody><tr>{values.map((value,index)=><td className={valueTone(value,headers[index])} key={`${headers[index]}-${index}`}>{value}</td>)}</tr></tbody></table></div>{call.family_legs?.length>0&&<div className="event-popup-summary child-calls"><table><thead><tr><th>CHILD LEG</th><th>CHILD ID</th><th>ROLE</th><th>STATUS</th><th>ACTIVATED · EASTERN</th><th>DATUM</th><th>CURRENT / FINAL</th><th>LEG P/L</th></tr></thead><tbody>{call.family_legs.filter(leg=>leg.role==="CHILD").map(leg=>{const price=number(call.current_price??call.final_price,leg.datum),pl=call.direction==="UP"?price-number(leg.datum):number(leg.datum)-price;return <tr key={leg.call_id}><td>{leg.leg_number}</td><td>{leg.call_id}</td><td>{leg.role}</td><td>{leg.status??"TRACKING"}</td><td>{logDate(leg.activated_at)} · {logTime(leg.activated_at)}</td><td>{number(leg.datum).toFixed(4)}</td><td>{price.toFixed(4)}</td><td className={pl>=0?"positive":"negative"}>{pl>=0?"+":""}{pl.toFixed(4)} pts</td></tr>})}</tbody></table></div>}</>;
}

function GammaDynamicsV2EventData({event,call}){
  const snapshot=call.gamma_dynamics_v2_at_signal??{},inputs=snapshot.inputs??call.greek_values_at_signal??event,metrics=snapshot.chain_metrics??{},checks=snapshot.alert_checks??{};
  const value=item=>typeof item==="string"?item:Number.isFinite(Number(item))?number(item).toFixed(4):"—";
  const modelRows=[["SPOT",metrics.spot],["ZERO GAMMA · REAL",metrics.zero_gamma],["SUPPORT · T+10",metrics.ksup_t10],["RESISTANCE · T+10",metrics.kres_t10],["GEX · RAW",metrics.gex_raw],["GEX · REAL",metrics.gex_real],["GEX $ DENSITY",metrics.gex_dollar_density],["TW GEX",metrics.tw_gex],["FLOW HACK",metrics.flow_hack],["VOL HACK",metrics.vol_hack],["RR · T+10",metrics.rr_t10],["DR · T+10",metrics.dr_t10],["SPOOF SCORE",metrics.spoof_score],["FADE SCORE",metrics.fade_score],["AMP SCORE",metrics.amp_score],["FINAL SCORE · CLEAN",metrics.final_score_clean],["REGIME",metrics.regime],["ENTRY",metrics.entry],["STOP LOSS",metrics.stop_loss],["TAKE PROFIT",metrics.take_profit],["LIQUIDITY SCORE",metrics.liquidity_score],["EDGE",metrics.edge],["URGENCY · MIN",metrics.urgency_minutes]];
  return <><div className="event-popup-summary"><table><thead><tr><th colSpan={modelRows.length}>GAMMA DYNAMICS 2.0 · CHAIN MODEL SNAPSHOT AT SIGNAL</th></tr><tr>{modelRows.map(([label])=><th key={label}>{label}</th>)}</tr></thead><tbody><tr>{modelRows.map(([label,current])=><td key={label}>{label==="PROBABILITY"?pct(current):value(current)}</td>)}</tr></tbody></table></div><div className="event-popup-summary"><table><thead><tr><th colSpan={GAMMA_DYNAMICS_V2_GREEKS.length}>SIX GREEKS · RAW AT SIGNAL</th></tr><tr>{GAMMA_DYNAMICS_V2_GREEKS.map(name=><th key={name}>{name.toUpperCase()}</th>)}</tr></thead><tbody><tr>{GAMMA_DYNAMICS_V2_GREEKS.map(name=><td key={name}>{signedGreek(inputs[name])}</td>)}</tr></tbody></table></div><div className="event-popup-summary"><table><thead><tr><th colSpan={Object.keys(checks).length||1}>QUALIFICATION GATES</th></tr><tr>{Object.keys(checks).map(name=><th key={name}>{pretty(name).toUpperCase()}</th>)}</tr></thead><tbody><tr>{Object.entries(checks).map(([name,passed])=><td className={passed?"positive":"negative"} key={name}>{passed?"PASS":"WAIT"}</td>)}</tr></tbody></table></div></>;
}

function GammaShadowChallengerAudit({call}){
  const shadows=call.shadow_challengers??[];
  if(!shadows.length)return null;
  return <div className="event-popup-summary child-calls"><table><thead><tr><th colSpan="8">GAMMA 1.0 · SUPPRESSED OPPOSITE CHALLENGERS · PAPER TRACKING ONLY</th></tr><tr><th>DIRECTION</th><th>STARTED · ET</th><th>CONFIRMATIONS</th><th>ENTRY</th><th>TARGET</th><th>STATUS / REASON</th><th>HYPOTHETICAL P/L</th><th>BETTER PATH</th></tr></thead><tbody>{shadows.map(shadow=>{const pnl=number(shadow.hypothetical_pnl_points,NaN),comparison=shadow.comparison??{};return <tr key={shadow.id}><td><span className={`direction-pill ${String(shadow.direction??"").toLowerCase()}`}>{biasLabel(shadow.direction)}</span></td><td>{logDate(shadow.started_at)} · {logTime(shadow.started_at)}</td><td>{shadow.confirmations??0}</td><td>{number(shadow.entry_price).toFixed(4)}</td><td>{number(shadow.target_price).toFixed(4)}</td><td>{pretty(shadow.completion_reason??shadow.status??"TRACKING")}</td><td className={pnl>0?"positive":pnl<0?"negative":""}>{Number.isFinite(pnl)?`${pnl>=0?"+":""}${pnl.toFixed(4)} pts`:"TRACKING"}</td><td>{comparison.better_path??"PENDING"}</td></tr>})}</tbody></table></div>;
}

function GammaEventGraphModal({event,call,version=1,onClose}){
  useEffect(()=>{const close=keyEvent=>keyEvent.key==="Escape"&&onClose();window.addEventListener("keydown",close);return()=>window.removeEventListener("keydown",close)},[onClose]);
  const view=gammaLogVisualState(call),datum=number(call.entry_price,event.price),high=number(call.highest_price,call.dynamic_high),low=number(call.lowest_price,call.dynamic_low),current=number(call.current_price??call.final_price??call.minute_bars?.at(-1)?.close,NaN),change=value=>Number.isFinite(value)?`${value-datum>=0?"+":""}${(value-datum).toFixed(4)} pts`:"—";
  return createPortal(<div className="event-graph-backdrop" role="dialog" aria-modal="true" aria-label="Gamma Dynamics event details" onPointerDown={pointerEvent=>{if(pointerEvent.target===pointerEvent.currentTarget)onClose()}}><section className="event-graph-dialog event-call-dialog"><header><div><span>GAMMA DYNAMICS {version}.0 · EVENT DETAILS</span><b>{call.symbol} · {biasLabel(call.direction)} · {logDate(call.alerted_at)} {logTime(call.alerted_at)}</b></div><button type="button" onClick={onClose}>CLOSE</button></header><div className="event-call-dialog-body"><GammaEventLogSummary event={event} call={call}/>{version===1&&<GammaShadowChallengerAudit call={call}/>}<FiftyPointOutcomeCard call={call} system={version===2?"GAMMA_DYNAMICS_V2":"GAMMA_DYNAMICS"}/></div></section></div>,document.body);
}

function FiftyPointPathChart({call,onValueChange}){
  const observedBars=deadlineBars(call).filter(bar=>Number.isFinite(number(bar.high,NaN))&&Number.isFinite(number(bar.low,NaN))).sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
  const [hovered,setHovered]=useState(null),[expanded,setExpanded]=useState(false),[yZoom,setYZoom]=useState(1),[yCenter,setYCenter]=useState(null);
  const datum=number(call.entry_price),targetPoints=callTargetPoints(call),target=number(call.target_price,datum+(call.direction==="UP"?targetPoints:-targetPoints)),targetLabel=callTargetLabel(call);
  const childDatums=(call.family_legs??[]).filter(leg=>leg.role==="CHILD").map((leg,index)=>({label:`CHILD ${index+1}`,value:number(leg.datum),activatedAt:leg.activated_at})).filter(level=>Number.isFinite(level.value));
  const datumOnly=!observedBars.length;
  const bars=datumOnly?[{timestamp:call.alerted_at,open:datum,high:datum,low:datum,close:datum,samples:1}]:observedBars;
  const values=bars.flatMap(bar=>[number(bar.high),number(bar.low),number(bar.open),number(bar.close)]).concat([datum],childDatums.map(level=>level.value));
  const rawMin=Math.min(...values),rawMax=Math.max(...values),padding=Math.max((rawMax-rawMin)*.18,Math.abs(rawMax)*.00012,.025);
  const baseMin=rawMin-padding,baseMax=rawMax+padding,baseSpan=Math.max(baseMax-baseMin,.05),baseCenter=(baseMin+baseMax)/2;
  const viewSpan=baseSpan/yZoom,center=yCenter??baseCenter,min=center-viewSpan/2,max=center+viewSpan/2,dims={width:920,height:270,left:76,right:24,top:20,bottom:48};
  const plotWidth=dims.width-dims.left-dims.right,plotHeight=dims.height-dims.top-dims.bottom;
  const x=index=>dims.left+(index+.5)*plotWidth/Math.max(1,bars.length);
  const y=value=>dims.top+(max-value)*plotHeight/Math.max(max-min,1e-9);
  const highPath=bars.map((bar,index)=>`${index?"L":"M"}${x(index).toFixed(1)},${y(number(bar.high)).toFixed(1)}`).join(" ");
  const lowPath=bars.map((bar,index)=>`${index?"L":"M"}${x(index).toFixed(1)},${y(number(bar.low)).toFixed(1)}`).join(" ");
  const closePath=bars.map((bar,index)=>`${index?"L":"M"}${x(index).toFixed(1)},${y(number(bar.close)).toFixed(1)}`).join(" ");
  const ticks=Array.from({length:5},(_,index)=>max-(max-min)*index/4);
  const xTickIndexes=[...new Set(Array.from({length:Math.min(5,bars.length)},(_,index)=>Math.round(index*(bars.length-1)/Math.max(1,Math.min(5,bars.length)-1))))];
  const onPointerMove=event=>{const bounds=event.currentTarget.getBoundingClientRect(),ratio=(event.clientX-bounds.left)/Math.max(bounds.width,1),svgX=ratio*dims.width,index=Math.max(0,Math.min(bars.length-1,Math.round((svgX-dims.left)/Math.max(plotWidth,1)*bars.length-.5))),bar=bars[index];setHovered({index,bar,side:ratio>.5?"left":"right"});onValueChange?.(bar)};
  const onWheel=event=>{
    event.preventDefault();
    if(event.shiftKey){
      setYCenter((yCenter??baseCenter)+(event.deltaY>0?-1:1)*viewSpan*.14);
      return;
    }
    const bounds=event.currentTarget.getBoundingClientRect(),ratio=Math.max(0,Math.min(1,(event.clientY-bounds.top)/Math.max(bounds.height,1)));
    const cursorPrice=max-ratio*(max-min),nextZoom=Math.max(1,Math.min(40,yZoom*(event.deltaY<0?1.25:.8))),nextSpan=baseSpan/nextZoom;
    setYZoom(nextZoom);setYCenter(nextZoom===1?null:cursorPrice+(ratio-.5)*nextSpan);
  };
  const resetY=()=>{setYZoom(1);setYCenter(null)};
  const diff=value=>{const result=number(value)-datum;return `${result>=0?"+":""}${result.toFixed(4)} pts`};
  const targetVisible=target>=min&&target<=max,targetAtTop=target>max;
  useEffect(()=>{if(!expanded)return;const previous=document.body.style.overflow;document.body.style.overflow="hidden";const close=event=>event.key==="Escape"&&setExpanded(false);window.addEventListener("keydown",close);return()=>{document.body.style.overflow=previous;window.removeEventListener("keydown",close)}},[expanded]);
  const content=<div className={`alert-path-chart ${expanded?"is-expanded":""}`}>
    <div className="alert-path-toolbar"><div><b>{call.symbol} · {biasLabel(call.direction)} CALL</b><span>Observed price auto-scale · wheel zooms Y · Shift+wheel moves Y</span></div><div><button type="button" onClick={()=>setYCenter((yCenter??baseCenter)+viewSpan*.14)}>Y ↑</button><button type="button" onClick={()=>setYCenter((yCenter??baseCenter)-viewSpan*.14)}>Y ↓</button><b>Y {yZoom.toFixed(1)}×</b><button type="button" onClick={resetY} disabled={yZoom===1&&yCenter==null}>RESET Y</button><button type="button" className="expand-path" onClick={()=>setExpanded(value=>!value)}>{expanded?"↙ MINIMIZE":"↗ EXPAND"}</button></div></div>
    {datumOnly&&<div className="datum-only-warning">DATUM ONLY · this older call has no stored one-minute observations. No highs or lows were reconstructed.</div>}
    <div className="alert-path-legend"><span className="datum">PARENT DATUM {datum.toFixed(4)}</span>{childDatums.map(level=><span className="child-datum" key={level.label}>{level.label} {level.value.toFixed(4)}</span>)}<span className="high">MINUTE HIGH</span><span className="low">MINUTE LOW</span><span className="close">MINUTE CLOSE</span><span className="target">{targetLabel} · {call.direction==="UP"?"LONG":"SHORT"} {target.toFixed(4)}</span></div>
    <div className="alert-path-stage">
      <svg viewBox={`0 0 ${dims.width} ${dims.height}`} role="img" aria-label={`One-minute high and low path from the ${biasLabel(call.direction)} alert datum to its ${targetLabel} target`} onWheel={onWheel} onDoubleClick={resetY} onPointerMove={onPointerMove} onPointerLeave={()=>{setHovered(null);onValueChange?.(null)}}>
        {ticks.map((tick,index)=><g key={tick}><line className="path-grid" x1={dims.left} x2={dims.width-dims.right} y1={y(tick)} y2={y(tick)}/><text className="path-axis-text" x={dims.left-10} y={y(tick)+4} textAnchor="end">{tick.toFixed(4)}</text></g>)}
        {xTickIndexes.map(index=><g key={index}><line className="path-grid vertical" x1={x(index)} x2={x(index)} y1={dims.top} y2={dims.height-dims.bottom}/><text className="path-axis-text" x={x(index)} y={dims.height-24} textAnchor="middle">{chartTime(bars[index].timestamp)}</text></g>)}
        <text className="path-axis-title" transform={`translate(16 ${dims.top+plotHeight/2}) rotate(-90)`} textAnchor="middle">PRICE ({call.symbol})</text>
        <text className="path-axis-title" x={dims.left+plotWidth/2} y={dims.height-4} textAnchor="middle">TIME · EST</text>
        <line className="path-reference datum" x1={dims.left} x2={dims.width-dims.right} y1={y(datum)} y2={y(datum)}/>
        <text className="path-reference-label parent" x={dims.width-dims.right-6} y={y(datum)-5} textAnchor="end">PARENT DATUM</text>
        {childDatums.map(level=><g key={level.label}><line className="path-reference child-datum" x1={dims.left} x2={dims.width-dims.right} y1={y(level.value)} y2={y(level.value)}/><text className="path-reference-label child" x={dims.width-dims.right-6} y={y(level.value)-5} textAnchor="end">{level.label}</text></g>)}
        {childDatums.map(level=>{const activatedAt=new Date(level.activatedAt).getTime(),index=bars.reduce((closest,bar,current)=>Math.abs(new Date(bar.timestamp).getTime()-activatedAt)<Math.abs(new Date(bars[closest].timestamp).getTime()-activatedAt)?current:closest,0),markerX=x(index);return Number.isFinite(activatedAt)?<g className="child-strike-marker" key={`${level.label}-strike`}><line x1={markerX} x2={markerX} y1={dims.top} y2={dims.height-dims.bottom}/><circle cx={markerX} cy={y(level.value)} r="5"/><text x={markerX+7} y={dims.top+15}>{level.label} STRIKE</text></g>:null})}
        {targetVisible?<line className="path-reference target" x1={dims.left} x2={dims.width-dims.right} y1={y(target)} y2={y(target)}/>:<g className="path-target-edge"><line x1={dims.left} x2={dims.width-dims.right} y1={targetAtTop?dims.top:dims.height-dims.bottom} y2={targetAtTop?dims.top:dims.height-dims.bottom}/><text x={dims.width-dims.right-6} y={targetAtTop?dims.top+14:dims.height-dims.bottom-7} textAnchor="end">TARGET {targetAtTop?"↑":"↓"} {target.toFixed(4)}</text></g>}
        {bars.map((bar,index)=><g className="minute-candle" key={`${bar.timestamp}-${index}`}><line x1={x(index)} x2={x(index)} y1={y(number(bar.high))} y2={y(number(bar.low))}/><line className="open-tick" x1={x(index)-5} x2={x(index)} y1={y(number(bar.open))} y2={y(number(bar.open))}/><line className="close-tick" x1={x(index)} x2={x(index)+5} y1={y(number(bar.close))} y2={y(number(bar.close))}/></g>)}
        <path className="minute-high-line" d={highPath}/><path className="minute-low-line" d={lowPath}/><path className="minute-close-line" d={closePath}/>
        {hovered&&<line className="path-crosshair" x1={x(hovered.index)} x2={x(hovered.index)} y1={dims.top} y2={dims.height-dims.bottom}/>}
      </svg>
      {hovered&&<div className={`alert-path-tooltip corner ${hovered.side}`}><b>{logDate(hovered.bar.timestamp)} · {logTime(hovered.bar.timestamp)}</b><span>OPEN {number(hovered.bar.open).toFixed(4)} <i>{diff(hovered.bar.open)}</i></span><span>HIGH {number(hovered.bar.high).toFixed(4)} <i>{diff(hovered.bar.high)}</i></span><span>LOW {number(hovered.bar.low).toFixed(4)} <i>{diff(hovered.bar.low)}</i></span><span>CLOSE {number(hovered.bar.close).toFixed(4)} <i>{diff(hovered.bar.close)}</i></span></div>}
    </div>
    <div className="alert-path-help"><span>Wheel: zoom Y around cursor price</span><span>Shift + wheel or Y ↑/↓: move Y-axis</span><span>Double-click: reset observed-price scale</span></div>
  </div>;
  return expanded?createPortal(<div className="alert-path-expanded">{content}</div>,document.body):content;
}

function FiftyPointOutcomeCard({call,system="PRIMARY_OPTIONS"}){
  const reached=Boolean(call.target_reached_at),expired=call.status==="EXPIRED"||callDeadlinePassed(call),callId=visibleCallId(call,system),closeState=expired?"EXPIRED":call.target_close_confirmed===true?"CONFIRMED":call.target_close_confirmed===false?"NOT CONFIRMED":"PENDING";
  const finished=expired||call.status==="COMPLETE";
  const snapshot=deadlineSnapshot(call),currentPrice=expired?snapshot.price:(call.current_price??call.final_price??call.minute_bars?.at(-1)?.close);
  const elapsedEnd=expired?new Date(call.expires_at):new Date(call.current_price_at??call.price_observed_at??call.alerted_at);
  const liveElapsed=Math.max(0,(elapsedEnd-new Date(call.alerted_at))/1000);
  const strongest=reached?call.strongest_greek_at_target:(call.strongest_greek_current??call.strongest_greek);
  const weakest=reached?call.weakest_greek_at_target:(call.weakest_greek_current??call.weakest_greek);
  const datum=number(call.entry_price),dynamicHigh=number(expired?snapshot.high:call.dynamic_high,call.highest_price),dynamicLow=number(expired?snapshot.low:call.dynamic_low,call.lowest_price),outcome=callOutcome(call);
  const rawDiff=value=>number(value)-datum,toneFor=value=>Math.abs(rawDiff(value))<1e-9?"neutral":call.direction==="UP"?(value>datum?"favor":"against"):(value<datum?"favor":"against");
  const targetPoints=callTargetPoints(call),targetLabel=callTargetLabel(call),towardsTarget=call.direction==="UP"?number(currentPrice)-datum:datum-number(currentPrice),progress=Math.max(0,Math.min(100,towardsTarget/targetPoints*100));
  const gammaRankPhase=reached?"target":expired?"failure":"current",gammaRankScores=call[`greek_scores_at_${gammaRankPhase}`]??(gammaRankPhase==="failure"?call.greek_scores_current:{}),gammaRankings=["GAMMA_DYNAMICS","GAMMA_DYNAMICS_V2"].includes(system)?(call[`greek_rankings_at_${gammaRankPhase}`]??greekRankings(gammaRankScores)):null;
  const pointLabel=value=>{const difference=rawDiff(value);return `${difference>=0?"+":""}${difference.toFixed(4)} pts`};
  return <article className={`fifty-point-card outcome-${outcome.grade}`}>
    <header><div><span>CALL ID</span><button type="button" className="call-id" onClick={()=>navigator.clipboard.writeText(callId)}>{callId}</button></div><div><span>CALL</span><b className={call.direction==="UP"?"positive":"negative"}>{biasLabel(call.direction)} · DATUM {datum.toFixed(4)}</b></div><div><span>STATUS</span><b>{reached?`${targetLabel} REACHED`:expired?"OBSERVATION WINDOW EXPIRED":"TRACKING LIVE"}</b><em className={`outcome-grade ${outcome.grade}`}>{outcome.grade==="partial"?callPartialLabel(call):outcome.grade.toUpperCase()}</em></div></header>
    <div className="outcome-path-focus">
      <FiftyPointPathChart call={call}/>
      <aside className="path-focus-dashboard">
        <header className="path-focus-title"><div><span>CALL PATH FOCUS</span><b>{finished?"FINAL OBSERVATION":"LIVE OBSERVATION"}</b></div><em className={`outcome-grade ${outcome.grade}`}>{outcome.grade==="partial"?callPartialLabel(call):outcome.grade.toUpperCase()}</em></header>
        <div className={`path-focus-stat ${toneFor(dynamicHigh)}`}><span>{finished?"FINAL HIGH":"DYNAMIC HIGH"}</span><b>{dynamicHigh.toFixed(4)}</b><small>({pointLabel(dynamicHigh)})</small></div>
        <div className={`path-focus-stat ${toneFor(dynamicLow)}`}><span>{finished?"FINAL LOW":"DYNAMIC LOW"}</span><b>{dynamicLow.toFixed(4)}</b><small>({pointLabel(dynamicLow)})</small></div>
        <div className={`path-focus-stat progress ${towardsTarget>0?"favor":towardsTarget<0?"against":"neutral"}`}><span>TOWARD {targetLabel}</span><b>{towardsTarget>=0?"+":""}{towardsTarget.toFixed(4)} / {targetPoints.toFixed(4)} {call.symbol}</b><i><em style={{width:`${progress}%`}}/></i><small>{progress.toFixed(1)}% of directional target</small></div>
        <div className={`path-focus-stat current ${toneFor(currentPrice)}`}><span>{finished?"FINAL PRICE":"CURRENT PRICE"}</span><b>{Number.isFinite(Number(currentPrice))?number(currentPrice).toFixed(4):"—"}</b><small>({Number.isFinite(Number(currentPrice))?pointLabel(currentPrice):"—"})</small></div>
        <div className="path-focus-stat greek"><span>{reached?"STRONGEST AT TARGET":"STRONGEST · CURRENT"}</span><GreekAuditBadge label={strongest} tone="strong"/></div>
        <div className="path-focus-stat greek"><span>{reached?"WEAKEST AT TARGET":"WEAKEST · CURRENT"}</span><GreekAuditBadge label={weakest} tone="weak"/></div>
      </aside>
    </div>
    {gammaRankings&&<div className="call-path-greek-ranks"><header><span>{system==="GAMMA_DYNAMICS_V2"?"SIX":"FOUR"}-GREEK RANKING · {gammaRankPhase==="target"?"SUCCESS":gammaRankPhase==="failure"?"FAILURE":"LIVE"}</span><small>Direction-adjusted relative strength at this call state</small></header>{GAMMA_RANKS.map(rank=><div className={rank} key={rank}><span>{rank.toUpperCase()}</span><b>{rankingText(gammaRankings,rank)}</b></div>)}</div>}
    {system==="GAMMA_DYNAMICS_V2"&&<GammaDynamicsV2EventData event={{}} call={call}/>}<div className="target-evaluation-row">
      <div><span>EXPIRES · EASTERN</span><b>{logDate(call.expires_at)}<small>{logTime(call.expires_at)}</small></b></div>
      <div><span>REACHED · EASTERN</span><b>{reached?<>{logDate(call.target_reached_at)}<small>{logTime(call.target_reached_at)}</small></>:"—"}</b></div>
      <div><span>REACH PRICE</span><b>{reached?number(call.target_reached_price).toFixed(4):"—"}</b></div>
      <div><span>ELAPSED</span><b>{reached?duration(call.seconds_to_target):expired?duration(call.seconds_observed):duration(liveElapsed)}</b><small>{expired?"WINDOW COMPLETE":"Observed time"}</small></div>
      <div><span>TARGET TOUCH</span><b>{reached?call.target_touch_type:expired?"NOT REACHED":"—"}</b><small>{reached?(call.target_touch_type==="OPEN"?"First observation of minute":call.direction==="UP"?"Minute high touched target":"Minute low touched target"):expired?`${number(call.target_shortfall_points).toFixed(4)} points short`:"Awaiting observed touch"}</small></div>
      <div><span>MINUTE CLOSE</span><b>{closeState}</b><small>{call.target_close_price!=null?number(call.target_close_price).toFixed(4):expired?"No target minute":"Finalizes after target minute"}</small></div>
    </div>
    <footer><span>Source {pretty(call.price_source??"unknown")}</span><span>One-minute OHLC is aggregated from observed updates; no synthetic candles.</span><span>{targetLabel}: {targetPoints.toFixed(4)} {call.symbol} pts · target {number(call.target_price,datum+(call.direction==="UP"?targetPoints:-targetPoints)).toFixed(4)}</span>{call.target_conversion_quality==="ESTIMATED_NO_LIVE_NQ"&&<span>ESTIMATED PROXY · no synchronized NQ quote</span>}</footer>
  </article>;
}

function dedupeLogicalCalls(calls=[]){
  const unresolved=new Set();
  return calls.filter(call=>{
    const tracking=!call.target_reached_at&&(call.status==="TRACKING"||call.status==null);
    const key=`${call.system??""}|${call.symbol??""}|${call.direction??""}|${number(call.entry_price).toFixed(4)}`;
    if(tracking&&unresolved.has(key))return false;
    if(tracking)unresolved.add(key);
    return true;
  });
}

function OutcomeAttributionMini({system,data,symbol}){
  const group=data?.systems?.[system]??{highest:[],lowest:[],tracking:0,total:0};
  const legacy=[...(group.highest??[]),...(group.lowest??[])],calls=dedupeLogicalCalls(group.calls??[...new Map(legacy.map(item=>[item.id,item])).values()]);
  const [copied,setCopied]=useState(false),[query,setQuery]=useState(""),[dateFilter,setDateFilter]=useState(""),[timeFilter,setTimeFilter]=useState(""),[pickerOpen,setPickerOpen]=useState(false),[selectedId,setSelectedId]=useState(""),[lookedUpCall,setLookedUpCall]=useState(null),[lookupError,setLookupError]=useState("");
  const source=calls.find(Boolean)?.price_source??"WAITING";
  const normalized=query.trim(),localMatch=calls.find(call=>visibleCallId(call,system)===normalized),selectedCall=lookedUpCall??calls.find(call=>visibleCallId(call,system)===selectedId);
  const matchingCalls=calls.filter(call=>{const parts=easternFilterParts(call.alerted_at);return (!normalized||visibleCallId(call,system).includes(normalized))&&(!dateFilter||parts.date===dateFilter)&&(!timeFilter||parts.time.startsWith(timeFilter))});
  const filteredCalls=selectedCall?[selectedCall]:(normalized||dateFilter||timeFilter?matchingCalls:calls);
  const selectCall=call=>{const id=visibleCallId(call,system);setQuery(id);setSelectedId(id);setLookedUpCall(null);setPickerOpen(false);setLookupError("")};
  const lookup=async()=>{
    if(!normalized){setSelectedId("");setLookedUpCall(null);setLookupError("");return}
    if(localMatch){setSelectedId(normalized);setLookedUpCall(null);setLookupError("");return}
    try{
      const stored=await fetchOutcomeCall(normalized);
      if(stored.system!==system||stored.symbol!==symbol)throw new Error("That ID belongs to a different system or instrument.");
      setSelectedId(normalized);setLookedUpCall(stored);setLookupError("");
    }catch(error){setSelectedId("");setLookedUpCall(null);setLookupError(error.message)}
  };
  useEffect(()=>{setQuery("");setDateFilter("");setTimeFilter("");setPickerOpen(false);setSelectedId("");setLookedUpCall(null);setLookupError("")},[system,symbol]);
  const copyTable=async()=>{
    const header=["CALL ID","STATUS","CALL","ALERT DATE ET","ALERT TIME ET","EXPIRES DATE ET","EXPIRES TIME ET","DATUM","TARGET","DYNAMIC HIGH","DYNAMIC LOW","CURRENT/FINAL PRICE","REACHED DATE ET","REACHED TIME ET","REACH PRICE","SECONDS TO TARGET","TOUCH TYPE","CLOSE CONFIRMED","CURRENT STRONGEST GREEK","CURRENT WEAKEST GREEK","SOURCE"];
    const lines=filteredCalls.map(call=>[visibleCallId(call,system),call.status,biasLabel(call.direction),logDate(call.alerted_at),logTime(call.alerted_at),logDate(call.expires_at),logTime(call.expires_at),number(call.entry_price).toFixed(4),call.target_price==null?"—":number(call.target_price).toFixed(4),number(call.dynamic_high,call.highest_price).toFixed(4),number(call.dynamic_low,call.lowest_price).toFixed(4),Number.isFinite(Number(call.current_price??call.final_price))?number(call.current_price??call.final_price).toFixed(4):"—",call.target_reached_at?logDate(call.target_reached_at):"—",call.target_reached_at?logTime(call.target_reached_at):"—",call.target_reached_price==null?"—":number(call.target_reached_price).toFixed(4),call.seconds_to_target==null?"—":number(call.seconds_to_target).toFixed(1),call.target_touch_type??"—",call.target_close_confirmed==null?"PENDING":call.target_close_confirmed?"YES":"NO",call.strongest_greek_at_target??call.strongest_greek_current??"—",call.weakest_greek_at_target??call.weakest_greek_current??"—",pretty(call.price_source??"unknown")].join("\t"));
    try{await navigator.clipboard.writeText([header.join("\t"),...lines].join("\n"));setCopied(true);window.setTimeout(()=>setCopied(false),1800)}catch{setCopied(false)}
  };
  return <article className="panel outcome-attribution">
    <header className="panel-head"><div><span>{system==="DELTA_DYNAMICS"?"1.25-POINT":symbol==="QQQ"?"50 NQ-POINT EQUIVALENT":"50-POINT"} OUTCOME PATHS</span><h2>{SYSTEM_OUTCOME_LABELS[system]} · one-minute observed highs and lows per call</h2></div><div className="outcome-head-actions"><button type="button" className="copy-table" onClick={copyTable} disabled={!filteredCalls.length}>{copied?"✓ COPIED":"COPY SUMMARIES"}</button><div className="outcome-source"><b>{source.replaceAll("_"," ")}</b><small>{group.tracking} tracking · {group.total} calls</small></div></div></header>
    <div className="outcome-call-finder">
      <div className="call-id-combobox"><label><span>CALL ID</span><input value={query} maxLength="19" inputMode="numeric" onFocus={()=>setPickerOpen(true)} onChange={event=>{setQuery(event.target.value.replace(/\D/g,"").slice(0,19));setSelectedId("");setLookedUpCall(null);setPickerOpen(true);setLookupError("")}} onKeyDown={event=>{if(event.key==="Enter")lookup();if(event.key==="Escape")setPickerOpen(false)}} placeholder="YYYYMMDDHHMMSSmmmss"/></label><button type="button" className="picker-toggle" onClick={()=>setPickerOpen(value=>!value)} aria-label="Show matching call IDs">⌄</button>{pickerOpen&&<div className="call-id-menu">{matchingCalls.slice(0,30).map(call=>{const parts=easternFilterParts(call.alerted_at),id=visibleCallId(call,system);return <button type="button" key={call.id} onMouseDown={event=>event.preventDefault()} onClick={()=>selectCall(call)}><b>{id}</b><span>{parts.date} · {logTime(call.alerted_at)}</span><small>{call.status} · {biasLabel(call.direction)}</small></button>})}{!matchingCalls.length&&<p>No loaded calls match these filters.</p>}</div>}</div>
      <label className="finder-filter"><span>DATE · EST</span><input type="date" value={dateFilter} onChange={event=>{setDateFilter(event.target.value);setSelectedId("");setLookedUpCall(null);setPickerOpen(true)}}/></label>
      <label className="finder-filter"><span>TIME · EST</span><input type="time" step="1" value={timeFilter} onChange={event=>{setTimeFilter(event.target.value);setSelectedId("");setLookedUpCall(null);setPickerOpen(true)}}/></label>
      <button type="button" onClick={lookup}>FIND EXACT ID</button><button type="button" onClick={()=>{setQuery("");setDateFilter("");setTimeFilter("");setSelectedId("");setLookedUpCall(null);setPickerOpen(false);setLookupError("")}}>ALL CALLS</button>{lookupError&&<small>{lookupError}</small>}
    </div>
    <div className="outcome-method"><b>Reading the path:</b> datum is fixed at the alert price. Each candle is observed OHLC for one minute. {symbol==="QQQ"?"The target is the configured QQQ equivalent of a 50-point NQ move (default 1.235 QQQ points); it is explicitly an estimate until synchronized NQ data is connected.":`The target is exactly 50 ${symbol} points.`} The path expires at the displayed Eastern deadline. Post-expiry prices never count.</div>
    <div className="fifty-point-scroll">{filteredCalls.map(call=><FiftyPointOutcomeCard key={call.id} call={call} system={system}/>)}{!filteredCalls.length&&<div className="empty-state">{normalized?"No loaded call ID matches. Enter the complete ID and select FIND to query Postgres.":data?.unavailable?"Outcome tracking is waiting for the updated Render backend. The rest of the dashboard remains live.":`No qualified ${SYSTEM_OUTCOME_LABELS[system]} decisions have started tracking yet.`}</div>}</div>
    <footer><span>Price source: {source.replaceAll("_"," ")}</span><span>Visible clocks: EST · 12-hour AM/PM format.</span><span>Calls that do not reach their displayed directional target are explicitly TRACKING or EXPIRED.</span></footer>
  </article>;
}

function AlertOutcomeRows({alert,calls=[]}){
  const alertTime=new Date(alert.timestamp).getTime();
  const call=calls.find(item=>item.symbol===alert.symbol&&item.direction===alert.direction&&Math.abs(new Date(item.alerted_at).getTime()-alertTime)<=1000);
  if(!call)return <div className="nested-outcome-empty">No linked outcome path is available for this alert. Older rows are not reconstructed from missing observations.</div>;
  return <div className="nested-outcome"><FiftyPointOutcomeCard call={call}/></div>;
}

function FiveMinuteForecast({history,state,symbol}){
  const forecast=useMemo(()=>deriveFiveMinuteForecast(history,state),[history,state]),tone=!forecast.ready||forecast.label==="WAIT"?"wait":forecast.label.toLowerCase(),probabilities=forecast.probabilities??{UP:0,DOWN:0,WAIT:1};
  return <article className={`move-forecast forecast-${tone}`}><div><span>EXPERIMENTAL 5-MINUTE / 30-POINT FORECAST</span><h2>{symbol} · {forecast.ready?forecast.label:"WAIT"}</h2><small>{forecast.reason}</small></div><div className="forecast-probabilities"><span>UP ≥ +30<b>{pct(probabilities.UP)}</b></span><span>WAIT<b>{pct(probabilities.WAIT)}</b></span><span>DOWN ≤ −30<b>{pct(probabilities.DOWN)}</b></span></div><div className="forecast-levels"><span>Current<b>{Number.isFinite(forecast.price)?forecast.price.toFixed(2):"—"}</b></span><span>Up level<b>{Number.isFinite(forecast.price)?(forecast.price+30).toFixed(2):"—"}</b></span><span>Down level<b>{Number.isFinite(forecast.price)?(forecast.price-30).toFixed(2):"—"}</b></span><small>{forecast.samples} labeled states · {forecast.eventCount} observed 30-point events{forecast.neighbors?` · ${forecast.neighbors} nearest analogs`:""}</small></div></article>;
}

function ExplosionCard({ state, history }) {
  const score = state?.explosion;
  const weights = score?.configuration?.weights ?? {};
  const drivers = Object.entries(score?.components ?? {}).map(([name,value]) => ({ name, intensity:number(value), contribution:number(value)*number(weights[name]) })).sort((a,b)=>b.contribution-a.contribution).slice(0,4);
  const threshold = number(state?.active_thresholds?.explosion_min,.58);
  return <article className="metric score-explainer"><header><span>EXPLOSION SCORE</span><span className={`badge ${number(score?.value) >= threshold && threshold ? "hot" : "subtle"}`}>{number(score?.value) >= threshold && threshold ? "ABOVE THRESHOLD" : "BUILDING"}</span></header><div className="score-summary"><b>{number(score?.value).toFixed(2)}</b><div><strong>{number(score?.value) >= .75 ? "High energy" : number(score?.value) >= .5 ? "Elevated energy" : "Low energy"}</strong><span>Threshold {threshold.toFixed(2)} · confidence {pct(score?.confidence)}</span><em className="ideal-score">IDEAL ALERT SCORE ≥ {threshold.toFixed(2)}</em></div></div><div className="score-drivers">{drivers.map(driver=><div className="score-driver" key={driver.name}><span>{pretty(driver.name)}</span><i><em style={{width:`${Math.min(100,driver.intensity*100)}%`}}/></i><b>+{driver.contribution.toFixed(2)}</b></div>)}</div><p className="score-why"><b>Why:</b> {score?.explanation ?? "Waiting for enough live bars to establish a robust rolling baseline."}</p><Sparkline values={history.map(item=>number(item.explosion?.value))}/></article>;
}

function DirectionCard({ state }) {
  const score = state?.direction;
  const sessionVotes=state?.session_analysis?.directional_votes??{},sessionWeights=state?.session_analysis?.active_alert_weights??{};
  const votes = ["gamma","vanna","charm"].map(name=>{const value=number(score?.inputs?.[name]),fallback=value>0?1:value<0?-1:0;return {name,value,vote:Number.isFinite(Number(sessionVotes[name]))?Number(sessionVotes[name]):fallback,weight:number(sessionWeights[name])};});
  const value = number(score?.value);
  const threshold=number(state?.active_thresholds?.direction_min,2);
  return <article className="metric score-explainer direction-explainer"><header><span>DIRECTION SCORE</span><span className={`badge ${value>0?"up":value<0?"down":"subtle"}`}>{value>0?"BULLISH":value<0?"BEARISH":"NEUTRAL"}</span></header><div className="score-summary"><b className={value>0?"teal":value<0?"red":""}>{value>0?"+":""}{value.toFixed(0)} / 3</b><div><strong>{Math.abs(value)>=2.8?"Fully aligned":Math.abs(value)>=2?"Strong lean":Math.abs(value)>=1?"Mixed lean":"No direction"}</strong><span>{pct(score?.confidence)} transition confidence</span><em className="ideal-score">IDEAL ALERT SCORE ≥ +{threshold.toFixed(0)} OR ≤ −{threshold.toFixed(0)}</em></div></div><div className="direction-votes">{votes.map(item=><div className={`direction-vote ${item.vote>0?"up":item.vote<0?"down":"neutral"}`} key={item.name}><span>{pretty(item.name)} · weight {pct(item.weight)}</span><b>{item.vote>0?"+1 · Bullish":item.vote<0?"−1 · Bearish":"0 · Neutral"}</b><small>{item.name==="vanna"&&item.vote===0?"IV context unavailable · direction disabled":`Raw exposure ${item.value>=0?"+":""}${item.value.toFixed(4)}`}</small></div>)}</div><p className="score-why"><b>Why:</b> {score?.explanation ?? "Waiting for Gamma, Vanna, and Charm observations."} The active session changes the Greek weights; two Greek votes and price confirmation are required.</p></article>;
}

function PageHead({ eyebrow, title, subtitle, action }) {
  return <div className="page-head module-title"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{subtitle}</p></div>{action}</div>;
}

function ModulePage({ view, state, history, alerts, performance, system, config, replay, onReplay, notify }) {
  const [query, setQuery] = useState("");
  const indicators = state?.supporting_indicators ?? {};
  const engine = system?.engine ?? {};
  if (view === "Live Monitor") return <>
    <PageHead eyebrow="STREAMING DESK" title="Live pressure monitor" subtitle="Every panel below is driven by the latest persisted market state." action={<span className={`health-banner ${engine.last_error ? "error" : ""}`}>● {engine.running ? "LIVE" : "IDLE"}</span>} />
    <div className="monitor-grid">
      <article className="panel monitor-chart"><header className="panel-head"><div><span>PRESSURE WATERFALL</span><h2>{state?.symbol ?? "—"} · {time(state?.timestamp)}</h2></div><span className="live-chip">● {engine.average_latency_ms?.toFixed?.(1) ?? "—"} ms</span></header><PriceChart history={history}/><div className="timeframe-row">{Object.entries(state?.timeframe_alignment ?? {}).map(([key, value]) => <div key={key}><span>{key}s</span><i style={{height:`${24 + Math.abs(number(value))*38}px`}}/><b>{number(value) >= 0 ? "↑" : "↓"}</b></div>)}</div></article>
      <article className="panel gauge-panel"><header className="panel-head"><div><span>DEALER HEDGE DEMAND</span><h2>Signed pressure</h2></div></header><div className="big-gauge"><div><b>{number(state?.dealer_hedging?.value).toFixed(2)}</b><span>{number(state?.dealer_hedging?.value) >= 0 ? "BUY PRESSURE" : "SELL PRESSURE"}</span></div></div><div className="signal-stack">{["gamma","charm","vanna"].map(name => <span key={name}><b>{pretty(name)}</b><i style={{width:`${Math.min(100,Math.abs(number(indicators[`greek_${name}`]))*900)}%`}}/></span>)}</div></article>
      <article className="panel feed-panel"><header className="panel-head"><div><span>SYSTEM TIMELINE</span><h2>Live engine events · 5 lines</h2></div></header>{(system?.events ?? []).slice(0,5).map((event,i) => <div className="timeline-event" key={`${event.timestamp}-${i}`}><i className={event.level === "ERROR" ? "hot-event" : ""}/><span>{logDate(event.timestamp)} · {logTime(event.timestamp)}</span><b>{event.message}</b></div>)}{!(system?.events?.length) && <div className="empty-state">No engine errors recorded.</div>}</article>
    </div></>;

  if (view === "Historical Replay") return <>
    <PageHead eyebrow="RESEARCH REPLAY" title="Historical replay" subtitle="Run real Options Pro history through the same production pipeline." action={<button className="primary-action" onClick={onReplay} disabled={replay?.status === "running"}>Run replay</button>} />
    <article className="panel replay-stage"><div className="replay-toolbar"><span>QQQ · previous market session · 09:30—16:00 ET</span><b>{replay?.status?.toUpperCase?.() ?? "READY"}</b></div><PriceChart history={history}/></article>
    <div className="metric-grid replay-metrics"><article className="metric"><header><span>BARS PROCESSED</span></header><div className="metric-main"><b>{replay?.bars ?? 0}</b></div></article><article className="metric"><header><span>ALERTS GENERATED</span></header><div className="metric-main"><b>{replay?.alerts ?? 0}</b></div></article><article className="metric"><header><span>PIPELINE LATENCY</span></header><div className="metric-main"><b>{number(replay?.average_pipeline_latency_ms).toFixed(2)} ms</b></div></article><article className="metric"><header><span>STATUS</span></header><div className="metric-main"><b className={replay?.status === "failed" ? "red" : "teal"}>{replay?.status ?? "ready"}</b></div><footer><span>{replay?.error ?? "Chronological; same decision path"}</span></footer></article></div></>;

  if (view === "Performance") {
    const regimes = Object.entries(performance?.by_regime ?? {});
    return <><PageHead eyebrow="META ENGINE" title="Performance analytics" subtitle="Counts and evaluated precision read directly from Supabase." />
      <div className="performance-grid"><article className="panel precision-card"><header className="panel-head"><div><span>EVALUATED PRECISION</span><h2>Outcome quality</h2></div></header><div className="uplift"><b>{pct(performance?.precision)}</b><span>{performance?.evaluated_alerts ?? 0} evaluated alerts</span></div><Sparkline values={history.map(x => number(x.confidence?.value))} color="#86a7ff"/></article><article className="panel confusion"><header className="panel-head"><div><span>ALERT FLOW</span><h2>Production channels</h2></div></header><div className="matrix"><div className="strong"><b>{performance?.live_alerts ?? 0}</b><span>Live</span></div><div><b>{performance?.historical_alerts ?? 0}</b><span>Replay</span></div><div><b>{performance?.pending_alerts ?? 0}</b><span>Pending</span></div><div className="strong"><b>{performance?.total_alerts ?? 0}</b><span>Total</span></div></div></article><article className="panel segment-card"><header className="panel-head"><div><span>ALERTS BY REGIME</span><h2>Market context</h2></div></header>{regimes.map(([name,count]) => <div className="segment" key={name}><span>{pretty(name)}</span><i><b style={{width:`${Math.min(100,100*count/Math.max(1,performance.total_alerts))}%`}}/></i><strong>{count}</strong></div>)}{!regimes.length && <div className="empty-state">No alerts generated yet.</div>}</article></div></>;
  }

  if (view === "Logbook") return <><PageHead eyebrow="AUDIT TRAIL" title="Options bias logbook" subtitle="Search live and replay pressure-bias events stored in Supabase · 5 visible lines." /><div className="searchbar"><span>⌕</span><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search ID, symbol, regime, reasoning, or risk…"/></div><article className="panel logbook-list five-line-log">{alerts.filter(a => JSON.stringify(a).toLowerCase().includes(query.toLowerCase())).map(a => <details key={a.id}><summary><button type="button" className="call-id" onClick={event=>{event.preventDefault();navigator.clipboard.writeText(visibleEventId(a))}}>{visibleEventId(a)}</button><span>{logDate(a.timestamp)} · {logTime(a.timestamp)}</span><b>{a.symbol}</b><span className={`direction-pill ${a.direction.toLowerCase()}`}>{biasLabel(a.direction)}</span><span>{a.regime}</span><span>Explosion {a.explosion}</span><span className="result pending">{a.result}</span><strong>{a.precision}</strong></summary><div className="reasoning-grid"><div><small>PRESSURE THESIS</small>{a.reasoning.map(reason=><p key={reason}>{reason}</p>)}</div><div><small>MANUAL CONFIRMATION</small><p>{a.recommendation}</p></div><div><small>RISK</small><p>{a.risk}</p></div></div></details>)}{!alerts.length && <div className="empty-state">No options-pressure bias has crossed every threshold.</div>}</article></>;

  if (view === "Configuration") return <><PageHead eyebrow="ACTIVE CONTROL" title={`Configuration ${config?.version ?? "—"}`} subtitle="Validated strategy currently loaded by the backend." action={<span className="health-banner">READ ONLY · DEPLOYED YAML</span>} /><div className="config-grid"><article className="panel version-list"><header className="panel-head"><div><span>PROFILES</span><h2>Session policies</h2></div></header>{Object.keys(config?.profiles ?? {}).map((name,i)=><button className={i===0?"selected":""} key={name}><b>{pretty(name)}</b><span>Active policy</span></button>)}</article><article className="panel config-editor"><header className="panel-head"><div><span>NORMAL SESSION</span><h2>Alert thresholds</h2></div></header>{Object.entries(config?.profiles?.NORMAL_SESSION ?? {}).filter(([,v])=>typeof v==="number").map(([name,value])=><label className="config-control" key={name}><span>{pretty(name)}<small>Loaded from strategy.yaml</small></span><input type="range" value={Math.min(100,number(value)*100)} readOnly/><b>{number(value).toFixed(2)}</b></label>)}</article></div></>;

  if (view === "Research Lab") return <><PageHead eyebrow="MODEL INSPECTION" title="Research lab" subtitle="Current formula weights and the latest real replay result." action={<button className="primary-action" onClick={onReplay}>Run experiment replay</button>} /><div className="research-grid"><article className="panel formula-panel"><header className="panel-head"><div><span>EXPLOSION FORMULA</span><h2>Production weights</h2></div></header><pre><code>{`energy = Σ robust_z(|greek|) × weight\nacceleration = tanh(curvature_ratio - 1)\nscore = clamp(energy + 0.08 × acceleration)`}</code></pre><div className="weight-grid">{Object.entries(config?.score_weights?.explosion ?? {}).map(([name,value])=><span key={name}>{pretty(name)} {pct(value)}</span>)}</div></article><article className="panel experiment-result"><header className="panel-head"><div><span>LATEST REPLAY</span><h2>Observed result</h2></div></header><div className="uplift"><b>{replay?.alerts ?? 0}</b><span>alerts from {replay?.bars ?? 0} bars</span></div><Sparkline values={history.map(x=>number(x.explosion?.value))}/><div className="experiment-stats"><span>Status <b>{replay?.status ?? "not run"}</b></span><span>Latency <b>{number(replay?.average_pipeline_latency_ms).toFixed(2)} ms</b></span></div></article></div></>;

  return <><PageHead eyebrow="PLATFORM OPERATIONS" title="System monitoring" subtitle="Live health from Render, Supabase, ThetaData, and the decision engine." action={<span className={`health-banner ${system?.database_connected ? "" : "error"}`}>● {system?.database_connected ? "DATABASE CONNECTED" : "DEGRADED"}</span>} /><div className="health-grid">{[["PostgreSQL",system?.database_connected?"Connected":"Down"],["Theta transport",system?.theta_transport??"—"],["Live engine",engine.running?"Running":"Idle"],["Bars processed",engine.bars_processed??0],["Alerts",engine.alerts_generated??0],["Retries",engine.retries??0]].map(([name,value])=><article className="panel health-card" key={name}><span>{name}</span><b>{value}</b><i><em style={{width:system?.database_connected?"100%":"20%"}}/></i><small>{engine.last_error && name==="Live engine"?engine.last_error:"Real backend telemetry"}</small></article>)}</div></>;
}

const UI_HOVER_LABELS={
  "GEX · RAW":"Raw gamma exposure from the reported open interest.",
  "GEX · REAL":"Forward-filled gamma exposure adjusted for inferred flow during the open-interest delay.",
  "GEX $ DENSITY":"Dollar gamma exposure concentrated within 0.5% of spot.",
  "TW GEX":"Time-weighted gamma-density persistence over the recent ten-minute window.",
  "FLOW HACK":"Inferred options flow from the change in GEX after Color and Speed effects.",
  "VOL HACK":"Inferred volume proxy derived from the flow estimate.",
  "RR · T+10":"Projected ten-minute buy-to-sell flow ratio.",
  "DR · T+10":"Projected ten-minute dealer-risk/outflow ratio.",
  "SPOOF":"GEX change relative to inferred volume; higher values indicate lower confidence.",
  "FADE":"Mean-reversion hedge-power score.",
  "AMP":"Breakout/amplification hedge-power score.",
  "FINAL · CLEAN":"Filtered final Gamma Dynamics 2.0 setup score.",
  "SL":"Stop-loss level.","TP":"Take-profit level.","LIQ":"Liquidity score: spread divided by available depth.",
  "TS":"Tracking call currently moving in the call’s favorable direction.",
  "TF":"Tracking call currently moving against the call’s direction.",
  "DIRECTION":"The signal’s expected price direction: upward/long or downward/short.",
  "CALL STATE":"Current observed outcome of the call: succeeded, failed, or still tracking.",
  "EVENT DASHBOARD":"Open the full graphical tracking card, signal context, and outcome path for this event.",
  "VIEW DASHBOARD":"Open the full graphical tracking card for this event.",
  "HIDE DASHBOARD":"Close this event's graphical tracking card.",
  "TIME · EASTERN":"Signal date and time displayed in Eastern time.",
  "ZONE":"Delta Dynamics market-time zone that qualified this call.",
  "ZONE MATCH":"Percent of Delta Dynamics zone gates satisfied at the alert.",
  "CONFIDENCE":"Delta Dynamics confidence score at the alert.",
  "STREAM DURATION":"Elapsed observed time since the call was created.",
  "HIGH CHANGE":"Favorable or adverse movement from the alert datum to the highest observed price.",
  "TIME · MS":"Event time in Eastern time, including milliseconds when available.",
  "DATE · EASTERN":"Calendar date of the signal in Eastern time.",
  "MARKET HOUR":"Trading-session bucket assigned to the alert time.",
  "SOURCE":"Instrument and live data source used for the signal.",
  "DATUM / ALERT PRICE":"Observed underlying price at the time the call was created.",
  "SESSION TARGET":"Model target price for the active session and signal direction.",
  "STRIKE / REFERENCE":"Option strike used by the model, or the nearest price reference when no strike is available.",
  "DYNAMIC / EXTREME HIGH":"Highest observed price while this call has been tracked.",
  "DYNAMIC / EXTREME LOW":"Lowest observed price while this call has been tracked.",
  "TIME TO HIGH":"Elapsed time from alert to the tracked high.",
  "TIME TO LOW":"Elapsed time from alert to the tracked low.",
  "CURRENT / FINAL":"Latest tracked price, or final price after the observation window closes.",
  "CURRENT / FINAL CHANGE":"Price change from the alert datum to the current or final observation.",
  "STRONGEST GREEK":"Greek with the strongest directional contribution at this call state.",
  "WEAKEST GREEK":"Greek with the weakest directional contribution at this call state.",
  "INTENSITY":"Model strength score at the time of the signal.",
  "PRESSURE":"Signed directional pressure produced by the model.",
  "EVENT ID":"Unique identifier for this event; click its button to copy it.",
  "COPY GREEKS":"Copy the timestamped Greek values currently visible in this graph, with raw and normalized columns.",
};
function WallIntelligenceModule({symbol}){
  const [spectrum,setSpectrum]=useState([]),[breaks,setBreaks]=useState([]),[flow,setFlow]=useState([]),[layers,setLayers]=useState(new Set(["CALL_WALL","PUT_WALL","ZERO_GAMMA","SUPPORT","RESISTANCE","DEALER_FLOW"]));
  useEffect(()=>{const controller=new AbortController();const refresh=()=>Promise.all([fetchWallSpectrum(symbol,controller.signal),fetchWallBreaks(symbol,controller.signal),fetchWallDealerFlow(symbol,controller.signal)]).then(([s,b,f])=>{setSpectrum(s.rows??[]);setBreaks(b.rows??[]);setFlow(f.rows??[])}).catch(()=>{});refresh();const id=window.setInterval(refresh,5000);return()=>{controller.abort();clearInterval(id)}},[symbol]);
  const latest=spectrum.at(-1),walls=latest?.walls??{},tiers={STRONGEST:"strongest",STRONG:"strong",NORMAL:"normal",WEAK:"weak",WEAKEST:"weakest"},toggle=layer=>setLayers(current=>{const next=new Set(current);next.has(layer)?next.delete(layer):next.add(layer);return next});
  const compact=value=>{const n=number(value);return Math.abs(n)>=1e9?`${(n/1e9).toFixed(2)}B`:Math.abs(n)>=1e6?`${(n/1e6).toFixed(1)}M`:n.toFixed(2)};
  return <article className="panel wall-intelligence"><header className="panel-head"><div><span>WALL INTELLIGENCE · MARKET STRUCTURE</span><h2>{symbol} · estimated OI × Greek walls</h2></div><b>5-SECOND OBSERVER</b></header><p className="wall-disclaimer">EST. WALL = delayed open interest × Greek. DealerFlow is a model proxy, not tape. This module does not create or change strategy calls.</p><section className="wall-spectrum">{["CALL_WALL","PUT_WALL","ZERO_GAMMA","SUPPORT","RESISTANCE"].map(kind=>{const wall=walls[kind]??{};return <article className={tiers[wall.tier]??"weakest"} key={kind} title={`Est. ${compact(wall.dollar)} · z ${number(wall.z).toFixed(2)} · TW GEX ${number(wall.tw_gex).toFixed(2)}`}><span>{pretty(kind)}</span><b>{number(wall.strike).toFixed(2)}</b><small>{wall.tier??"WAITING"} · EST. {compact(wall.dollar)}</small><i><em style={{width:`${Math.max(2,Math.min(100,number(wall.percentile))) }%`}}/></i></article>})}</section><section className="wall-chart"><header><div><span>LIVE MARKET-STRUCTURE SERIES</span><small>Time (ET) · QQQ Price ($) / DealerFlow ($)</small></div><div className="wall-layers">{["CALL_WALL","PUT_WALL","ZERO_GAMMA","SUPPORT","RESISTANCE","DEALER_FLOW","POS_INVENTORY","NEG_INVENTORY"].map(layer=><button className={layers.has(layer)?"active":""} onClick={()=>toggle(layer)} type="button" key={layer}>{pretty(layer)}</button>)}</div></header><div className="wall-chart-scroll"><table><thead><tr><th>TIME · ET</th><th>QQQ PRICE ($)</th>{layers.has("DEALER_FLOW")&&<th>DEALERFLOW ($)</th>}{layers.has("CALL_WALL")&&<th>CALL WALL</th>}{layers.has("PUT_WALL")&&<th>PUT WALL</th>}{layers.has("ZERO_GAMMA")&&<th>ZERO GAMMA</th>}{layers.has("SUPPORT")&&<th>SUPPORT</th>}{layers.has("RESISTANCE")&&<th>RESISTANCE</th>}</tr></thead><tbody>{spectrum.slice(-60).reverse().map(row=><tr key={row.timestamp}><td>{logTime(row.timestamp)}</td><td>{number(row.spot).toFixed(2)}</td>{layers.has("DEALER_FLOW")&&<td className={number(row.dealer_flow)>=0?"positive":"negative"}>{compact(row.dealer_flow)}</td>}{layers.has("CALL_WALL")&&<td>{number(row.walls?.CALL_WALL?.strike).toFixed(2)}</td>}{layers.has("PUT_WALL")&&<td>{number(row.walls?.PUT_WALL?.strike).toFixed(2)}</td>}{layers.has("ZERO_GAMMA")&&<td>{number(row.walls?.ZERO_GAMMA?.strike).toFixed(2)}</td>}{layers.has("SUPPORT")&&<td>{number(row.walls?.SUPPORT?.strike).toFixed(2)}</td>}{layers.has("RESISTANCE")&&<td>{number(row.walls?.RESISTANCE?.strike).toFixed(2)}</td>}</tr>)}</tbody></table></div></section><section className="wall-logs"><div><h3>WALL BREAK LOG</h3><div className="wall-log-scroll"><table><thead><tr><th>TIME ET</th><th>WALL</th><th>STRIKE</th><th>TIER</th><th>S AT BREAK</th><th>GEX$ WALL</th><th>BUILD</th><th>VOLUME SURGE</th><th>REGIME</th></tr></thead><tbody>{breaks.map((event,index)=><tr key={`${event.timestamp}-${index}`}><td>{logTime(event.timestamp)}</td><td>{pretty(event.wall_type)}</td><td>{number(event.strike).toFixed(2)}</td><td>{event.tier}</td><td>{number(event.spot).toFixed(2)}</td><td>{compact(event.gex_dollar)}</td><td>{number(event.build_intensity).toFixed(2)}</td><td>{number(event.volume_surge).toFixed(2)}x</td><td>{pretty(event.regime)}</td></tr>)}</tbody></table>{!breaks.length&&<p>No point-in-time wall breaks recorded yet.</p>}</div></div><div><h3>DEALERFLOW LOG</h3><div className="wall-log-scroll"><table><thead><tr><th>TIME ET</th><th>DEX</th><th>VOLHACK</th><th>DEALERFLOW</th><th>POS INV.</th><th>NEG INV.</th><th>TW GEX</th><th>SPOOF</th><th>EDGE</th></tr></thead><tbody>{flow.slice(-80).reverse().map(row=><tr key={row.timestamp}><td>{logTime(row.timestamp)}</td><td>{compact(row.dex)}</td><td>{compact(row.vol_hack)}</td><td className={number(row.dealer_flow)>=0?"positive":"negative"}>{compact(row.dealer_flow)}</td><td>{compact(row.pos_inventory)}</td><td>{compact(row.neg_inventory)}</td><td>{number(row.tw_gex).toFixed(3)}</td><td>{number(row.spoof_score).toFixed(2)}</td><td>{number(row.edge).toFixed(2)}</td></tr>)}</tbody></table></div></div></section></article>;
}

function interfaceHoverLabel(element){
  const text=(element.getAttribute("aria-label")||element.textContent||"").replace(/\s+/g," ").trim();
  if(/ @ STRIKE · RAW$/.test(text))return `${text.replace(" @ STRIKE · RAW","")} exposure at the alert strike, in its original stored units.`;
  if(/ @ STRIKE · NORM$/.test(text))return `${text.replace(" @ STRIKE · NORM","")} exposure at the alert strike, normalized against its rolling history.`;
  if(/ (HIGH|LOW)$/.test(text)&&["ZOMMA","COLOR","SPEED","GAMMA","VOMMA","ULTIMA","DELTA"].some(name=>text.startsWith(name)))return `${text.replace(/ (HIGH|LOW)$/,"")} value at the call’s observed $1 price extreme.`;
  return UI_HOVER_LABELS[text]||text;
}

export default function Home() {
  const [view,setView]=useState("Overview"), [symbol,setSymbol]=useState("QQQ"), [resolution,setResolution]=useState(5);
  const [dashboard,setDashboard]=useState({history:[],alerts:[],engine:{},performance:{}}), [system,setSystem]=useState(null), [config,setConfig]=useState(null);
  const [chartHistory,setChartHistory]=useState([]);
  const [attribution,setAttribution]=useState({systems:{}});
  const [apiConnected,setApiConnected]=useState(false), [toast,setToast]=useState(""), [replay,setReplay]=useState(null);
  const [instruments,setInstruments]=useState(FALLBACK_INSTRUMENTS);
  const [activeSection,setActiveSection]=useState("decision"),[clock,setClock]=useState(Date.now());
  const [moduleOrder,setModuleOrder]=useState(()=>{try{const saved=JSON.parse(window.localStorage.getItem("axiom-overview-module-order")??"null");return Array.isArray(saved)&&saved.length===DEFAULT_MODULE_ORDER.length&&DEFAULT_MODULE_ORDER.every(id=>saved.includes(id))?saved:DEFAULT_MODULE_ORDER}catch{return DEFAULT_MODULE_ORDER}}),[draggedModule,setDraggedModule]=useState(null),[dragOverModule,setDragOverModule]=useState(null);
  useEffect(()=>{const tooltip=document.createElement("div");tooltip.className="interface-hover-tooltip";tooltip.setAttribute("role","tooltip");document.body.append(tooltip);let active=null;const targetFor=element=>element instanceof Element?element.closest("th,button"):null;const position=event=>{tooltip.style.left=`${Math.min(window.innerWidth-24,event.clientX+14)}px`;tooltip.style.top=`${Math.min(window.innerHeight-24,event.clientY+16)}px`};const show=event=>{const target=targetFor(event.target);if(!target)return;active=target;tooltip.textContent=interfaceHoverLabel(target);position(event);tooltip.dataset.visible="true"};const move=event=>{if(active)position(event)};const hide=event=>{const next=targetFor(event.relatedTarget);if(next===active)return;active=null;tooltip.dataset.visible="false"};document.addEventListener("pointerover",show);document.addEventListener("pointermove",move);document.addEventListener("pointerout",hide);return()=>{document.removeEventListener("pointerover",show);document.removeEventListener("pointermove",move);document.removeEventListener("pointerout",hide);tooltip.remove()}},[]);
  const state=dashboard.state, history=dashboard.history??[], alerts=dashboard.alerts??[], engine=dashboard.engine??{}, performance=dashboard.performance??{};
  const notify=text=>{setToast(text);window.setTimeout(()=>setToast(""),2600)};
  const refresh=async(signal)=>{const [dash,sys]=await Promise.allSettled([fetchDashboard(symbol,signal),fetchSystem(signal)]);if(signal.aborted)return;setApiConnected(sys.status==="fulfilled");if(dash.status==="fulfilled"){setDashboard(dash.value);setChartHistory(current=>[...new Map([...current,...(dash.value.history??[])].map(row=>[row.timestamp,row])).values()].sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp)).slice(-5000))}if(sys.status==="fulfilled")setSystem(sys.value)};
  useEffect(()=>{const controller=new AbortController();refresh(controller.signal);const id=window.setInterval(()=>refresh(controller.signal),5000);return()=>{controller.abort();clearInterval(id)}},[symbol]);
  useEffect(()=>{const controller=new AbortController();fetchConfiguration(controller.signal).then(setConfig).catch(()=>{});return()=>controller.abort()},[]);
  useEffect(()=>{const controller=new AbortController();const refreshOutcomes=()=>fetchOutcomeAttribution(symbol,controller.signal).then(setAttribution).catch(error=>{if(error.name!=="AbortError")setAttribution({symbol,systems:{},unavailable:true,error:error.message})});refreshOutcomes();const id=window.setInterval(refreshOutcomes,30000);return()=>{controller.abort();clearInterval(id)}},[symbol]);
  useEffect(()=>{const controller=new AbortController();fetchDynamicsHistory(symbol,controller.signal).then(result=>setChartHistory(result.rows??[])).catch(error=>{if(error.name!=="AbortError")setChartHistory([])});return()=>controller.abort()},[symbol]);
  useEffect(()=>{const controller=new AbortController();fetchInstruments(controller.signal).then(setInstruments).catch(()=>{});return()=>controller.abort()},[]);
  useEffect(()=>{const id=window.setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(id)},[]);
  const orderedOverviewSections=[...OVERVIEW_SECTIONS.slice(0,2),...moduleOrder.map(id=>[OVERVIEW_LABELS[id],id])];
  useEffect(()=>{if(view!=="Overview")return;const sections=orderedOverviewSections.map(([,id])=>document.getElementById(id)).filter(Boolean);const observer=new IntersectionObserver(entries=>{const visible=entries.filter(entry=>entry.isIntersecting).sort((a,b)=>b.intersectionRatio-a.intersectionRatio)[0];if(visible)setActiveSection(visible.target.id)},{rootMargin:"-18% 0px -68% 0px",threshold:[0,.2,.5,.8]});sections.forEach(section=>observer.observe(section));return()=>observer.disconnect()},[view,moduleOrder]);
  useEffect(()=>{window.localStorage.setItem("axiom-overview-module-order",JSON.stringify(moduleOrder))},[moduleOrder]);
  useEffect(()=>subscribeToEvents(message=>{if(message.topic==="market_state"){setDashboard(current=>({...current,state:message.payload,history:[...(current.history??[]),message.payload].slice(-120)}));setChartHistory(current=>[...current.filter(row=>row.timestamp!==message.payload.timestamp),message.payload].slice(-5000))}if(message.topic==="alert")setDashboard(current=>({...current,alerts:[toDashboardAlert(message.payload),...(current.alerts??[])].slice(0,100)}));if(message.topic==="outcome")setDashboard(current=>({...current,alerts:(current.alerts??[]).map(alert=>alert.id===message.payload.alert_id?{...alert,result:number(message.payload.precision)>=.7?"SUCCESS":"FAILURE",precision:number(message.payload.precision).toFixed(2)}:alert)}));if(message.topic==="engine_status"){setDashboard(current=>({...current,engine:message.payload}));setSystem(current=>current?{...current,engine:message.payload}:current)}if(message.topic==="system_event")setSystem(current=>current?{...current,events:[message.payload,...(current.events??[])].slice(0,25)}:current);if(message.topic==="replay_status")setReplay(message.payload)},()=>{}),[]);
  useEffect(()=>{if(!replay?.id||replay.status!=="running")return;const id=setInterval(()=>fetchReplay(replay.id).then(setReplay).catch(()=>{}),2000);return()=>clearInterval(id)},[replay?.id,replay?.status]);
  const runReplay=async()=>{try{const day=new Date();day.setDate(day.getDate()-1);while(day.getDay()===0||day.getDay()===6)day.setDate(day.getDate()-1);const date=day.toISOString().slice(0,10);setReplay(await startReplay({symbol,start:new Date(`${date}T09:30:00`).toISOString(),end:new Date(`${date}T16:00:00`).toISOString(),bar_resolution_seconds:60,replay_speed:0}));notify("Historical replay started")}catch(error){notify(error.message)}};
  const indicators=state?.supporting_indicators??{}, visualHistory=chartHistory.length?chartHistory:history;
  const liveBiasAlerts=alerts.filter(alert=>alert.channel==="LIVE");
  const primaryOutcomeCalls=attribution?.systems?.PRIMARY_OPTIONS?.calls??[];
  const lastQualifiedAlert=liveBiasAlerts.filter(alert=>alert.symbol===symbol).sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp))[0]??null;
  const selectedInstrument=instruments.find(item=>item.symbol===symbol)??FALLBACK_INSTRUMENTS.find(item=>item.symbol===symbol);
  const optionsDecision=deriveOptionsDecision(state);
  const stateTime=state?.timestamp?new Date(state.timestamp).getTime():NaN,stateAge=Number.isFinite(stateTime)?Math.max(0,Math.round((clock-stateTime)/1000)):null;
  const freshnessLimit=Math.max(12,Math.ceil(resolution*2.5));
  const dataFresh=engine.running&&stateAge!==null&&stateAge<=freshnessLimit,dataDelayed=engine.running&&!dataFresh;
  const focusDecision=!engine.running?{...optionsDecision,qualified:false,direction:"NEUTRAL",lifecycle:"IDLE"}:
    dataDelayed?{...optionsDecision,qualified:false,direction:"NEUTRAL",lifecycle:"STALE"}:optionsDecision;
  const focusTone=focusDecision.qualified?(focusDecision.direction==="UP"?"long":"short"):"neutral";
  const jumpTo=section=>{setActiveSection(section);setView("Overview");window.requestAnimationFrame(()=>window.requestAnimationFrame(()=>{const target=document.getElementById(section);if(target?.tagName==="DETAILS")target.open=true;target?.scrollIntoView({behavior:"smooth",block:"start"})}))};
  const setAllSections=open=>{document.querySelectorAll(".overview-disclosure").forEach(section=>{section.open=open});notify(open?"All sections expanded":"All sections collapsed")};
  const startModuleDrag=(event,id)=>{setDraggedModule(id);setDragOverModule({id,position:"before"});event.dataTransfer.effectAllowed="move";event.dataTransfer.setData("text/plain",id)};
  const overModule=(event,id)=>{event.preventDefault();event.dataTransfer.dropEffect="move";const rect=event.currentTarget.getBoundingClientRect(),position=event.clientY<rect.top+rect.height/2?"before":"after";setDragOverModule({id,position})};
  const dropModule=(event,target)=>{event.preventDefault();const source=draggedModule??event.dataTransfer.getData("text/plain"),position=dragOverModule?.id===target?dragOverModule.position:"before";if(source&&source!==target)setModuleOrder(current=>{const next=current.filter(id=>id!==source),targetIndex=next.indexOf(target),insertAt=Math.max(0,targetIndex+(position==="after"?1:0));next.splice(insertAt,0,source);return next});setDraggedModule(null);setDragOverModule(null)};
  const endModuleDrag=()=>{setDraggedModule(null);setDragOverModule(null)};
  const draggableProps={dragged:draggedModule,dragOver:dragOverModule,onDragStart:startModuleDrag,onDragOver:overModule,onDrop:dropModule,onDragEnd:endModuleDrag};
  return <main className={`workspace focus-${focusTone}`}><header className="topbar"><div className="brand"><div className="brandmark"><span/><span/><span/></div><div><b>AXIOM</b><small>PRESSURE INTELLIGENCE</small></div></div><nav className="mode-switch" aria-label="Engine mode"><button className={view!=="Historical Replay"?"active":""} onClick={()=>setView("Overview")}>Live engine</button><button className={view==="Historical Replay"?"active":""} onClick={()=>setView("Historical Replay")}>Training replay</button></nav><label className="section-jump"><span>Section</span><select value={activeSection} onChange={event=>jumpTo(event.target.value)}>{orderedOverviewSections.map(([label,id])=><option value={id} key={id}>{OVERVIEW_NUMBERS[id]} · {label}</option>)}</select></label><div className="header-actions status-cluster" aria-live="polite"><span className="status-chip is-idle">AUTO STREAM <b>7 AM–6 PM ET</b></span><span className={`status-chip ${apiConnected?"is-good":"is-bad"}`}>API <b>{apiConnected?"ONLINE":"OFFLINE"}</b></span><span className={`status-chip ${engine.running?"is-good":"is-idle"}`}>ENGINE <b>{engine.running?"ON":"IDLE"}</b></span><span className={`status-chip ${dataFresh?"is-good":dataDelayed?"is-bad":"is-idle"}`}>DATA <b>{dataFresh?`${stateAge}s`:dataDelayed?"STALE":"IDLE"}</b></span></div></header>
    <aside className="sidebar"><div className="side-top"><div className="nav-context"><span>WORKSPACE</span><b>Live Overview</b><small>Decision → models → evidence</small></div><div className="nav-section-label"><span>NAVIGATION</span><b>{orderedOverviewSections.length} SECTIONS</b></div><nav className="overview-subnav" aria-label="Overview sections">{orderedOverviewSections.map(([label,section],index)=><button className={activeSection===section?"active":""} aria-current={activeSection===section?"location":undefined} key={section} onClick={()=>jumpTo(section)}><b>{String(index+1).padStart(2,"0")}</b><span><strong>{label}</strong><small>{OVERVIEW_CATEGORIES[section]}</small></span></button>)}</nav><div className="layout-actions"><button type="button" onClick={()=>setAllSections(true)}>Expand all</button><button type="button" onClick={()=>setAllSections(false)}>Collapse all</button></div><button type="button" className="reset-layout" onClick={()=>{setModuleOrder(DEFAULT_MODULE_ORDER);notify("Overview order reset")}}>↺ Reset section order</button></div><div className="side-bottom"><div className={`system-health ${system?.database_connected?"is-good":"is-bad"}`}><span><i/>{system?.database_connected?"System healthy":"System degraded"}</span><small>v{config?.version??"—"} · Render</small></div></div></aside>
    <section className="content">{view!=="Overview"?<ModulePage {...{view,state,history,alerts,performance,system,config,replay,onReplay:runReplay,notify}}/>:<><div id="overview-top" className="page-head overview-command overview-section"><div><div className="eyebrow">LIVE TRADING COMMAND</div><h1>Pressure intelligence</h1><p>Options-derived directional pressure with independent price confirmation.</p></div><div className="controls"><label>Instrument<select value={symbol} disabled={engine.running} onChange={e=>setSymbol(e.target.value)}>{instruments.map(item=><option value={item.symbol} key={item.symbol}>{item.symbol}</option>)}</select><small className={selectedInstrument?.available?"provider-ready":"provider-missing"}>{selectedInstrument?.provider}{selectedInstrument?.requirement?` · ${selectedInstrument.requirement}`:""}</small></label><label>Update interval<select value={resolution} onChange={e=>setResolution(Number(e.target.value))}><option value="5">5 seconds</option><option value="15">15 seconds</option><option value="60">1 minute</option></select></label></div></div>
    <SystemScorecard attribution={attribution} state={state} symbol={symbol}/>
    <OverviewSectionHeading number="02" title="One-screen focus" description="The complete options-pressure decision and every active gate in one view."/>
    <FocusView state={state} symbol={symbol} engine={engine} decision={focusDecision} lastQualifiedAlert={lastQualifiedAlert} clock={clock} attribution={attribution} history={visualHistory}/>
    <div className="reorderable-overview" aria-label="Draggable Overview modules">
    <DraggableOverviewModule id="wall-intelligence" index={moduleOrder.indexOf("wall-intelligence")} {...draggableProps}><OverviewDisclosure id="wall-intelligence" title="Wall Intelligence · Market Structure" description="Independent estimated OI × Greek wall spectrum and DealerFlow observer"><WallIntelligenceModule symbol={symbol}/></OverviewDisclosure></DraggableOverviewModule>
    <DraggableOverviewModule id="gamma-dynamics" index={moduleOrder.indexOf("gamma-dynamics")} {...draggableProps}><OverviewDisclosure id="gamma-dynamics" title="Gamma Dynamics 1.0 · Four-Greek Engine" description="Zomma · Color · Speed · Gamma" summaryScore={<DynamicsScoreSummary calls={attribution?.systems?.GAMMA_DYNAMICS?.calls??[]}/>}> <GammaDynamicsModule state={state} history={visualHistory} symbol={symbol} engine={engine} version={1}/><article className="panel chart-panel triad-history-panel"><GammaDynamicsChart history={visualHistory} state={state} symbol={symbol} gammaVersion={1}/></article><GammaDynamicsLog history={visualHistory} state={state} symbol={symbol} calls={attribution?.systems?.GAMMA_DYNAMICS?.calls??[]} version={1}/><OutcomeAttributionMini system="GAMMA_DYNAMICS" data={attribution} symbol={symbol}/></OverviewDisclosure></DraggableOverviewModule>
    <DraggableOverviewModule id="gamma-dynamics-v2" index={moduleOrder.indexOf("gamma-dynamics-v2")} {...draggableProps}><OverviewDisclosure id="gamma-dynamics-v2" title="Gamma Dynamics 2.0 · Six-Greek Engine" description="Zomma · Color · Speed · Gamma · Vomma · Ultima" summaryScore={<DynamicsScoreSummary calls={attribution?.systems?.GAMMA_DYNAMICS_V2?.calls??[]}/>}> <GammaDynamicsModule state={state} history={visualHistory} symbol={symbol} engine={engine} version={2}/><article className="panel chart-panel triad-history-panel"><GammaDynamicsChart history={visualHistory} state={state} symbol={symbol} gammaVersion={2}/></article><GammaDynamicsV2FlowLog history={visualHistory} state={state} symbol={symbol}/><GammaDynamicsLog history={visualHistory} state={state} symbol={symbol} calls={attribution?.systems?.GAMMA_DYNAMICS_V2?.calls??[]} version={2}/><OutcomeAttributionMini system="GAMMA_DYNAMICS_V2" data={attribution} symbol={symbol}/></OverviewDisclosure></DraggableOverviewModule>
    <DraggableOverviewModule id="six-greek-dynamics" index={moduleOrder.indexOf("six-greek-dynamics")} {...draggableProps}><OverviewDisclosure id="six-greek-dynamics" title="Delta Dynamics" description="Normalized Ultima · Zomma · Gamma · Speed · Color · Delta zone formulas" summaryScore={<DynamicsScoreSummary calls={attribution?.systems?.DELTA_DYNAMICS?.calls??[]}/>}> <SixGreekDynamicsModule state={state} history={visualHistory} symbol={symbol} engine={engine}/><article className="panel chart-panel triad-history-panel"><GammaDynamicsChart history={visualHistory} state={state} symbol={symbol} deltaMode/></article><DeltaDynamicsEventLog history={visualHistory} state={state} symbol={symbol} calls={attribution?.systems?.DELTA_DYNAMICS?.calls??[]}/><OutcomeAttributionMini system="DELTA_DYNAMICS" data={attribution} symbol={symbol}/></OverviewDisclosure></DraggableOverviewModule>
    <DraggableOverviewModule id="forecast" index={moduleOrder.indexOf("forecast")} {...draggableProps}><OverviewDisclosure id="forecast" title="Experimental Forecast" description="Research-only 5-minute / 30-point probability model"><FiveMinuteForecast history={visualHistory} state={state} symbol={symbol}/></OverviewDisclosure></DraggableOverviewModule>
    <DraggableOverviewModule id="score-modules" index={moduleOrder.indexOf("score-modules")} {...draggableProps}><OverviewDisclosure id="score-modules" title="Signal Scores" description="Explosion, Direction, Pressure, and score histories"><div className="metric-grid live-metric-grid score-three"><ExplosionCard state={state} history={history}/><DirectionCard state={state}/><article className={`metric pressure-card ${number(state?.pressure?.value)>0.15?"pressure-buy":number(state?.pressure?.value)<-0.15?"pressure-sell":"pressure-watch"}`}><header><span>PRESSURE STATE</span><span className="pressure-live-badge">● {engine.running?"LIVE":"IDLE"}</span></header><div className="pressure-state"><i/><div><b>{number(state?.pressure?.value)>0.15?"BUY PRESSURE":number(state?.pressure?.value)<-0.15?"SELL PRESSURE":"BUILDING"}</b><span>{state?.pressure?.explanation??"Waiting for ThetaData"}</span></div></div><div className="pressure-confirmations"><span className={optionsDecision.checks.pressure_alignment?"confirmed":"waiting"}>Bias {optionsDecision.checks.pressure_alignment?"aligned":"waiting"}</span><span className={optionsDecision.checks.risk?"confirmed":"blocked"}>Risk {optionsDecision.checks.risk?"clear":"blocked"}</span></div><footer><span>Signed pressure</span><b>{number(state?.pressure?.value).toFixed(2)}</b></footer></article></div><div className="score-history-grid"><article className="panel chart-panel"><ScoreTimeChart history={visualHistory} state={state} symbol={symbol} metric="explosion"/></article><article className="panel chart-panel"><ScoreTimeChart history={visualHistory} state={state} symbol={symbol} metric="direction"/></article></div><OutcomeAttributionMini system="PRIMARY_OPTIONS" data={attribution} symbol={symbol}/></OverviewDisclosure></DraggableOverviewModule>
    <DraggableOverviewModule id="greek-orders" index={moduleOrder.indexOf("greek-orders")} {...draggableProps}><OverviewDisclosure id="greek-orders" title="Greek Orders" description="First-, second-, and third-order streamed exposures"><article className="panel chart-panel"><GreekOrderChart history={visualHistory} state={state} symbol={symbol}/></article></OverviewDisclosure></DraggableOverviewModule>
    <DraggableOverviewModule id="custom-greeks" index={moduleOrder.indexOf("custom-greeks")} {...draggableProps}><OverviewDisclosure id="custom-greeks" title="Custom Greek Graphs" description="Up to ten configurable live charts"><CustomGreekWorkspace history={visualHistory} state={state} symbol={symbol}/></OverviewDisclosure></DraggableOverviewModule>
    <DraggableOverviewModule id="live-alerts" index={moduleOrder.indexOf("live-alerts")} {...draggableProps}><OverviewDisclosure id="live-alerts" title="Live Options Pro Bias Alerts" description="Qualified primary-engine decisions"><article className="panel alerts-panel"><header className="panel-head table-head"><div><span>LIVE OPTIONS PRO BIAS ALERTS</span><h2>Every call displays its observed one-minute high/low path from datum to the displayed directional target</h2></div></header><div className="table-wrap"><table><thead><tr><th>ALERT ID</th><th>DATE · EASTERN</th><th>TIME · MS</th><th>INSTRUMENT</th><th>PRICE</th><th>BIAS</th><th>EXPLOSION</th><th>DIR. SCORE</th><th>PRESSURE</th><th>OPTIONS CONF.</th><th>SESSION</th><th>REGIME</th><th>RISK</th></tr></thead><tbody>{liveBiasAlerts.map(a=>{const alertId=visibleEventId(a);return <Fragment key={a.id}><tr className="alert-primary-row"><td><button type="button" className="call-id" onClick={()=>navigator.clipboard.writeText(alertId)} title="Copy alert ID">{alertId}</button></td><td>{logDate(a.timestamp)}</td><td>{logTime(a.timestamp)}</td><td><b>{a.symbol}</b></td><td>{Number.isFinite(a.rawPrice)?a.rawPrice.toFixed(4):a.price}</td><td><span className={`direction-pill ${a.direction.toLowerCase()}`}>{biasLabel(a.direction)}</span></td><td>{a.explosion}</td><td>{a.score}</td><td>{a.pressure>0?"+":""}{number(a.pressure).toFixed(2)}</td><td>{pct(a.confidence)}</td><td>{pretty(a.session)}<small>{pretty(a.sessionState)} · {a.sessionConfidence.toFixed(0)}%</small></td><td>{a.regime}</td><td>{pretty(a.risk)}</td></tr><tr className="alert-outcome-row"><td colSpan="13"><details open><summary><span>↳ OBSERVED NQ-EQUIVALENT OUTCOME</span><b>1-MINUTE HIGH / LOW · PRICE VS EASTERN TIME</b></summary><AlertOutcomeRows alert={a} calls={primaryOutcomeCalls}/></details></td></tr></Fragment>})}</tbody></table>{!liveBiasAlerts.length&&<div className="empty-state">WAIT · no confirmed Options Pro episode has completed its entry sequence yet.</div>}</div></article></OverviewDisclosure></DraggableOverviewModule>
    </div></>}
    <footer className="disclaimer">Signal intelligence only · No broker execution enabled <span>Last persisted state {time(state?.timestamp)}</span></footer></section>{toast&&<div className="toast">✓ {toast}</div>}</main>;
}
