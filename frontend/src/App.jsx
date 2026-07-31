import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchChart, fetchConfiguration, fetchDashboard, fetchInstruments, fetchOutcomeAttribution, fetchOutcomeCall, fetchReplay, fetchStateHistory, fetchSystem, startLiveEngine,
  startReplay, stopLiveEngine, subscribeToEvents, toDashboardAlert,
} from "./api";

const OVERVIEW_SECTIONS = [
  ["One-screen focus", "decision"], ["Gamma dynamics", "gamma-dynamics"], ["Delta dynamics", "six-greek-dynamics"], ["Experimental forecast", "forecast"], ["Signal scores", "score-modules"], ["Greek orders", "greek-orders"],
  ["Custom Greek graphs", "custom-greeks"], ["Live alerts", "live-alerts"],
];
const DEFAULT_MODULE_ORDER=["gamma-dynamics","six-greek-dynamics","forecast","score-modules","greek-orders","custom-greeks","live-alerts"];
const OVERVIEW_LABELS=Object.fromEntries(OVERVIEW_SECTIONS.map(([label,id])=>[id,label]));
const OVERVIEW_NUMBERS=Object.fromEntries(OVERVIEW_SECTIONS.map(([,id],index)=>[id,String(index+1).padStart(2,"0")]));
const OVERVIEW_CATEGORIES={
  decision:"DECISION",
  "gamma-dynamics":"SIGNAL MODEL",
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
const easternTimeFormatter=new Intl.DateTimeFormat("en-US",{timeZone:EASTERN_TZ,hour12:true,hour:"2-digit",minute:"2-digit",second:"2-digit",fractionalSecondDigits:3,timeZoneName:"short"});
const easternIdFormatter=new Intl.DateTimeFormat("en-US",{timeZone:EASTERN_TZ,hourCycle:"h23",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"});
const time = value => value&&!Number.isNaN(new Date(value).getTime())?new Date(value).toLocaleTimeString("en-US",{timeZone:EASTERN_TZ,hour12:true,hour:"2-digit",minute:"2-digit",second:"2-digit"}):"—";
const logDate = value => {const date=new Date(value);return Number.isNaN(date.getTime())?"—":easternDateFormatter.format(date)};
const logTime = value => {const date=new Date(value);return Number.isNaN(date.getTime())?"—":easternTimeFormatter.format(date)};
const chartTime = value => value&&!Number.isNaN(new Date(value).getTime())?new Date(value).toLocaleTimeString("en-US",{timeZone:EASTERN_TZ,hour12:true,hour:"2-digit",minute:"2-digit",second:"2-digit"}):"—";
const easternMarketPhase=value=>{
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:EASTERN_TZ,weekday:"short",hourCycle:"h23",hour:"2-digit",minute:"2-digit"}).formatToParts(new Date(value)).filter(part=>part.type!=="literal").map(part=>[part.type,part.value]));
  if(["Sat","Sun"].includes(parts.weekday))return "WEEKEND_CLOSED";
  const minute=Number(parts.hour)*60+Number(parts.minute);
  if(minute>=240&&minute<570)return "PREMARKET";
  if(minute>960&&minute<1200)return "AFTER_HOURS";
  return minute>=570&&minute<=960?"RTH":"CLOSED";
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

function deriveGammaDynamics(state,history=[]){
  if(state?.gamma_dynamics)return {...state.gamma_dynamics,available:true};
  const inputs=Object.fromEntries(["zomma","speed","color","gamma"].map(name=>[name,greekValue(state,name)])),available=Object.values(inputs).every(Number.isFinite);
  if(!available)return {available:false,qualified:false,decision:"NEUTRAL",intensity:0,pressure:0,history_points:history.length,inputs,percentiles:{},explanation:"Waiting for Zomma, Speed, Color, and Gamma."};
  const rows=history.filter(row=>row?.timestamp).slice(-100),percentile=(name,value)=>{const values=rows.map(row=>Math.abs(greekValue(row,name))).filter(Number.isFinite);if(!values.length)return 0;const target=Math.abs(value),below=values.filter(item=>item<target).length,equal=values.filter(item=>item===target).length;return Math.min(1,(below+.5*equal)/values.length)};
  const percentiles=Object.fromEntries(Object.entries(inputs).map(([name,value])=>[name,percentile(name,value)])),intensity=(percentiles.zomma+percentiles.color)/2,gammaActive=Math.abs(inputs.gamma)>1e-12,alignedUp=inputs.speed>1e-12&&gammaActive,alignedDown=inputs.speed< -1e-12&&gammaActive,pressureMagnitude=(percentiles.speed+percentiles.gamma)/2,warmed=rows.length>=20,qualified=warmed&&intensity>=.65&&(alignedUp||alignedDown),decision=qualified?(alignedUp?"UP":"DOWN"):"NEUTRAL";
  return {available:true,qualified,decision,intensity,pressure:alignedUp?pressureMagnitude:alignedDown?-pressureMagnitude:0,history_points:rows.length,intensity_threshold:.65,inputs,percentiles,explanation:!warmed?`Building a relative baseline: ${rows.length}/20 observations.`:!(alignedUp||alignedDown)?"Gamma or Speed is effectively zero, so signed curvature pressure is not confirmed.":intensity<.65?"Speed has direction, but Zomma/Color intensity is below its rolling threshold.":`Speed indicates ${alignedUp?"upward":"downward"} curvature change while active Gamma supplies the curvature base.`};
}

function deriveGammaDynamicsEvents(history,state,symbol){
  const rows=[...history];if(state?.timestamp&&!rows.some(row=>row.timestamp===state.timestamp))rows.push(state);rows.sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
  const events=[];let prior="NEUTRAL",window=[];rows.forEach(row=>{window=[...window,row].slice(-100);const result=deriveGammaDynamics(row,window),decision=result.qualified?result.decision:"NEUTRAL";if(decision!=="NEUTRAL"&&decision!==prior)events.push({id:numericEventId(row.timestamp,3),timestamp:row.timestamp,symbol:row.symbol??symbol,price:number(row?.supporting_indicators?.price,NaN),decision,intensity:result.intensity,pressure:result.pressure,...result.inputs});prior=decision});return events.reverse();
}

const SIX_GREEKS=["ultima","zomma","gamma","speed","color","delta"];
const referenceStrike=(record,datum=NaN)=>{
  const direct=optionalNumber(record?.strike_price??record?.strike??record?.option_strike??record?.supporting_indicators?.strike_price??record?.supporting_indicators?.strike);
  return Number.isFinite(direct)?{value:direct,estimated:false}:Number.isFinite(Number(datum))?{value:Math.round(Number(datum)),estimated:true}:{value:NaN,estimated:true};
};
const reachFromDatum=(datum,direction)=>Number.isFinite(Number(datum))?Number(datum)+(direction==="UP"?1.25:-1.25):NaN;
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
  const events=[];let prior="NO_ZONE",window=[];rows.forEach(row=>{const result=deriveSixGreekDynamics(row,window),decision=result.qualified?result.decision:"NEUTRAL";if(result.qualified&&result.zone!==prior){const datum=number(row?.supporting_indicators?.price,NaN),strike=referenceStrike(row,datum);events.push({id:numericEventId(row.timestamp,4),timestamp:row.timestamp,symbol:row.symbol??symbol,datum,strike,reach:reachFromDatum(datum,decision),decision,zone:result.zone,score:result.score,confidence:result.confidence,session:result.session,scaled:result.scaled,...result.inputs})}prior=result.qualified?result.zone:"NO_ZONE";window=[...window,row].slice(-100)});return events.reverse();
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

function OverviewDisclosure({id,title,description,children,defaultOpen=false}){
  const storageKey=`axiom-section-open-${id}`;
  const [open,setOpen]=useState(()=>{try{const saved=window.localStorage.getItem(storageKey);return saved===null?defaultOpen:saved==="true"}catch{return defaultOpen}});
  const toggle=event=>{const next=event.currentTarget.open;setOpen(next);try{window.localStorage.setItem(storageKey,String(next))}catch{}};
  return <details id={id} className="overview-disclosure overview-section" open={open} onToggle={toggle}><summary><div><span className="section-index" aria-hidden="true">◆</span><div><small className="section-category">{OVERVIEW_CATEGORIES[id]}</small><b>{title}</b><small>{description}</small></div></div><em>{open?"−  COLLAPSE":"+  OPEN"}</em></summary><div className="overview-disclosure-body">{children}</div></details>;
}

function DraggableOverviewModule({id,index,dragged,dragOver,onDragStart,onDragOver,onDrop,onDragEnd,children}){
  const target=dragOver?.id===id&&dragged!==id;
  return <div className={`draggable-overview-module ${dragged===id?"is-dragging":""} ${target?`is-drag-over drop-${dragOver.position}`:""}`} data-module-id={id} style={{order:index}}>
    <button type="button" className="module-drag-handle" draggable="true" onDragStart={event=>onDragStart(event,id)} onDragEnd={onDragEnd} aria-label={`Drag ${OVERVIEW_LABELS[id]} section to reorder`} title="Drag with your cursor to reorder this section"><span>⠿</span><b>REORDER</b><small>Position {index+2}</small></button>
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

function FocusView({state,symbol,engine,decision,lastQualifiedAlert,clock}) {
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

function GammaDynamicsModule({state,history,symbol,engine}){
  const quartet=deriveGammaDynamics(state,history),tone=!quartet.qualified?"wait":quartet.decision==="UP"?"long":"short",label=quartet.qualified?(quartet.decision==="UP"?"UPWARD PRESSURE":"DOWNWARD PRESSURE"):"WAIT";
  const metadata={zomma:["VOLATILITY INTENSITY","Gamma sensitivity to implied volatility"],color:["TIME INTENSITY","Gamma sensitivity to time"],speed:["SPOT PRESSURE","Gamma sensitivity to spot"],gamma:["CURVATURE BASE","Delta sensitivity to spot"]};
  const aligned=Math.abs(number(quartet.inputs?.speed))>1e-12&&Math.abs(number(quartet.inputs?.gamma))>1e-12,warmed=number(quartet.history_points)>=20,intensityPassed=number(quartet.intensity)>=number(quartet.intensity_threshold,.65);
  const ideals={zomma:"IDEAL: combines with Color for intensity >= 65th pct",color:"IDEAL: combines with Zomma for intensity >= 65th pct",speed:"IDEAL: positive = upward, negative = downward",gamma:"IDEAL: non-zero curvature base; magnitude strengthens pressure"};
  return <section className={`gamma-dynamics gamma-dynamics-${tone}`} aria-live="polite"><header><div><span>GAMMA DYNAMICS QUARTET</span><h2>{symbol} · {label}</h2><small>{engine.running?"● LIVE OPTIONS PRO":"○ ENGINE IDLE"} · relative to the latest {quartet.history_points??0} observations</small></div><div className="gamma-dynamics-score"><span>DYNAMICS INTENSITY</span><b>{pct(quartet.intensity)}</b><small>Ideal ≥ {pct(quartet.intensity_threshold??.65)}</small></div><div className="gamma-dynamics-score pressure"><span>CURVATURE PRESSURE</span><b>{number(quartet.pressure)>0?"+":""}{number(quartet.pressure).toFixed(2)}</b><small>Direction: Speed · Base: Gamma magnitude</small></div></header><div className="gamma-dynamics-ideals"><span className={intensityPassed?"passed":"waiting"}><b>{intensityPassed?"PASS":"WAIT"}</b> Intensity ≥ {pct(quartet.intensity_threshold??.65)}</span><span className={aligned?"passed":"waiting"}><b>{aligned?"PASS":"WAIT"}</b> Speed directional + Gamma active</span><span className={warmed?"passed":"waiting"}><b>{warmed?"PASS":"WAIT"}</b> Baseline ≥ 20 observations</span></div><div className="gamma-dynamics-grid">{["zomma","color","speed","gamma"].map(name=>{const value=quartet.inputs?.[name],rank=quartet.percentiles?.[name]??0;return <article key={name}><div><span>{name.toUpperCase()}</span><small>{metadata[name][0]}</small></div><b>{signedGreek(value)}</b><i><em style={{width:`${Math.max(2,rank*100)}%`}}/></i><p>{metadata[name][1]} · relative magnitude {pct(rank)}</p><strong>{ideals[name]}</strong></article>})}</div><footer><b>Interpretation:</b> {quartet.explanation}<small>Native contract Gamma is normally non-negative, so its magnitude is treated as the curvature base; Speed supplies the up/down state. This remains a research heuristic, not dealer inventory.</small></footer></section>;
}

function SixGreekDynamicsModule({state,history,symbol,engine}){
  const model=deriveSixGreekDynamics(state,history),direction=model.qualified?model.decision:"WAIT",tone=direction==="UP"?"long":direction==="DOWN"?"short":"wait";
  const datum=number(state?.supporting_indicators?.price,NaN),strike=referenceStrike(state,datum),reach=reachFromDatum(datum,model.raw_direction);
  const roles={ultima:"VOL CONVEXITY",zomma:"VOL → GAMMA",gamma:"CURVATURE",speed:"SPOT ACCELERATION",color:"TIME DECAY",delta:"PRIMARY DIRECTION"};
  return <section className={`gamma-dynamics six-greek-dynamics gamma-dynamics-${tone}`}>
    <header><div><span>DELTA DYNAMICS</span><h2>{symbol} · {direction==="UP"?"LONG":direction==="DOWN"?"SHORT":"WAIT"}</h2><small>{engine.running?"● LIVE OPTIONS PRO":"○ ENGINE IDLE"} · {model.session.label} · {model.history_points} rolling observations</small></div><div className="gamma-dynamics-score"><span>ACTIVE ZONE</span><b className="zone-name">{pretty(model.zone??"NO_ZONE")}</b><small>{model.checks?.filter(check=>check.p).length??0} / {model.checks?.length??0} formula gates</small></div><div className="gamma-dynamics-score pressure"><span>ZONE MATCH SCORE</span><b>{pct(model.score)}</b><small>Confidence {pct(model.confidence)}</small></div></header>
    <div className="six-greek-price-strip"><span>DATUM <b>{Number.isFinite(datum)?datum.toFixed(4):"—"}</b></span><span>1.25-PT REACH <b>{Number.isFinite(reach)?reach.toFixed(4):"—"}</b></span><span>{strike.estimated?"REFERENCE STRIKE":"STRIKE"} <b>{Number.isFinite(strike.value)?strike.value.toFixed(2):"—"}</b></span><span>MARKET HOUR <b>{model.session.label}</b></span></div>
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
      reach:number(call.target_price,reachFromDatum(datum,call.direction)),decision:call.direction,zone:snapshot.zone??"NO_ZONE",
      score:number(snapshot.score),confidence:number(snapshot.confidence),session:{label:pretty(snapshot.zone??marketHourLabel(call.alerted_at))},
      scaled:snapshot.normalized??{},persisted:true};});
    return [...new Map([...persisted,...deriveSixGreekEvents(history,state,symbol)].map(event=>[event.id,event])).values()].sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp));
  },[history,state,symbol,calls]);
  return <article className="panel gamma-dynamics-log six-greek-log"><header className="panel-head"><div><span>DELTA DYNAMICS EVENT LOG</span><h2>Qualified zone formulas · fixed 1.25-point reach</h2></div><b>{events.length} EVENTS</b></header><div className="gamma-log-scroll"><table><thead><tr><th>CALL</th><th>ZONE</th><th>DATE · EASTERN</th><th>TIME · MS</th><th>MARKET HOUR</th><th>SYMBOL</th><th>DATUM</th><th>1.25-PT REACH</th><th>STRIKE / REFERENCE</th><th>MATCH</th><th>CONFIDENCE</th>{SIX_GREEKS.map(name=><th key={name}>{name.toUpperCase()} · SCALED</th>)}<th>EVENT ID</th></tr></thead><tbody>{events.map(event=><tr key={event.id}><td><span className={`direction-pill ${event.decision.toLowerCase()}`}>{biasLabel(event.decision)}</span></td><td>{pretty(event.zone)}</td><td>{logDate(event.timestamp)}</td><td>{logTime(event.timestamp)}</td><td><span className="market-hour">{event.session.label}</span></td><td>{event.symbol}</td><td className="extreme-price">{event.datum.toFixed(4)}</td><td className="extreme-price">{event.reach.toFixed(4)}</td><td className="extreme-price">{event.strike.estimated?"REF ":""}{event.strike.value.toFixed(2)}</td><td>{pct(event.score)}</td><td>{pct(event.confidence)}</td>{SIX_GREEKS.map(name=><td key={name}>{number(event.scaled?.[name])>=0?"+":""}{number(event.scaled?.[name]).toFixed(3)}</td>)}<td><button type="button" className="call-id" onClick={()=>navigator.clipboard.writeText(event.id)}>{event.id}</button></td></tr>)}</tbody></table>{!events.length&&<div className="gamma-log-empty"><b>NO QUALIFIED DELTA DYNAMICS ZONE YET</b><p>Calls require 20 rolling observations and every numerical gate in the active market-time formula.</p></div>}</div></article>;
}

function DeltaDynamicsEventLog({history,state,symbol,calls=[]}){
  const [sortOrder,setSortOrder]=useState("newest"),[filterDate,setFilterDate]=useState(""),[fromTime,setFromTime]=useState(""),[toTime,setToTime]=useState(""),[copied,setCopied]=useState(false);
  const rows=useMemo(()=>calls.map(call=>{const snapshot=call.zone_intelligence_at_signal??{},datum=number(call.entry_price),strike=referenceStrike(call,datum);return {id:visibleCallId(call,"DELTA_DYNAMICS"),timestamp:call.alerted_at,symbol:call.symbol??symbol,datum,strike,reach:number(call.target_price,reachFromDatum(datum,call.direction)),decision:call.direction,zone:snapshot.zone??"NO_ZONE",score:number(snapshot.score),confidence:number(snapshot.confidence),scaled:snapshot.normalized??{},call}}),[calls,symbol]);
  const visible=useMemo(()=>rows.filter(row=>{const parts=easternFilterParts(row.timestamp),from=fromTime?(fromTime.length===5?`${fromTime}:00`:fromTime):"",to=toTime?(toTime.length===5?`${toTime}:59`:toTime):"";return (!filterDate||parts.date===filterDate)&&(!from||parts.time>=from)&&(!to||parts.time<=to)}).sort((a,b)=>(sortOrder==="oldest"?1:-1)*(new Date(a.timestamp)-new Date(b.timestamp))),[rows,sortOrder,filterDate,fromTime,toTime]);
  const copy=async()=>{await navigator.clipboard.writeText(visible.map(row=>`${row.id}\t${biasLabel(row.decision)}\t${row.zone}\t${logDate(row.timestamp)} ${logTime(row.timestamp)}\t${row.datum.toFixed(4)}\t${row.reach.toFixed(4)}`).join("\n"));setCopied(true);setTimeout(()=>setCopied(false),1200)};
  return <article className="panel gamma-dynamics-log delta-dynamics-log"><header className="panel-head"><div><span>DELTA DYNAMICS EVENT LOG</span><h2>Every qualified call · observed minute high/low path</h2></div><div className="gamma-log-actions"><button type="button" className="copy-table" onClick={copy} disabled={!visible.length}>{copied?"✓ COPIED":"COPY SUMMARIES"}</button><b>{visible.length} EVENTS</b></div></header>
    <div className="gamma-log-controls"><label>SORT<select value={sortOrder} onChange={event=>setSortOrder(event.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label><label>DATE<input type="date" value={filterDate} onChange={event=>setFilterDate(event.target.value)}/></label><label>FROM<input type="time" step="1" value={fromTime} onChange={event=>setFromTime(event.target.value)}/></label><label>TO<input type="time" step="1" value={toTime} onChange={event=>setToTime(event.target.value)}/></label><button type="button" onClick={()=>{setFilterDate("");setFromTime("");setToTime("")}}>CLEAR FILTER</button></div>
    <div className="gamma-log-scroll"><table><thead><tr><th>DIRECTION</th><th>ZONE</th><th>DATE · EASTERN</th><th>TIME · MS</th><th>MARKET HOUR</th><th>SOURCE</th><th>DATUM / ALERT PRICE</th><th>1.25-PT REACH</th><th>STRIKE / REFERENCE</th><th>DYNAMIC / EXTREME HIGH</th><th>HIGH CHANGE</th><th>TIME TO HIGH</th><th>DYNAMIC / EXTREME LOW</th><th>LOW CHANGE</th><th>TIME TO LOW</th><th>CURRENT / FINAL</th><th>CALL STATE</th><th>ZONE MATCH</th><th>CONFIDENCE</th>{SIX_GREEKS.map(name=><th key={name}>{name.toUpperCase()}</th>)}<th>EVENT ID</th></tr></thead><tbody>{visible.map(row=>{const call=row.call,high=number(call.highest_price,call.dynamic_high),low=number(call.lowest_price,call.dynamic_low),current=number(call.current_price??call.final_price??call.minute_bars?.at(-1)?.close,NaN),change=value=>Number.isFinite(value)?`${value-row.datum>=0?"+":""}${(value-row.datum).toFixed(4)} pts`:"—";return <Fragment key={row.id}><tr className={row.decision==="UP"?"gamma-call-tracking-success":"gamma-call-tracking-failing"}><td><span className={`direction-pill ${row.decision.toLowerCase()}`}>{row.decision==="UP"?"UPWARD":"DOWNWARD"}</span></td><td>{pretty(row.zone)}</td><td>{logDate(row.timestamp)}</td><td>{logTime(row.timestamp)}</td><td><span className="market-hour">{marketHourLabel(row.timestamp)}</span></td><td>{row.symbol}</td><td className="extreme-price">{row.datum.toFixed(4)}</td><td className="extreme-price">{row.reach.toFixed(4)}</td><td className="extreme-price">{row.strike.estimated?"REF ":""}{row.strike.value.toFixed(2)}</td><td className="extreme-price">{Number.isFinite(high)?high.toFixed(4):"—"}</td><td>{change(high)}</td><td>{duration(call.seconds_to_high)}</td><td className="extreme-price">{Number.isFinite(low)?low.toFixed(4):"—"}</td><td>{change(low)}</td><td>{duration(call.seconds_to_low)}</td><td className="extreme-price">{Number.isFinite(current)?current.toFixed(4):"—"}</td><td><span className={`gamma-call-state ${call.status==="TARGET_REACHED"?"success":"tracking-success"}`}>{call.status??"TRACKING"}</span></td><td>{pct(row.score)}</td><td>{pct(row.confidence)}</td>{SIX_GREEKS.map(name=><td key={name}>{signedGreek(row.scaled?.[name])}</td>)}<td><button type="button" className="call-id" onClick={()=>navigator.clipboard.writeText(row.id)}>{row.id}</button></td></tr>{call.family_legs?.length>0&&<tr className="gamma-family-dropdown-row"><td colSpan={26}><details><summary>SHOW CHILD LEGS · {call.family_stage} · AVG DATUM {number(call.family_average_datum).toFixed(4)} · AVG P/L {number(call.family_average_pl_points)>=0?"+":""}{number(call.family_average_pl_points).toFixed(4)} PTS</summary><div className="risk-leg-table-wrap"><table className="risk-leg-table"><thead><tr><th>LEG</th><th>CHILD ID</th><th>ROLE</th><th>STATUS</th><th>ACTIVATED · ET</th><th>DATUM</th><th>CURRENT / FINAL</th><th>LEG P/L</th></tr></thead><tbody>{call.family_legs.map(leg=>{const price=number(call.current_price??call.final_price,leg.datum),pl=call.direction==="UP"?price-number(leg.datum):number(leg.datum)-price;return <tr key={leg.call_id}><td>{leg.leg_number}</td><td><button type="button" className="call-id" onClick={()=>navigator.clipboard.writeText(leg.call_id)}>{leg.call_id}</button></td><td>{leg.role}</td><td>{leg.status??"TRACKING"}</td><td>{logDate(leg.activated_at)} · {logTime(leg.activated_at)}</td><td>{number(leg.datum).toFixed(4)}</td><td>{price.toFixed(4)}</td><td>{pl>=0?"+":""}{pl.toFixed(4)} pts</td></tr>})}</tbody></table></div></details></td></tr>}</Fragment>})}</tbody></table>{!visible.length&&<div className="gamma-log-empty"><b>NO QUALIFIED DELTA DYNAMICS EVENT YET</b><p>Calls appear after the active market-zone formulas qualify.</p></div>}</div>
  </article>;
}
function GammaDynamicsChart({history=[],state,symbol,deltaMode=false}){
  const quartet=!deltaMode,series=deltaMode?[["ultima","#c77dff","VOL CONVEXITY"],["zomma","#06d6a0","VOL TO GAMMA"],["gamma","#4cc9f0","CURVATURE"],["speed","#ef476f","SPOT ACCELERATION"],["color","#f4d35e","TIME DECAY"],["delta","#ff5c8a","PRIMARY DIRECTION"]]:[["zomma","#06d6a0","VOL INTENSITY"],["color","#f4d35e","TIME INTENSITY"],["speed","#ef476f","SPOT PRESSURE"],["gamma","#4cc9f0","CURVATURE"]];
  const [intervalSeconds,setIntervalSeconds]=useState(5),[expanded,setExpanded]=useState(false),[zoom,setZoom]=useState(1),[cursor,setCursor]=useState(null);
  const drag=useRef(null),viewport=useGreekViewport(history,state,symbol,intervalSeconds,Math.max(12,Math.round((expanded?140:90)/zoom))),rows=viewport.visible;
  const dims={width:1200,height:expanded?(deltaMode?820:760):(deltaMode?610:500),left:deltaMode?190:138,right:30,top:20,bottom:58},plotWidth=dims.width-dims.left-dims.right,plotHeight=dims.height-dims.top-dims.bottom,laneHeight=plotHeight/series.length;
  const valueFor=(row,name)=>deltaMode?optionalNumber(row?.zone_intelligence?.normalized?.[name]??greekValue(row,name)):greekValue(row,name),formatValue=value=>signedGreek(value),formatTime=chartTime;
  const ranges=Object.fromEntries(series.map(([name])=>{const values=rows.map(row=>valueFor(row,name)).filter(Number.isFinite),minimum=values.length?Math.min(...values):0,maximum=values.length?Math.max(...values):0,center=(minimum+maximum)/2,raw=maximum-minimum,padding=Math.max(raw*.14,Math.abs(center)*.002,1e-12);return [name,{minimum:minimum-padding,maximum:maximum+padding}]}));
  const x=index=>dims.left+index*plotWidth/Math.max(1,rows.length-1),y=(value,name)=>{const index=series.findIndex(([key])=>key===name),range=ranges[name],top=dims.top+index*laneHeight+10,bottom=dims.top+(index+1)*laneHeight-10;return top+(range.maximum-value)*(bottom-top)/Math.max(range.maximum-range.minimum,1e-15)};
  const hovered=rows[cursor?.index??rows.length-1],zoomChart=(amount,anchorIndex=cursor?.index??rows.length-1)=>{const next=Math.max(1,Math.min(8,Math.round((zoom+amount)*2)/2));if(next===zoom)return;const fraction=rows.length>1?anchorIndex/(rows.length-1):1,globalIndex=viewport.rows.length-viewport.offset-rows.length+anchorIndex,nextCount=Math.max(12,Math.round((expanded?140:90)/next)),nextIndex=Math.round(fraction*Math.max(nextCount-1,0)),nextOffset=Math.max(0,Math.min(Math.max(0,viewport.rows.length-nextCount),viewport.rows.length-(globalIndex-nextIndex+nextCount)));setZoom(next);viewport.setOffset(nextOffset);setCursor(current=>current?{...current,index:nextIndex}:current)};
  const cursorAt=event=>chartCursor(event,dims,rows.length,1),onPointerMove=event=>{const next=cursorAt(event);setCursor(next);if(drag.current){const delta=event.clientX-drag.current.x;if(Math.abs(delta)>3)drag.current.moved=true;viewport.setOffset(Math.max(0,Math.min(viewport.maxOffset,drag.current.offset-Math.round(delta/7))))}},onPointerDown=event=>{drag.current={x:event.clientX,offset:viewport.offset,moved:false};event.currentTarget.setPointerCapture(event.pointerId)},onPointerUp=()=>{if(!expanded&&!drag.current?.moved)setExpanded(true);drag.current=null};
  return <ChartShell expanded={expanded} setExpanded={setExpanded} className={`gamma-dynamics-history-chart gamma-dynamics-chart ${deltaMode?"delta-dynamics-chart":""}`}>
    <div className="greek-chart-header"><div><span>{deltaMode?"DELTA DYNAMICS HISTORY":"GAMMA DYNAMICS HISTORY"}</span><h2>{symbol} · {deltaMode?"Ultima / Zomma / Gamma / Speed / Color / Delta":"Zomma / Color / Speed / Gamma"}</h2></div><div className="greek-header-actions"><ChartTimeControls {...{intervalSeconds,setIntervalSeconds,isLive:viewport.isLive,setOffset:viewport.setOffset,expanded,setExpanded,zoom,onZoom:zoomChart}}/></div></div>
    <div className="greek-chart-legend">{series.map(([name,color,role])=><div key={name}><i style={{backgroundColor:color}}/><span>{name.toUpperCase()} · {role}</span><b>{formatValue(valueFor(rows.at(-1),name))}</b></div>)}</div>
    <div className="triad-chart-note">Each variable uses its own visible-range scale so small real values remain legible. Hover values stay unscaled.</div>
    <div className="greek-chart-stage" onWheel={event=>{event.preventDefault();const anchor=cursorAt(event);setCursor(anchor);if(event.shiftKey)viewport.move(event.deltaY>0?10:-10);else zoomChart(event.deltaY<0?.5:-.5,anchor.index)}} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={()=>{drag.current=null}} onPointerLeave={()=>{drag.current=null;setCursor(null)}}>
      <svg viewBox={`0 0 ${dims.width} ${dims.height}`} role="img" aria-label={deltaMode?"Ultima, Zomma, Gamma, Speed, Color, and Delta plotted over time":"Zomma, Color, Speed, and Gamma plotted over time"}>
        {series.flatMap(([name,color,role],laneIndex)=>{const range=ranges[name],top=dims.top+laneIndex*laneHeight,bottom=top+laneHeight,middle=(top+bottom)/2;return <g key={`lane-${name}`}><rect className="first-order-lane" x={dims.left} y={top} width={plotWidth} height={laneHeight}/><text className="triad-lane-name" x="12" y={middle-5} style={{fill:color}}>{name.toUpperCase()}</text><text className="triad-lane-role" x="12" y={middle+14}>{role}</text>{[range.maximum,(range.maximum+range.minimum)/2,range.minimum].map((tickValue,tickIndex)=>{const yy=[top+10,middle,bottom-10][tickIndex];return <g key={`${name}-${tickIndex}`}><line className="greek-grid" x1={dims.left} x2={dims.width-dims.right} y1={yy} y2={yy}/><text className="greek-axis" x={dims.left-10} y={yy+4} textAnchor="end">{formatValue(tickValue)}</text></g>})}</g>})}
        {[0,1,2,3,4,5].map(tick=>{const index=Math.round(tick*Math.max(rows.length-1,0)/5),xx=x(index);return <g key={`x-${tick}`}><line className="greek-grid" x1={xx} x2={xx} y1={dims.top} y2={dims.height-dims.bottom}/><text className="greek-axis" x={xx} y={dims.height-18} textAnchor="middle">{formatTime(rows[index]?.timestamp)}</text></g>})}
        {series.map(([name,color])=>{let drawing=false;const path=rows.map((row,index)=>{const value=valueFor(row,name);if(!Number.isFinite(value)){drawing=false;return ""}const command=drawing?"L":"M";drawing=true;return `${command}${x(index).toFixed(1)},${y(value,name).toFixed(1)}`}).filter(Boolean).join(" "),latest=valueFor(rows.at(-1),name);return <g key={name}>{path&&<path className="greek-series" d={path} style={{stroke:color}}/>}{Number.isFinite(latest)&&<circle className="greek-current-dot" cx={x(rows.length-1)} cy={y(latest,name)} r="4" style={{fill:color}}/>}</g>})}
        {cursor&&<g><line className="greek-crosshair" x1={x(cursor.index)} x2={x(cursor.index)} y1={dims.top} y2={dims.height-dims.bottom}/>{series.map(([name,color])=>{const value=valueFor(hovered,name);return Number.isFinite(value)?<circle key={name} className="greek-hover-dot" cx={x(cursor.index)} cy={y(value,name)} r="5" style={{fill:color}}/>:null})}</g>}
      </svg><ChartCoordinateTooltip {...{cursor,row:hovered,series:series.map(([name,color])=>[name,color]),formatTime,formatValue,seriesValue:valueFor}} cursorValueText={()=>"Actual values by lane"}/>{!rows.length&&<div className="chart-empty">Waiting for streamed {deltaMode?"Delta Dynamics":"Gamma Dynamics"} history...</div>}
    </div>
    <ChartHistoryNavigator viewport={viewport}/><div className="greek-chart-readout"><span>Wheel: zoom at cursor · Shift+wheel/drag: history</span><span>{viewport.isLive?"Following current stream":`${viewport.offset} buckets behind live`}</span><span>{formatTime(hovered?.timestamp)}</span>{series.map(([name,color])=><span key={name}><i style={{backgroundColor:color}}/>{name} {formatValue(valueFor(hovered,name))}</span>)}</div>
  </ChartShell>;
}

function GammaDynamicsLog({history,state,symbol,calls=[]}){
  const current=deriveGammaDynamics(state,history);
  const [copied,setCopied]=useState(false);
  const [sortOrder,setSortOrder]=useState("newest");
  const [filterDate,setFilterDate]=useState("");
  const [fromTime,setFromTime]=useState("");
  const [toTime,setToTime]=useState("");
  const [scrollSize,setScrollSize]=useState({width:0,height:0});
  const topScrollRef=useRef(null),bottomScrollRef=useRef(null),leftScrollRef=useRef(null),rightScrollRef=useRef(null),bodyScrollRef=useRef(null),tableRef=useRef(null);
  const events=useMemo(()=>{
    const derived=deriveGammaDynamicsEvents(history,state,symbol);
    const persisted=calls.map(call=>{
      const snapshot=call.gamma_dynamics_at_signal??{},inputs=snapshot.inputs??call.greek_values_at_signal??{};
      return {
        id:visibleCallId(call,"GAMMA_DYNAMICS"),timestamp:call.alerted_at,symbol:call.symbol??symbol,
        price:number(call.entry_price,NaN),decision:call.direction,
        intensity:Number(snapshot.intensity),pressure:Number(snapshot.pressure),
        zomma:Number(inputs.zomma),color:Number(inputs.color),speed:Number(inputs.speed),gamma:Number(inputs.gamma),
        persisted:true,
      };
    });
    return [...new Map([...persisted,...derived].map(event=>[event.id,event])).values()]
      .sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp));
  },[history,state,symbol,calls]);
  const visibleEvents=useMemo(()=>events.filter(event=>{
    const eastern=easternFilterParts(event.timestamp);
    if(filterDate&&eastern.date!==filterDate)return false;
    const from=fromTime?(fromTime.length===5?`${fromTime}:00`:fromTime):"";
    const to=toTime?(toTime.length===5?`${toTime}:59`:toTime):"";
    if(from&&eastern.time<from)return false;
    if(to&&eastern.time>to)return false;
    return true;
  }).sort((a,b)=>(sortOrder==="oldest"?1:-1)*(new Date(a.timestamp)-new Date(b.timestamp))),[events,filterDate,fromTime,toTime,sortOrder]);
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
  const linkedCall=event=>calls.find(call=>visibleCallId(call,"GAMMA_DYNAMICS")===event.id);
  const visualState=call=>{
    if(!call)return {key:"tracking-failing",label:"TRACKING · FAILING"};
    const outcome=callOutcome(call),datum=number(call.entry_price),price=number(call.current_price??call.final_price??call.minute_bars?.at(-1)?.close,datum);
    if(outcome.closed)return outcome.grade==="success"?{key:"success",label:"SUCCESS"}:{key:"failed",label:"FAILED"};
    const succeeding=call.direction==="UP"?price>=datum:price<=datum;
    return succeeding?{key:"tracking-success",label:"TRACKING · SUCCEEDING"}:{key:"tracking-failing",label:"TRACKING · FAILING"};
  };
  const priceValue=(call,value)=>!call||!Number.isFinite(Number(value))?"—":number(value).toFixed(4);
  const pointValue=(call,value)=>{if(!call||!Number.isFinite(Number(value)))return <span className="point-delta flat">—</span>;const delta=number(value)-number(call.entry_price),tone=delta>0?"up":delta<0?"down":"flat";return <span className={`point-delta ${tone}`}>{delta>=0?"+":""}{delta.toFixed(4)} pts</span>};
  const extremeTime=(call,seconds,finished)=>!call?"—":finished?duration(seconds):"TRACKING";
  const legMetrics=(call,leg)=>{
    const activated=new Date(leg.activated_at).getTime(),bars=(call.minute_bars??[]).filter(bar=>new Date(bar.timestamp).getTime()>=activated);
    const datum=number(leg.datum),price=number(call.current_price??call.final_price??call.minute_bars?.at(-1)?.close,datum);
    const highBar=bars.reduce((best,bar)=>!best||number(bar.high)>number(best.high)?bar:best,null);
    const lowBar=bars.reduce((best,bar)=>!best||number(bar.low)<number(best.low)?bar:best,null);
    const high=highBar?number(highBar.high):Math.max(datum,price),low=lowBar?number(lowBar.low):Math.min(datum,price);
    const pl=call.direction==="UP"?price-datum:datum-price,status=pl>0?"SUCCEEDED":pl<0?"FAILED":"FLAT";
    return {datum,price,high,low,pl,status,tone:pl>0?"profit":pl<0?"loss":"flat",timeHigh:highBar?duration(Math.max(0,(new Date(highBar.timestamp)-activated)/1000)):"0.0s",timeLow:lowBar?duration(Math.max(0,(new Date(lowBar.timestamp)-activated)/1000)):"0.0s"};
  };
  const copySummaries=async()=>{
    const headers=["Call ID","Status","Direction","Alerted (ET)","Market Hour","Strongest Greek","Weakest Greek","Datum","Extreme High","High Change","Time to High","Extreme Low","Low Change","Time to Low","Current / Final","Final Change"];
    const clean=value=>String(value??"—").replaceAll("|","/");
    const rows=visibleEvents.map(event=>{const call=linkedCall(event),view=visualState(call),finished=Boolean(call&&callOutcome(call).closed),high=call?number(call.highest_price,call.dynamic_high):NaN,low=call?number(call.lowest_price,call.dynamic_low):NaN,datum=number(call?.entry_price,event.price),currentPrice=number(call?.current_price??call?.final_price??call?.minute_bars?.at(-1)?.close,NaN);return [event.id,view.label,event.decision,`${logDate(event.timestamp)} ${logTime(event.timestamp)}`,marketHourLabel(event.timestamp),call?.strongest_greek_current??call?.strongest_greek??"—",call?.weakest_greek_current??call?.weakest_greek??"—",datum.toFixed(4),Number.isFinite(high)?high.toFixed(4):"—",Number.isFinite(high)?`${high-datum>=0?"+":""}${(high-datum).toFixed(4)} pts`:"—",finished?duration(call.seconds_to_high):"Tracking",Number.isFinite(low)?low.toFixed(4):"—",Number.isFinite(low)?`${low-datum>=0?"+":""}${(low-datum).toFixed(4)} pts`:"—",finished?duration(call.seconds_to_low):"Tracking",Number.isFinite(currentPrice)?currentPrice.toFixed(4):"—",Number.isFinite(currentPrice)?`${currentPrice-datum>=0?"+":""}${(currentPrice-datum).toFixed(4)} pts`:"—"].map(clean)});
    const widths=headers.map((header,column)=>Math.max(header.length,...rows.map(row=>row[column].length))),formatRow=row=>`| ${row.map((cell,column)=>cell.padEnd(widths[column])).join(" | ")} |`,divider=`|-${widths.map(width=>"-".repeat(width)).join("-|-")}-|`;
    try{await navigator.clipboard.writeText([`GAMMA DYNAMICS CALL SUMMARY · ${symbol} · EASTERN TIME`,"",formatRow(headers),divider,...rows.map(formatRow)].join("\n"));setCopied(true);window.setTimeout(()=>setCopied(false),1800)}catch{setCopied(false)}
  };
  const gateItems=[
    ["BASELINE",number(current.history_points)>=20,`${number(current.history_points).toFixed(0)} / 20 observations`],
    ["INTENSITY",number(current.intensity)>=number(current.intensity_threshold,.65),`${pct(current.intensity)} / ${pct(current.intensity_threshold??.65)}`],
    ["SPEED",Math.abs(number(current.inputs?.speed))>1e-12,signedGreek(current.inputs?.speed)],
    ["GAMMA",Math.abs(number(current.inputs?.gamma))>1e-12,signedGreek(current.inputs?.gamma)],
  ];
  return <article className="panel gamma-dynamics-log">
    <header className="panel-head"><div><span>GAMMA DYNAMICS EVENT LOG</span><h2>Every qualified call · observed minute high/low path</h2></div><div className="gamma-log-actions"><button type="button" className="copy-table" onClick={copySummaries} disabled={!visibleEvents.length}>{copied?"✓ COPIED":"COPY SUMMARIES"}</button><b>{visibleEvents.length}{visibleEvents.length!==events.length?` / ${events.length}`:""} EVENTS</b></div></header>
    <div className="gamma-log-controls">
      <label>SORT<select value={sortOrder} onChange={event=>setSortOrder(event.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label>
      <label>DATE<input type="date" value={filterDate} onChange={event=>setFilterDate(event.target.value)}/></label>
      <label>FROM<input type="time" step="1" value={fromTime} onChange={event=>setFromTime(event.target.value)}/></label>
      <label>TO<input type="time" step="1" value={toTime} onChange={event=>setToTime(event.target.value)}/></label>
      <button type="button" onClick={()=>{setFilterDate("");setFromTime("");setToTime("");}}>CLEAR FILTER</button>
    </div>
    <div className="gamma-log-scroll-shell">
      <div className="gamma-log-scroll-top" ref={topScrollRef} onScroll={syncHorizontal}><div style={{width:scrollSize.width}}/></div>
      <div className="gamma-log-scroll-row">
        <div className="gamma-log-scroll-left" ref={leftScrollRef} onScroll={syncVertical}><div style={{height:scrollSize.height}}/></div>
        <div className="gamma-log-scroll" ref={bodyScrollRef} onScroll={syncFromBody}><table ref={tableRef}>
      <thead><tr><th>DIRECTION</th><th>DATE · EASTERN</th><th>TIME · MS</th><th>MARKET HOUR</th><th>SOURCE</th><th>DATUM / ALERT PRICE</th><th>1.25-PT REACH</th><th>STRIKE / REFERENCE</th><th>DYNAMIC / EXTREME HIGH</th><th>HIGH CHANGE</th><th>TIME TO HIGH</th><th>DYNAMIC / EXTREME LOW</th><th>LOW CHANGE</th><th>TIME TO LOW</th><th>CURRENT / FINAL</th><th>CURRENT / FINAL CHANGE</th><th>CALL STATE</th><th>STRONGEST GREEK</th><th>WEAKEST GREEK</th><th>INTENSITY</th><th>PRESSURE</th><th>ZOMMA</th><th>COLOR</th><th>SPEED</th><th>GAMMA</th><th>EVENT ID</th></tr></thead>
      <tbody>{visibleEvents.map((event,index)=>{
        const call=linkedCall(event),expired=call&&callDeadlinePassed(call),snapshot=call?deadlineSnapshot(call):{},livePrice=expired?snapshot.price:(call?.current_price??call?.final_price??call?.minute_bars?.at(-1)?.close),outcome=callOutcome(call),view=visualState(call),finished=outcome.closed;
        const high=call?number(call.highest_price,expired?snapshot.high:call.dynamic_high):NaN,low=call?number(call.lowest_price,expired?snapshot.low:call.dynamic_low):NaN,datum=number(call?.entry_price,event.price),strike=referenceStrike(call??event,datum);
        return <Fragment key={`${event.timestamp}-${event.decision}-${index}`}>
          <tr className={`gamma-call-${view.key}`}><td><span className={`direction-pill ${event.decision.toLowerCase()}`}>{event.decision==="UP"?"UPWARD":"DOWNWARD"}</span></td><td>{logDate(event.timestamp)}</td><td>{logTime(event.timestamp)}</td><td><span className="market-hour">{marketHourLabel(event.timestamp)}</span></td><td>{event.symbol}</td><td className="extreme-price">{Number.isFinite(datum)?datum.toFixed(4):"—"}</td><td className="extreme-price">{Number.isFinite(datum)?reachFromDatum(datum,event.decision).toFixed(4):"—"}</td><td className="extreme-price">{Number.isFinite(strike.value)?`${strike.estimated?"REF ":""}${strike.value.toFixed(2)}`:"—"}</td><td className="extreme-price">{priceValue(call,high)}</td><td>{pointValue(call,high)}</td><td className="extreme-time">{extremeTime(call,call?.seconds_to_high,finished)}</td><td className="extreme-price">{priceValue(call,low)}</td><td>{pointValue(call,low)}</td><td className="extreme-time">{extremeTime(call,call?.seconds_to_low,finished)}</td><td className="extreme-price">{priceValue(call,livePrice)}</td><td>{pointValue(call,livePrice)}</td><td><span className={`gamma-call-state ${view.key}`}>{view.label}</span></td><td><GreekAuditBadge label={call?.strongest_greek_current??call?.strongest_greek}/></td><td><GreekAuditBadge label={call?.weakest_greek_current??call?.weakest_greek}/></td><td>{Number.isFinite(event.intensity)?pct(event.intensity):"—"}</td><td>{Number.isFinite(event.pressure)?`${event.pressure>0?"+":""}${event.pressure.toFixed(2)}`:"—"}</td><td>{signedGreek(event.zomma)}</td><td>{signedGreek(event.color)}</td><td>{signedGreek(event.speed)}</td><td>{signedGreek(event.gamma)}</td><td><button type="button" className="call-id" onClick={()=>navigator.clipboard.writeText(event.id)} title="Copy event ID">{event.id}</button></td></tr>
          {call?.family_legs?.length>0&&<tr className="gamma-family-dropdown-row"><td colSpan="26"><details><summary>SHOW CHILD LEGS · {call.family_stage} · AVG DATUM {number(call.family_average_datum).toFixed(4)} · AVG P/L {number(call.family_average_pl_points)>=0?"+":""}{number(call.family_average_pl_points).toFixed(4)} PTS</summary><div className="risk-leg-table-wrap"><table className="risk-leg-table"><thead><tr><th>LEG</th><th>CHILD ID</th><th>ROLE</th><th>STATUS</th><th>TRIGGER</th><th>ACTIVATED · ET</th><th>DATUM</th><th>CURRENT / FINAL</th><th>LEG P/L</th><th>EXTREME HIGH</th><th>TIME TO HIGH</th><th>EXTREME LOW</th><th>TIME TO LOW</th></tr></thead><tbody>{call.family_legs.map(leg=>{const metric=legMetrics(call,leg);return <tr className={`risk-leg-row ${metric.tone}`} key={leg.call_id}><td>{leg.leg_number}</td><td><button type="button" className="call-id" onClick={()=>navigator.clipboard.writeText(leg.call_id)}>{leg.call_id}</button></td><td>{leg.role}</td><td><span className={`leg-status ${metric.tone}`}>{metric.status}</span></td><td>{leg.trigger_adverse_points===0?"0":`${call.direction==="UP"?"-":"+"}${number(leg.trigger_adverse_points).toFixed(0)} PTS`}</td><td>{logDate(leg.activated_at)} · {logTime(leg.activated_at)}</td><td className="extreme-price">{metric.datum.toFixed(4)}</td><td className="extreme-price">{metric.price.toFixed(4)}</td><td><span className={`family-pl ${metric.tone}`}>{metric.pl>=0?"+":""}{metric.pl.toFixed(4)} pts</span></td><td className="extreme-price">{metric.high.toFixed(4)}</td><td>{metric.timeHigh}</td><td className="extreme-price">{metric.low.toFixed(4)}</td><td>{metric.timeLow}</td></tr>})}</tbody></table></div></details></td></tr>}
        </Fragment>
      })}</tbody>
    </table>{!visibleEvents.length&&<div className="gamma-log-empty"><b>{events.length?"NO EVENTS MATCH THIS RANGE":"NO QUALIFIED EVENT YET"}</b><p>{events.length?"Clear or widen the date/time filter.":current.explanation}</p>{!events.length&&<><div>{gateItems.map(([name,passed,detail])=><span className={passed?"passed":"waiting"} key={name}><b>{passed?"PASS":"WAIT"} · {name}</b><small>{detail}</small></span>)}</div><small>The log does not manufacture rows from unqualified states. A row is written when baseline, intensity, Speed direction, and active Gamma pass together.</small></>}</div>}</div>
        <div className="gamma-log-scroll-right" ref={rightScrollRef} onScroll={syncVertical}><div style={{height:scrollSize.height}}/></div>
      </div>
      <div className="gamma-log-scroll-bottom" ref={bottomScrollRef} onScroll={syncHorizontal}><div style={{width:scrollSize.width}}/></div>
    </div>
  </article>;
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
  const nextTrigger=call=>call.family_next_trigger_points==null?"ALL ACTIVE":`${call.direction==="UP"?"-":"+"}${number(call.family_next_trigger_points).toFixed(0)} PTS`;
  const legMetrics=(call,leg)=>{
    const activated=new Date(leg.activated_at).getTime(),bars=(call.minute_bars??[]).filter(bar=>new Date(bar.timestamp).getTime()>=activated);
    const datum=number(leg.datum),price=currentPrice(call);
    const highBar=bars.reduce((best,bar)=>!best||number(bar.high)>number(best.high)?bar:best,null);
    const lowBar=bars.reduce((best,bar)=>!best||number(bar.low)<number(best.low)?bar:best,null);
    const high=highBar?number(highBar.high):Math.max(datum,price),low=lowBar?number(lowBar.low):Math.min(datum,price);
    const pl=call.direction==="UP"?price-datum:datum-price,status=pl>0?"SUCCEEDED":pl<0?"FAILED":"FLAT";
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
            <tr className={`risk-family-row ${callTone}`}><td><span className={`direction-pill ${call.direction.toLowerCase()}`}>{call.direction==="UP"?"LONG":"SHORT"}</span></td><td><button type="button" className="call-id" onClick={()=>navigator.clipboard.writeText(call.family_id??call.call_id)}>{call.family_id??call.call_id}</button></td><td>{logDate(call.alerted_at)}</td><td>{logTime(call.alerted_at)}</td><td><span className="market-hour">{marketHourLabel(call.alerted_at)}</span></td><td className="extreme-price">{number(call.entry_price).toFixed(4)}</td><td className="extreme-price">{price.toFixed(4)}</td><td className="family-legs-count">{call.family_active_legs??call.family_legs.length} / 4</td><td>{call.family_stage}</td><td className="extreme-price">{number(call.family_average_datum).toFixed(4)}</td><td><span className={`family-pl ${callTone}`}>{number(call.family_average_pl_points)>=0?"+":""}{number(call.family_average_pl_points).toFixed(4)} pts</span></td><td><span className={`family-pl ${callTone}`}>{number(call.family_total_pl_points)>=0?"+":""}{number(call.family_total_pl_points).toFixed(4)} pts</span></td><td className="family-next">{nextTrigger(call)}</td><td className="extreme-price">{number(call.highest_price).toFixed(4)}</td><td className="extreme-price">{number(call.lowest_price).toFixed(4)}</td><td className="extreme-time">{remaining(call)}</td><td><GreekAuditBadge label={call.strongest_greek_current??call.strongest_greek}/></td><td><GreekAuditBadge label={call.weakest_greek_current??call.weakest_greek}/></td><td><span className={`gamma-family-state ${callTone}`}>{call.family_outcome_state}</span></td></tr>
            <tr className="risk-family-expand"><td colSpan="19"><details><summary>SHOW LEG ROWS + FAMILY GRAPH</summary><div className="risk-leg-table-wrap"><table className="risk-leg-table"><thead><tr><th>LEG</th><th>CHILD ID</th><th>ROLE</th><th>STATUS</th><th>TRIGGER</th><th>ACTIVATED · ET</th><th>DATUM</th><th>CURRENT / FINAL</th><th>LEG P/L</th><th>EXTREME HIGH</th><th>TIME TO HIGH</th><th>EXTREME LOW</th><th>TIME TO LOW</th></tr></thead><tbody>{call.family_legs.map(leg=>{const metric=legMetrics(call,leg);return <tr className={`risk-leg-row ${metric.tone}`} key={leg.call_id}><td>{leg.leg_number}</td><td><button type="button" className="call-id" onClick={()=>navigator.clipboard.writeText(leg.call_id)}>{leg.call_id}</button></td><td>{leg.role}</td><td><span className={`leg-status ${metric.tone}`}>{metric.status}</span></td><td>{leg.trigger_adverse_points===0?"0":`${call.direction==="UP"?"-":"+"}${number(leg.trigger_adverse_points).toFixed(0)} PTS`}</td><td>{logDate(leg.activated_at)} · {logTime(leg.activated_at)}</td><td className="extreme-price">{metric.datum.toFixed(4)}</td><td className="extreme-price">{metric.price.toFixed(4)}</td><td><span className={`family-pl ${metric.tone}`}>{metric.pl>=0?"+":""}{metric.pl.toFixed(4)} pts</span></td><td className="extreme-price">{metric.high.toFixed(4)}</td><td>{metric.timeHigh}</td><td className="extreme-price">{metric.low.toFixed(4)}</td><td>{metric.timeLow}</td></tr>})}</tbody></table></div><FiftyPointPathChart call={call}/></details></td></tr>
          </Fragment>;
        })}</tbody>
      </table>
      {!families.length&&<div className="gamma-log-empty"><b>NO RISK FAMILIES YET</b><p>A family appears when a new Gamma Dynamics call begins.</p></div>}
    </div>
    <div className="risk-scroll-bottom" ref={bottomRef} onScroll={syncBar}><div style={{width:scrollWidth}}/></div>
  </article>;
}

const SYSTEM_OUTCOME_LABELS={PRIMARY_OPTIONS:"Primary Options Bias",GAMMA_DYNAMICS:"Gamma Dynamics",DELTA_DYNAMICS:"Delta Dynamics"};
const SYSTEM_OUTCOME_STREAMS={PRIMARY_OPTIONS:1,GAMMA_DYNAMICS:3,DELTA_DYNAMICS:4};
const visibleCallId=(call,system)=>/^\d{19}$/.test(String(call?.call_id??""))?String(call.call_id):numericEventId(call?.alerted_at,SYSTEM_OUTCOME_STREAMS[system]??0);
const duration=value=>{const seconds=Math.max(0,number(value));if(seconds<60)return `${seconds.toFixed(1)}s`;const minutes=Math.floor(seconds/60),rest=(seconds-minutes*60).toFixed(1);return `${minutes}m ${rest}s`};
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
  const closed=Boolean(call.target_reached_at)||call.status==="COMPLETE"||call.status==="EXPIRED"||callDeadlinePassed(call);
  const stored=String(call.outcome_grade??"").toLowerCase();
  const partialThreshold=number(call.partial_target_points,callTargetPoints(call)*.6);
  const grade=!closed?"tracking":stored==="success"||call.target_reached_at?"success":stored==="partial"||favorable>=partialThreshold?"partial":"failed";
  return {grade,favorable,closed};
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

function FiftyPointPathChart({call}){
  const observedBars=deadlineBars(call).filter(bar=>Number.isFinite(number(bar.high,NaN))&&Number.isFinite(number(bar.low,NaN))).sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
  const [hovered,setHovered]=useState(null),[expanded,setExpanded]=useState(false),[yZoom,setYZoom]=useState(1),[yCenter,setYCenter]=useState(null);
  const datum=number(call.entry_price),targetPoints=callTargetPoints(call),target=number(call.target_price,datum+(call.direction==="UP"?targetPoints:-targetPoints)),targetLabel=callTargetLabel(call);
  const datumOnly=!observedBars.length;
  const bars=datumOnly?[{timestamp:call.alerted_at,open:datum,high:datum,low:datum,close:datum,samples:1}]:observedBars;
  const values=bars.flatMap(bar=>[number(bar.high),number(bar.low),number(bar.open),number(bar.close)]).concat([datum]);
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
  const onPointerMove=event=>{const bounds=event.currentTarget.getBoundingClientRect(),ratio=(event.clientX-bounds.left)/Math.max(bounds.width,1),svgX=ratio*dims.width,index=Math.max(0,Math.min(bars.length-1,Math.round((svgX-dims.left)/Math.max(plotWidth,1)*bars.length-.5)));setHovered({index,bar:bars[index],leftPct:Math.max(8,Math.min(76,ratio*100))})};
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
    <div className="alert-path-legend"><span className="datum">DATUM {datum.toFixed(4)}</span><span className="high">MINUTE HIGH</span><span className="low">MINUTE LOW</span><span className="close">MINUTE CLOSE</span><span className="target">{targetLabel} · {call.direction==="UP"?"LONG":"SHORT"} {target.toFixed(4)}</span></div>
    <div className="alert-path-stage">
      <svg viewBox={`0 0 ${dims.width} ${dims.height}`} role="img" aria-label={`One-minute high and low path from the ${biasLabel(call.direction)} alert datum to its ${targetLabel} target`} onWheel={onWheel} onDoubleClick={resetY} onPointerMove={onPointerMove} onPointerLeave={()=>setHovered(null)}>
        {ticks.map((tick,index)=><g key={tick}><line className="path-grid" x1={dims.left} x2={dims.width-dims.right} y1={y(tick)} y2={y(tick)}/><text className="path-axis-text" x={dims.left-10} y={y(tick)+4} textAnchor="end">{tick.toFixed(4)}</text></g>)}
        {xTickIndexes.map(index=><g key={index}><line className="path-grid vertical" x1={x(index)} x2={x(index)} y1={dims.top} y2={dims.height-dims.bottom}/><text className="path-axis-text" x={x(index)} y={dims.height-24} textAnchor="middle">{chartTime(bars[index].timestamp)}</text></g>)}
        <text className="path-axis-title" transform={`translate(16 ${dims.top+plotHeight/2}) rotate(-90)`} textAnchor="middle">PRICE ({call.symbol})</text>
        <text className="path-axis-title" x={dims.left+plotWidth/2} y={dims.height-4} textAnchor="middle">TIME · EASTERN</text>
        <line className="path-reference datum" x1={dims.left} x2={dims.width-dims.right} y1={y(datum)} y2={y(datum)}/>
        {targetVisible?<line className="path-reference target" x1={dims.left} x2={dims.width-dims.right} y1={y(target)} y2={y(target)}/>:<g className="path-target-edge"><line x1={dims.left} x2={dims.width-dims.right} y1={targetAtTop?dims.top:dims.height-dims.bottom} y2={targetAtTop?dims.top:dims.height-dims.bottom}/><text x={dims.width-dims.right-6} y={targetAtTop?dims.top+14:dims.height-dims.bottom-7} textAnchor="end">TARGET {targetAtTop?"↑":"↓"} {target.toFixed(4)}</text></g>}
        {bars.map((bar,index)=><g className="minute-candle" key={`${bar.timestamp}-${index}`}><line x1={x(index)} x2={x(index)} y1={y(number(bar.high))} y2={y(number(bar.low))}/><line className="open-tick" x1={x(index)-5} x2={x(index)} y1={y(number(bar.open))} y2={y(number(bar.open))}/><line className="close-tick" x1={x(index)} x2={x(index)+5} y1={y(number(bar.close))} y2={y(number(bar.close))}/></g>)}
        <path className="minute-high-line" d={highPath}/><path className="minute-low-line" d={lowPath}/><path className="minute-close-line" d={closePath}/>
        {hovered&&<line className="path-crosshair" x1={x(hovered.index)} x2={x(hovered.index)} y1={dims.top} y2={dims.height-dims.bottom}/>}
      </svg>
      {hovered&&<div className="alert-path-tooltip" style={{left:`${hovered.leftPct}%`}}><b>{logDate(hovered.bar.timestamp)} · {logTime(hovered.bar.timestamp)}</b><span>OPEN {number(hovered.bar.open).toFixed(4)} <i>{diff(hovered.bar.open)}</i></span><span>HIGH {number(hovered.bar.high).toFixed(4)} <i>{diff(hovered.bar.high)}</i></span><span>LOW {number(hovered.bar.low).toFixed(4)} <i>{diff(hovered.bar.low)}</i></span><span>CLOSE {number(hovered.bar.close).toFixed(4)} <i>{diff(hovered.bar.close)}</i></span></div>}
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
    <div className="target-evaluation-row">
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
      <div className="call-id-combobox"><label><span>CALL ID</span><input value={query} maxLength="19" inputMode="numeric" onFocus={()=>setPickerOpen(true)} onChange={event=>{setQuery(event.target.value.replace(/\D/g,"").slice(0,19));setSelectedId("");setLookedUpCall(null);setPickerOpen(true);setLookupError("")}} onKeyDown={event=>{if(event.key==="Enter")lookup();if(event.key==="Escape")setPickerOpen(false)}} placeholder="YYYYMMDDHHMMSSmmmss"/></label><button type="button" className="picker-toggle" onClick={()=>setPickerOpen(value=>!value)} aria-label="Show matching call IDs">⌄</button>{pickerOpen&&<div className="call-id-menu">{matchingCalls.slice(0,30).map(call=>{const parts=easternFilterParts(call.alerted_at),id=visibleCallId(call,system);return <button type="button" key={call.id} onMouseDown={event=>event.preventDefault()} onClick={()=>selectCall(call)}><b>{id}</b><span>{parts.date} · {parts.time} ET</span><small>{call.status} · {biasLabel(call.direction)}</small></button>})}{!matchingCalls.length&&<p>No loaded calls match these filters.</p>}</div>}</div>
      <label className="finder-filter"><span>DATE · EASTERN</span><input type="date" value={dateFilter} onChange={event=>{setDateFilter(event.target.value);setSelectedId("");setLookedUpCall(null);setPickerOpen(true)}}/></label>
      <label className="finder-filter"><span>TIME · EASTERN</span><input type="time" step="1" value={timeFilter} onChange={event=>{setTimeFilter(event.target.value);setSelectedId("");setLookedUpCall(null);setPickerOpen(true)}}/></label>
      <button type="button" onClick={lookup}>FIND EXACT ID</button><button type="button" onClick={()=>{setQuery("");setDateFilter("");setTimeFilter("");setSelectedId("");setLookedUpCall(null);setPickerOpen(false);setLookupError("")}}>ALL CALLS</button>{lookupError&&<small>{lookupError}</small>}
    </div>
    <div className="outcome-method"><b>Reading the path:</b> datum is fixed at the alert price. Each candle is observed OHLC for one minute. {symbol==="QQQ"?"The target is the configured QQQ equivalent of a 50-point NQ move (default 1.235 QQQ points); it is explicitly an estimate until synchronized NQ data is connected.":`The target is exactly 50 ${symbol} points.`} The path expires at the displayed Eastern deadline. Post-expiry prices never count.</div>
    <div className="fifty-point-scroll">{filteredCalls.map(call=><FiftyPointOutcomeCard key={call.id} call={call} system={system}/>)}{!filteredCalls.length&&<div className="empty-state">{normalized?"No loaded call ID matches. Enter the complete ID and select FIND to query Postgres.":data?.unavailable?"Outcome tracking is waiting for the updated Render backend. The rest of the dashboard remains live.":`No qualified ${SYSTEM_OUTCOME_LABELS[system]} decisions have started tracking yet.`}</div>}</div>
    <footer><span>Price source: {source.replaceAll("_"," ")}</span><span>Visible clocks: America/New_York (Eastern), 12-hour format.</span><span>Calls that do not reach their displayed directional target are explicitly TRACKING or EXPIRED.</span></footer>
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

export default function Home() {
  const [view,setView]=useState("Overview"), [symbol,setSymbol]=useState("QQQ"), [resolution,setResolution]=useState(5);
  const [dashboard,setDashboard]=useState({history:[],alerts:[],engine:{},performance:{}}), [system,setSystem]=useState(null), [config,setConfig]=useState(null);
  const [chartHistory,setChartHistory]=useState([]);
  const [attribution,setAttribution]=useState({systems:{}});
  const [connected,setConnected]=useState(false), [toast,setToast]=useState(""), [replay,setReplay]=useState(null);
  const [instruments,setInstruments]=useState(FALLBACK_INSTRUMENTS);
  const [activeSection,setActiveSection]=useState("decision"),[clock,setClock]=useState(Date.now());
  const [moduleOrder,setModuleOrder]=useState(()=>{try{const saved=JSON.parse(window.localStorage.getItem("axiom-overview-module-order")??"null");return Array.isArray(saved)&&saved.length===DEFAULT_MODULE_ORDER.length&&DEFAULT_MODULE_ORDER.every(id=>saved.includes(id))?saved:DEFAULT_MODULE_ORDER}catch{return DEFAULT_MODULE_ORDER}}),[draggedModule,setDraggedModule]=useState(null),[dragOverModule,setDragOverModule]=useState(null);
  const state=dashboard.state, history=dashboard.history??[], alerts=dashboard.alerts??[], engine=dashboard.engine??{}, performance=dashboard.performance??{};
  const notify=text=>{setToast(text);window.setTimeout(()=>setToast(""),2600)};
  const refresh=async(signal)=>{try{const [dash,sys,cfg,outcomes]=await Promise.all([fetchDashboard(symbol,signal),fetchSystem(signal),fetchConfiguration(signal),fetchOutcomeAttribution(symbol,signal).catch(error=>{if(error.name==="AbortError")throw error;return {symbol,systems:{},unavailable:true,error:error.message}})]);setDashboard(dash);setAttribution(outcomes);setChartHistory(current=>[...new Map([...current,...(dash.history??[])].map(row=>[row.timestamp,row])).values()].sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp)).slice(-5000));setSystem(sys);setConfig(cfg);setConnected(true)}catch(error){if(error.name!=="AbortError"){setConnected(false);notify(error.message)}}};
  useEffect(()=>{const controller=new AbortController();refresh(controller.signal);const id=window.setInterval(()=>refresh(controller.signal),5000);return()=>{controller.abort();clearInterval(id)}},[symbol]);
  useEffect(()=>{const controller=new AbortController();fetchStateHistory(symbol,5000,controller.signal).then(rows=>setChartHistory([...rows].reverse())).catch(error=>{if(error.name!=="AbortError")setChartHistory([])});return()=>controller.abort()},[symbol]);
  useEffect(()=>{const controller=new AbortController();fetchInstruments(controller.signal).then(setInstruments).catch(()=>{});return()=>controller.abort()},[]);
  useEffect(()=>{const id=window.setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(id)},[]);
  const orderedOverviewSections=[OVERVIEW_SECTIONS[0],...moduleOrder.map(id=>[OVERVIEW_LABELS[id],id])];
  useEffect(()=>{if(view!=="Overview")return;const sections=orderedOverviewSections.map(([,id])=>document.getElementById(id)).filter(Boolean);const observer=new IntersectionObserver(entries=>{const visible=entries.filter(entry=>entry.isIntersecting).sort((a,b)=>b.intersectionRatio-a.intersectionRatio)[0];if(visible)setActiveSection(visible.target.id)},{rootMargin:"-18% 0px -68% 0px",threshold:[0,.2,.5,.8]});sections.forEach(section=>observer.observe(section));return()=>observer.disconnect()},[view,moduleOrder]);
  useEffect(()=>{window.localStorage.setItem("axiom-overview-module-order",JSON.stringify(moduleOrder))},[moduleOrder]);
  useEffect(()=>subscribeToEvents(message=>{if(message.topic==="market_state"){setDashboard(current=>({...current,state:message.payload,history:[...(current.history??[]),message.payload].slice(-120)}));setChartHistory(current=>[...current.filter(row=>row.timestamp!==message.payload.timestamp),message.payload].slice(-5000))}if(message.topic==="alert")setDashboard(current=>({...current,alerts:[toDashboardAlert(message.payload),...(current.alerts??[])].slice(0,100)}));if(message.topic==="outcome")setDashboard(current=>({...current,alerts:(current.alerts??[]).map(alert=>alert.id===message.payload.alert_id?{...alert,result:number(message.payload.precision)>=.7?"SUCCESS":"FAILURE",precision:number(message.payload.precision).toFixed(2)}:alert)}));if(message.topic==="engine_status"){setDashboard(current=>({...current,engine:message.payload}));setSystem(current=>current?{...current,engine:message.payload}:current)}if(message.topic==="system_event")setSystem(current=>current?{...current,events:[message.payload,...(current.events??[])].slice(0,25)}:current);if(message.topic==="replay_status")setReplay(message.payload)},setConnected),[]);
  useEffect(()=>{if(!replay?.id||replay.status!=="running")return;const id=setInterval(()=>fetchReplay(replay.id).then(setReplay).catch(()=>{}),2000);return()=>clearInterval(id)},[replay?.id,replay?.status]);
  const toggle=async()=>{try{if(engine.running){await stopLiveEngine();notify("Live engine stopping")}else{await startLiveEngine(symbol,resolution);notify(`Live engine started for ${symbol}`)}await refresh()}catch(error){notify(error.message)}};
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
  return <main className={`workspace focus-${focusTone}`}><header className="topbar"><div className="brand"><div className="brandmark"><span/><span/><span/></div><div><b>AXIOM</b><small>PRESSURE INTELLIGENCE</small></div></div><nav className="mode-switch" aria-label="Engine mode"><button className={view!=="Historical Replay"?"active":""} onClick={()=>setView("Overview")}>Live engine</button><button className={view==="Historical Replay"?"active":""} onClick={()=>setView("Historical Replay")}>Training replay</button></nav><label className="section-jump"><span>Section</span><select value={activeSection} onChange={event=>jumpTo(event.target.value)}>{orderedOverviewSections.map(([label,id])=><option value={id} key={id}>{OVERVIEW_NUMBERS[id]} · {label}</option>)}</select></label><div className="header-actions status-cluster" aria-live="polite"><span className={`status-chip ${connected?"is-good":"is-bad"}`}>API <b>{connected?"ONLINE":"OFFLINE"}</b></span><span className={`status-chip ${engine.running?"is-good":"is-idle"}`}>ENGINE <b>{engine.running?"ON":"IDLE"}</b></span><span className={`status-chip ${dataFresh?"is-good":dataDelayed?"is-bad":"is-idle"}`}>DATA <b>{dataFresh?`${stateAge}s`:dataDelayed?"STALE":"IDLE"}</b></span></div></header>
    <aside className="sidebar"><div className="side-top"><div className="nav-context"><span>WORKSPACE</span><b>Live Overview</b><small>Decision → models → evidence</small></div><div className="nav-section-label"><span>NAVIGATION</span><b>{orderedOverviewSections.length} SECTIONS</b></div><nav className="overview-subnav" aria-label="Overview sections">{orderedOverviewSections.map(([label,section],index)=><button className={activeSection===section?"active":""} aria-current={activeSection===section?"location":undefined} key={section} onClick={()=>jumpTo(section)}><b>{String(index+1).padStart(2,"0")}</b><span><strong>{label}</strong><small>{OVERVIEW_CATEGORIES[section]}</small></span></button>)}</nav><div className="layout-actions"><button type="button" onClick={()=>setAllSections(true)}>Expand all</button><button type="button" onClick={()=>setAllSections(false)}>Collapse all</button></div><button type="button" className="reset-layout" onClick={()=>{setModuleOrder(DEFAULT_MODULE_ORDER);notify("Overview order reset")}}>↺ Reset section order</button></div><div className="side-bottom"><div className={`system-health ${system?.database_connected?"is-good":"is-bad"}`}><span><i/>{system?.database_connected?"System healthy":"System degraded"}</span><small>v{config?.version??"—"} · Render</small></div></div></aside>
    <section className="content">{view!=="Overview"?<ModulePage {...{view,state,history,alerts,performance,system,config,replay,onReplay:runReplay,notify}}/>:<><div id="overview-top" className="page-head overview-command overview-section"><div><div className="eyebrow">LIVE TRADING COMMAND</div><h1>Pressure intelligence</h1><p>Options-derived directional pressure with independent price confirmation.</p></div><div className="controls"><label>Instrument<select value={symbol} disabled={engine.running} onChange={e=>setSymbol(e.target.value)}>{instruments.map(item=><option value={item.symbol} key={item.symbol}>{item.symbol}</option>)}</select><small className={selectedInstrument?.available?"provider-ready":"provider-missing"}>{selectedInstrument?.provider}{selectedInstrument?.requirement?` · ${selectedInstrument.requirement}`:""}</small></label><label>Update interval<select value={resolution} onChange={e=>setResolution(Number(e.target.value))}><option value="5">5 seconds</option><option value="15">15 seconds</option><option value="60">1 minute</option></select></label><button className={engine.running?"stop":"start"} disabled={!engine.running&&!selectedInstrument?.available} onClick={toggle}><i/>{engine.running?"Stop live engine":selectedInstrument?.available?"Start live engine":"Feed required"}</button></div></div>
    <OverviewSectionHeading number="01" title="One-screen focus" description="The complete options-pressure decision and every active gate in one view."/>
    <FocusView state={state} symbol={symbol} engine={engine} decision={focusDecision} lastQualifiedAlert={lastQualifiedAlert} clock={clock}/>
    <div className="reorderable-overview" aria-label="Draggable Overview modules">
    <DraggableOverviewModule id="gamma-dynamics" index={moduleOrder.indexOf("gamma-dynamics")} {...draggableProps}><OverviewDisclosure id="gamma-dynamics" title="Gamma Dynamics Quartet" description="Zomma/Color intensity · Speed/Gamma signed curvature pressure"><GammaDynamicsModule state={state} history={visualHistory} symbol={symbol} engine={engine}/><article className="panel chart-panel triad-history-panel"><GammaDynamicsChart history={visualHistory} state={state} symbol={symbol}/></article><GammaDynamicsLog history={visualHistory} state={state} symbol={symbol} calls={attribution?.systems?.GAMMA_DYNAMICS?.calls??[]}/><OutcomeAttributionMini system="GAMMA_DYNAMICS" data={attribution} symbol={symbol}/></OverviewDisclosure></DraggableOverviewModule>
    <DraggableOverviewModule id="six-greek-dynamics" index={moduleOrder.indexOf("six-greek-dynamics")} {...draggableProps}><OverviewDisclosure id="six-greek-dynamics" title="Delta Dynamics" description="Normalized Ultima · Zomma · Gamma · Speed · Color · Delta zone formulas"><SixGreekDynamicsModule state={state} history={visualHistory} symbol={symbol} engine={engine}/><article className="panel chart-panel triad-history-panel"><GammaDynamicsChart history={visualHistory} state={state} symbol={symbol} deltaMode/></article><DeltaDynamicsEventLog history={visualHistory} state={state} symbol={symbol} calls={attribution?.systems?.DELTA_DYNAMICS?.calls??[]}/><OutcomeAttributionMini system="DELTA_DYNAMICS" data={attribution} symbol={symbol}/></OverviewDisclosure></DraggableOverviewModule>
    <DraggableOverviewModule id="forecast" index={moduleOrder.indexOf("forecast")} {...draggableProps}><OverviewDisclosure id="forecast" title="Experimental Forecast" description="Research-only 5-minute / 30-point probability model"><FiveMinuteForecast history={visualHistory} state={state} symbol={symbol}/></OverviewDisclosure></DraggableOverviewModule>
    <DraggableOverviewModule id="score-modules" index={moduleOrder.indexOf("score-modules")} {...draggableProps}><OverviewDisclosure id="score-modules" title="Signal Scores" description="Explosion, Direction, Pressure, and score histories"><div className="metric-grid live-metric-grid score-three"><ExplosionCard state={state} history={history}/><DirectionCard state={state}/><article className={`metric pressure-card ${number(state?.pressure?.value)>0.15?"pressure-buy":number(state?.pressure?.value)<-0.15?"pressure-sell":"pressure-watch"}`}><header><span>PRESSURE STATE</span><span className="pressure-live-badge">● {engine.running?"LIVE":"IDLE"}</span></header><div className="pressure-state"><i/><div><b>{number(state?.pressure?.value)>0.15?"BUY PRESSURE":number(state?.pressure?.value)<-0.15?"SELL PRESSURE":"BUILDING"}</b><span>{state?.pressure?.explanation??"Waiting for ThetaData"}</span></div></div><div className="pressure-confirmations"><span className={optionsDecision.checks.pressure_alignment?"confirmed":"waiting"}>Bias {optionsDecision.checks.pressure_alignment?"aligned":"waiting"}</span><span className={optionsDecision.checks.risk?"confirmed":"blocked"}>Risk {optionsDecision.checks.risk?"clear":"blocked"}</span></div><footer><span>Signed pressure</span><b>{number(state?.pressure?.value).toFixed(2)}</b></footer></article></div><div className="score-history-grid"><article className="panel chart-panel"><ScoreTimeChart history={visualHistory} state={state} symbol={symbol} metric="explosion"/></article><article className="panel chart-panel"><ScoreTimeChart history={visualHistory} state={state} symbol={symbol} metric="direction"/></article></div><OutcomeAttributionMini system="PRIMARY_OPTIONS" data={attribution} symbol={symbol}/></OverviewDisclosure></DraggableOverviewModule>
    <DraggableOverviewModule id="greek-orders" index={moduleOrder.indexOf("greek-orders")} {...draggableProps}><OverviewDisclosure id="greek-orders" title="Greek Orders" description="First-, second-, and third-order streamed exposures"><article className="panel chart-panel"><GreekOrderChart history={visualHistory} state={state} symbol={symbol}/></article></OverviewDisclosure></DraggableOverviewModule>
    <DraggableOverviewModule id="custom-greeks" index={moduleOrder.indexOf("custom-greeks")} {...draggableProps}><OverviewDisclosure id="custom-greeks" title="Custom Greek Graphs" description="Up to ten configurable live charts"><CustomGreekWorkspace history={visualHistory} state={state} symbol={symbol}/></OverviewDisclosure></DraggableOverviewModule>
    <DraggableOverviewModule id="live-alerts" index={moduleOrder.indexOf("live-alerts")} {...draggableProps}><OverviewDisclosure id="live-alerts" title="Live Options Pro Bias Alerts" description="Qualified primary-engine decisions"><article className="panel alerts-panel"><header className="panel-head table-head"><div><span>LIVE OPTIONS PRO BIAS ALERTS</span><h2>Every call displays its observed one-minute high/low path from datum to the displayed directional target</h2></div></header><div className="table-wrap"><table><thead><tr><th>ALERT ID</th><th>DATE · EASTERN</th><th>TIME · MS</th><th>INSTRUMENT</th><th>PRICE</th><th>BIAS</th><th>EXPLOSION</th><th>DIR. SCORE</th><th>PRESSURE</th><th>OPTIONS CONF.</th><th>SESSION</th><th>REGIME</th><th>RISK</th></tr></thead><tbody>{liveBiasAlerts.map(a=>{const alertId=visibleEventId(a);return <Fragment key={a.id}><tr className="alert-primary-row"><td><button type="button" className="call-id" onClick={()=>navigator.clipboard.writeText(alertId)} title="Copy alert ID">{alertId}</button></td><td>{logDate(a.timestamp)}</td><td>{logTime(a.timestamp)}</td><td><b>{a.symbol}</b></td><td>{Number.isFinite(a.rawPrice)?a.rawPrice.toFixed(4):a.price}</td><td><span className={`direction-pill ${a.direction.toLowerCase()}`}>{biasLabel(a.direction)}</span></td><td>{a.explosion}</td><td>{a.score}</td><td>{a.pressure>0?"+":""}{number(a.pressure).toFixed(2)}</td><td>{pct(a.confidence)}</td><td>{pretty(a.session)}<small>{pretty(a.sessionState)} · {a.sessionConfidence.toFixed(0)}%</small></td><td>{a.regime}</td><td>{pretty(a.risk)}</td></tr><tr className="alert-outcome-row"><td colSpan="13"><details open><summary><span>↳ OBSERVED NQ-EQUIVALENT OUTCOME</span><b>1-MINUTE HIGH / LOW · PRICE VS EASTERN TIME</b></summary><AlertOutcomeRows alert={a} calls={primaryOutcomeCalls}/></details></td></tr></Fragment>})}</tbody></table>{!liveBiasAlerts.length&&<div className="empty-state">WAIT · no confirmed Options Pro episode has completed its entry sequence yet.</div>}</div></article></OverviewDisclosure></DraggableOverviewModule>
    </div></>}
    <footer className="disclaimer">Signal intelligence only · No broker execution enabled <span>Last persisted state {time(state?.timestamp)}</span></footer></section>{toast&&<div className="toast">✓ {toast}</div>}</main>;
}
