export const CANDLE_TIMEFRAMES={"1M":60,"5M":300,"15M":900,"30M":1800,"1H":3600,"2H":7200,"4H":14400,"6H":21600};

const formatters=new Map();
const formatter=timeZone=>{
  if(!formatters.has(timeZone))formatters.set(timeZone,new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}));
  return formatters.get(timeZone);
};
const parts=(value,timeZone)=>Object.fromEntries(formatter(timeZone).formatToParts(new Date(value)).filter(part=>part.type!=="literal").map(part=>[part.type,Number(part.value)]));
const localEpoch=value=>Date.UTC(value.year,value.month-1,value.day,value.hour,value.minute,value.second||0);
const localToUtc=(value,timeZone)=>{
  const target=localEpoch(value);let guess=target;
  for(let pass=0;pass<4;pass+=1){const observed=parts(guess,timeZone),delta=target-localEpoch(observed);if(!delta)break;guess+=delta}
  const exact=[];const after=[];
  for(let offset=-4;offset<=4;offset+=1){const candidate=guess+offset*3600000,observed=parts(candidate,timeZone),wall=localEpoch(observed);if(wall===target)exact.push(candidate);else if(wall>target)after.push([wall-target,candidate])}
  if(exact.length)return Math.min(...exact);
  // A nonexistent spring-forward wall time (for example 02:00) advances to
  // the first real exchange-clock boundary after the gap (03:00), matching
  // pandas/TradingView calendar resampling rather than falling back to 01:00.
  if(after.length)return after.sort((a,b)=>a[0]-b[0]||a[1]-b[1])[0][1];
  return guess;
};
const secondsFor=timeframe=>{
  if(typeof timeframe==="number")return timeframe;
  const seconds=CANDLE_TIMEFRAMES[String(timeframe).toUpperCase()];
  if(!seconds)throw new Error(`Unsupported candle timeframe: ${timeframe}`);
  return seconds;
};
const trimmedAverage=values=>{const ordered=values.filter(Number.isFinite).sort((a,b)=>a-b);if(!ordered.length)return NaN;const trim=ordered.length>=10?Math.floor(ordered.length*.1):0,kept=trim?ordered.slice(trim,-trim):ordered;return kept.reduce((sum,value)=>sum+value,0)/kept.length};

export function getCandles(rows=[],timeframe,numCandles=150,{exchangeTimeZone="America/New_York",now=Date.now(),lastFields=[],averageFields=[]}={}){
  const interval=secondsFor(timeframe),minutes=interval/60,seen=new Map();
  rows.forEach(row=>{const at=Date.parse(row?.timestamp||"");if(!Number.isFinite(at))return;const tradeId=row?.trade_id??row?.tradeId??"",key=`${at}:${tradeId}`;seen.set(key,{...row,__at:at})});
  const buckets=new Map();
  [...seen.values()].sort((a,b)=>a.__at-b.__at).forEach(row=>{
    const local=parts(row.__at,exchangeTimeZone),minuteOfDay=local.hour*60+local.minute,session=minuteOfDay<570?"PRE":minuteOfDay<960?"RTH":"POST",bucketMinute=Math.floor(minuteOfDay/minutes)*minutes,bucketHour=Math.floor(bucketMinute/60),minute=bucketMinute%60,dateKey=`${local.year}-${String(local.month).padStart(2,"0")}-${String(local.day).padStart(2,"0")}`,key=`${dateKey}:${session}:${bucketHour}:${minute}`;
    const fallback=Number(row.spot??row.price??row.close),open=Number.isFinite(Number(row.open))?Number(row.open):fallback,high=Number.isFinite(Number(row.high))?Number(row.high):fallback,low=Number.isFinite(Number(row.low))?Number(row.low):fallback,close=Number.isFinite(Number(row.close))?Number(row.close):fallback,spot=Number.isFinite(Number(row.spot))?Number(row.spot):close,volume=Number(row.volume)||0;
    if(![open,high,low,close].every(Number.isFinite))return;
    const existing=buckets.get(key);
    const extras=Object.fromEntries(lastFields.filter(field=>row[field]!=null&&row[field]!==""&&Number.isFinite(field==="options_at"?Date.parse(row[field]):Number(row[field]))).map(field=>[field,row[field]]));
    const averages=Object.fromEntries(averageFields.map(field=>[field,row[field]==null||row[field]===""?[]:[Number(row[field])].filter(Number.isFinite)]));
    if(!existing){const timestamp=localToUtc({year:local.year,month:local.month,day:local.day,hour:bucketHour,minute,second:0},exchangeTimeZone);buckets.set(key,{timestamp,open,high,low,close,volume,session,spots:[spot],averageValues:averages,samples:Number(row.samples)||1,lastAt:row.__at,...extras})}
    else{existing.high=Math.max(existing.high,high);existing.low=Math.min(existing.low,low);existing.close=close;existing.volume+=volume;existing.spots.push(spot);existing.samples+=Number(row.samples)||1;existing.lastAt=row.__at;for(const field of averageFields)existing.averageValues[field].push(...averages[field]);Object.assign(existing,extras)}
  });
  const result=[...buckets.values()].sort((a,b)=>a.timestamp-b.timestamp).map(bucket=>{
    const local=parts(bucket.timestamp,exchangeTimeZone),endMinute=Math.min(1440,local.hour*60+local.minute+minutes),sessionEnd=bucket.session==="PRE"?570:bucket.session==="RTH"?960:1440,cappedEnd=Math.min(endMinute,sessionEnd),nextDay=cappedEnd>=1440,endTimestamp=localToUtc({year:local.year,month:local.month,day:local.day+(nextDay?1:0),hour:nextDay?0:Math.floor(cappedEnd/60),minute:nextDay?0:cappedEnd%60,second:0},exchangeTimeZone);
    return {timestamp:new Date(bucket.timestamp).toISOString(),at:bucket.timestamp,open:bucket.open,high:bucket.high,low:bucket.low,close:bucket.close,spot:trimmedAverage(bucket.spots),volume:bucket.volume,session:bucket.session,samples:bucket.samples,is_confirmed:Number(now)>=endTimestamp,...Object.fromEntries(lastFields.filter(field=>bucket[field]!=null).map(field=>[field,bucket[field]])),...Object.fromEntries(averageFields.map(field=>[field,bucket.averageValues[field].length?trimmedAverage(bucket.averageValues[field]):null]))};
  });
  return result.slice(-Math.max(1,Number(numCandles)||150));
}
