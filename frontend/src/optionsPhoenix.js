import { PHOENIX_PERIODS } from "./priceCharmander.js";

const clamp=(value,low,high)=>Math.max(low,Math.min(high,value));
const finite=value=>value===null||value===undefined||value===""?NaN:Number(value);
const median=values=>{const sorted=[...values].sort((a,b)=>a-b);return sorted.length?sorted[Math.floor((sorted.length-1)/2)]:NaN};
const quantile=(values,fraction)=>{const sorted=[...values].sort((a,b)=>a-b),position=(sorted.length-1)*fraction,low=Math.floor(position),high=Math.ceil(position);return sorted.length?sorted[low]+(sorted[high]-sorted[low])*(position-low):NaN};

/** ETF research overlay. GEX balance is a call/put OI proxy, not observed dealer inventory. */
export function computeOptionsPhoenix(pricePhoenix,bars,bucketSeconds){
  const count=pricePhoenix.timestamps.length;
  const valid=new Array(count).fill(false),dexReady=new Array(count).fill(false),dexSource=new Array(count).fill(null);
  const gexBalance=new Float32Array(count),dexImpulse=new Float32Array(count);
  const residualHistory={SIGNED:[],BALANCE:[]};
  for(let i=0;i<count;i+=1){
    const bar=bars[i],at=Date.parse(bar?.timestamp??""),optionsAt=Date.parse(bar?.options_at??""),signedDex=finite(bar?.dex_signed_raw),dexBalance=finite(bar?.dex_imbalance_pct),gex=finite(bar?.gex_imbalance_pct);
    // Fall-back DST can make a calendar bucket one elapsed hour longer.
    valid[i]=Number.isFinite(at)&&Number.isFinite(optionsAt)&&optionsAt>=at&&optionsAt<at+bucketSeconds*1000+3_600_000&&(Number.isFinite(signedDex)||Number.isFinite(dexBalance))&&Number.isFinite(gex);
    if(!valid[i])continue;
    gexBalance[i]=clamp(gex/100,-1,1);
    const previous=bars[i-1],priorDex=finite(previous?.dex_signed_raw),priorBalance=finite(previous?.dex_imbalance_pct),priorPrice=finite(previous?.spot),price=finite(bar?.spot),gap=at-Date.parse(previous?.timestamp??"");
    if(i===0||!valid[i-1]||priorPrice<=0||price<=0||gap>bucketSeconds*1500||gap<=0)continue;
    const useSigned=Number.isFinite(signedDex)&&Number.isFinite(priorDex);
    if(!useSigned&&(!Number.isFinite(dexBalance)||!Number.isFinite(priorBalance)))continue;
    // Signed DEX removes its direct spot multiplier. Older Supabase rows have
    // only directional balance; its change is a less precise fallback.
    const source=useSigned?"SIGNED":"BALANCE";
    const residual=useSigned
      ?(signedDex-priorDex*price/priorPrice)/Math.max(Math.abs(signedDex),Math.abs(priorDex),1)
      :(dexBalance-priorBalance)/100;
    const history=residualHistory[source],scale=Math.max(source==="SIGNED" ? .0002 : .002,3*median(history.slice(-30).map(Math.abs))||0);
    dexImpulse[i]=Math.tanh(residual/scale);
    history.push(residual);
    dexReady[i]=true;
    dexSource[i]=source;
  }
  const series=PHOENIX_PERIODS.map((period,strand)=>{
    const output=new Float32Array(count),alpha=2/(period+1);let smoothedDex=0;
    for(let i=0;i<count;i+=1){
      const price=pricePhoenix.series[strand][i];
      if(!valid[i]){smoothedDex=0;output[i]=price;continue}
      smoothedDex+=alpha*((dexReady[i]?dexImpulse[i]:0)-smoothedDex);
      const gammaGain=clamp(1-.20*gexBalance[i],.8,1.2);
      output[i]=clamp((.75*price+.25*smoothedDex)*gammaGain,-1,1);
    }
    return output;
  });
  const consensus=Float32Array.from({length:count},(_,i)=>series.reduce((sum,line)=>sum+line[i],0)/series.length);
  const breadth=Float32Array.from({length:count},(_,i)=>series.reduce((sum,line)=>sum+(line[i]>0?1:0),0)/series.length);
  return {series,consensus,breadth,valid,dexReady,dexSource,gexBalance,dexImpulse};
}

/** Compare only completed, continuous historical candles with known next closes. */
export function nextCandleOutlook(bars,overlay,bucketSeconds,{now=Date.now()}={}){
  const unavailable=reason=>({status:"UNAVAILABLE",reason});
  const current=bars.findLastIndex(bar=>bar?.is_confirmed);
  if(current<0||!overlay.valid[current]||!overlay.dexReady[current])return unavailable("Waiting for aligned price and options candles");
  const source=bars[current],asOf=Date.parse(source.options_at??"");
  const liveOptionsAt=bars.reduce((latest,bar,i)=>{const at=Date.parse(bar?.options_at??"");return overlay.valid[i]&&Number.isFinite(at)&&at<=now?Math.max(latest,at):latest},-Infinity);
  if(!Number.isFinite(asOf)||now<asOf||now-asOf>bucketSeconds*1000+120_000||now-liveOptionsAt>120_000)return unavailable("Options snapshot is stale");
  const candidates=[];
  for(let i=30;i<current;i+=1){
    const present=bars[i],next=bars[i+1],gap=Date.parse(next?.timestamp??"")-Date.parse(present?.timestamp??""),base=finite(present?.close),close=finite(next?.close);
    if(!present?.is_confirmed||!next?.is_confirmed||!overlay.valid[i]||!overlay.dexReady[i]||!Number.isFinite(gap)||gap<=0||gap>bucketSeconds*1500||base<=0||close<=0)continue;
    const distance=.55*Math.abs(overlay.consensus[i]-overlay.consensus[current])+.25*Math.abs(overlay.dexImpulse[i]-overlay.dexImpulse[current])+.10*Math.abs(overlay.gexBalance[i]-overlay.gexBalance[current])+.10*Math.abs(overlay.breadth[i]-overlay.breadth[current]);
    candidates.push({distance,return:(close-base)/base});
  }
  if(candidates.length<25)return unavailable(`Need 25 completed comparable outcomes; ${candidates.length} available`);
  const analogs=candidates.sort((a,b)=>a.distance-b.distance).slice(0,Math.min(40,Math.max(25,Math.floor(candidates.length/2))));
  if(median(analogs.map(item=>item.distance))>.45)return unavailable("No sufficiently similar historical candles");
  const returns=analogs.map(item=>item.return),upCount=returns.filter(value=>value>0).length,upShare=upCount/returns.length,medianReturn=quantile(returns,.5),base=finite(source.close);
  const direction=upShare>=.62&&medianReturn>0?"UP":upShare<=.38&&medianReturn<0?"DOWN":"NO EDGE";
  return {status:"READY",direction,asOf:source.timestamp,base,median:base*(1+medianReturn),low:base*(1+quantile(returns,.2)),high:base*(1+quantile(returns,.8)),upCount,samples:returns.length,gexBalance:overlay.gexBalance[current],dexImpulse:overlay.dexImpulse[current],consensus:overlay.consensus[current]};
}
