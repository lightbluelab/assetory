async function autoFetchFx(){
  const curs=usedCurrencies().filter(c=>c!=="CNY");
  if(!curs.length){ setStatus("本月没有需要换算的外币"); return; }
  const dateStr=ymd(targetDate(activeMonth));
  const symbols=[...new Set([...curs,"CNY"])].filter(c=>c!=="USD").join(",");
  setStatus("获取汇率中…");
  try{
    const res=await fetch(`https://api.frankfurter.dev/v1/${dateStr}?base=USD&symbols=${symbols}`);
    const data=await res.json();
    const usdTo=data.rates||{};
    const usdToCNY=usdTo.CNY;
    if(!(usdToCNY>0)) throw new Error("无CNY汇率");
    const updates={}, statuses={};
    curs.forEach(c=>{
      if(c==="CNY") return;
      if(c==="USD"){ updates.USD=Math.round(usdToCNY*1000)/1000; statuses.USD="ok"; return; }
      const usdToX=usdTo[c];
      if(usdToX>0){ updates[c]=Math.round(usdToCNY/usdToX*1000)/1000; statuses[c]="ok"; }
      else statuses[c]="warn";
    });
    const ok=await transact("更新汇率",()=>{ const fx=curFx(); fx._status={...(fx._status||{}),...statuses}; fx._date=data.date||dateStr; Object.assign(fx,updates,{CNY:1}); });
    if(ok) setStatus(`汇率已按 ${data.date||dateStr} 更新`);
  }catch(e){
    const recorded=await transact("记录汇率获取失败",()=>{ const fx=curFx(); fx._status=fx._status||{}; curs.forEach(c=>fx._status[c]="warn"); });
    if(recorded) setStatus("汇率自动获取失败: "+e.message+"（请手动填写）");
  }
}


// ---------- 股价自动更新（腾讯；美股历史报价回退新浪） ----------
function ymd(d){ return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }
// 目标日期: 当月月末与今天取较早者(未到月末→今天)
function targetDate(monthKey){
  const [y,mo]=monthKey.split("-").map(Number);
  const monthEnd=new Date(y,mo,0);
  const today=new Date();
  return (monthEnd<today?monthEnd:today);
}
function isCurMonth(monthKey){
  const now=new Date();
  return monthKey===now.getFullYear()+"-"+String(now.getMonth()+1).padStart(2,"0");
}
// 从日线数组中挑 <= 目标日 的最后一个交易日, 且必须贴近目标(避免落到远古数据)
function pickClose(rows, monthKey){
  const tgt=ymd(targetDate(monthKey));
  rows=(rows||[]).filter(r=>r.date && !isNaN(r.close));
  let pick=null;
  for(const r of rows){ if(r.date<=tgt) pick=r; else break; }
  if(!pick) throw new Error("目标日期前无交易数据");
  if(!(pick.close>0)) throw new Error("收盘价无效");
  const gap=(new Date(tgt)-new Date(pick.date))/86400000;
  if(gap>10) throw new Error(`最近交易日(${pick.date})距目标(${tgt})过远,数据缺失`);
  return { price:pick.close, date:pick.date };
}

function normalizedMarket(market){
  const raw=String(market||"").trim().toLowerCase().replace(/[\s._-]/g,"");
  if(["us","usa","美股","美国","美国股票","nasdaq","nyse","amex"].includes(raw)) return "us";
  if(["hk","港股","香港"].includes(raw)) return "hk";
  return "cn";
}
function normalizedUsSymbol(symbol){
  return String(symbol||"").trim().toUpperCase()
    .replace(/^(?:US|NASDAQ|NYSE|AMEX)[:.]/,"")
    .replace(/\.(?:US|O|N|AM)$/," ").trim();
}
// 腾讯代码: A股 sh600519 / sh510500 / 港股 hk00700 / 美股 usAAPL
function tencentCode(market, symbol){
  const s=(symbol||"").trim(); const m=normalizedMarket(market);
  if(m==="hk") return "hk"+s.replace(/\D/g,"").padStart(5,"0");
  if(m==="us") return "us"+normalizedUsSymbol(s);
  if(/^(sh|sz)/i.test(s)) return s.toLowerCase();
  // 沪市除 6 开头股票外，也包括 5 开头 ETF/基金和 9 开头 B 股。
  return (/^[569]/.test(s)?"sh":"sz")+s;
}
function parseTencentQuote(raw,fallbackDate=ymd(new Date())){
  if(Array.isArray(raw)) raw=raw.join("~");
  const fields=String(raw||"").split("~");
  const price=parseFloat(fields[3]);
  if(!Number.isFinite(price)||price<=0) return null;
  const quoteDate=(String(raw).match(/\d{4}-\d{2}-\d{2}/)||[])[0]||fallbackDate;
  return {price,date:quoteDate};
}
function quoteNearTarget(quote,monthKey){
  if(!quote?.date) return false;
  const target=ymd(targetDate(monthKey));
  const gap=(new Date(`${target}T00:00:00`)-new Date(`${quote.date}T00:00:00`))/86400000;
  return gap>=0&&gap<=10;
}
// 腾讯实时接口允许跨域读取，直接 fetch 比动态脚本注入更稳定，尤其适用于 PWA。
async function tencentRealtime(code){
  const res=await fetch(`https://qt.gtimg.cn/q=${encodeURIComponent(code)}`,{cache:"no-store"});
  if(!res.ok) throw new Error(`报价接口 HTTP ${res.status}`);
  const text=await res.text();
  const raw=text.match(/="([^"]*)"/)?.[1];
  const quote=parseTencentQuote(raw);
  if(!quote) throw new Error("无有效实时价格");
  return {...quote,src:"实时"};
}
// 腾讯日K线: 部分美股不提供 day 数组，但会在同一响应里提供最新收盘报价。
async function tencentKline(code, monthKey){
  const beg=monthKey+"-01", end=ymd(targetDate(monthKey));
  const url=`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,${beg},${end},40,bfq`;
  const res=await fetch(url);
  if(!res.ok) throw new Error(`腾讯日线 HTTP ${res.status}`);
  const data=await res.json();
  const node=data.data && data.data[code];
  const arr=(node && (node.day||node.qfqday))||[];
  if(arr.length){
    const rows=arr.map(r=>({date:r[0], close:parseFloat(r[2])}));
    return pickClose(rows,monthKey);
  }
  const quote=parseTencentQuote(node?.qt?.[code]);
  if(quoteNearTarget(quote,monthKey)) return {...quote,src:"月末报价"};
  throw new Error(quote?.date?`日线为空，报价日期 ${quote.date} 不适用于 ${monthKey}`:"腾讯无可用日线或报价");
}
// 新浪美股日线使用 JSONP，可在浏览器端跨域读取，作为腾讯未覆盖旧月份时的回退。
let sinaRequestQueue=Promise.resolve();
function sinaUsKline(symbol,monthKey){
  const request=sinaRequestQueue.then(()=>loadSinaUsKline(symbol,monthKey));
  sinaRequestQueue=request.catch(()=>{});
  return request;
}
function loadSinaUsKline(symbol,monthKey){
  return new Promise((resolve,reject)=>{
    const callback="__assetorySinaData";
    const script=document.createElement("script");
    let settled=false;
    // 新浪脚本通过全局 var 写入数据，该属性在严格模式下不可 delete，只能安全置空。
    const cleanup=()=>{ clearTimeout(timer); script.remove(); try{ window[callback]=undefined; }catch(error){ /* 全局 var 不可删除，置空失败也不影响报价结果 */ } };
    const fail=(message,error)=>{ cleanup(); reject(error instanceof Error?error:new Error(message)); };
    const succeed=rows=>{
      try{
        settled=true;
        cleanup();
        const parsed=(rows||[]).map(row=>({date:row.d,close:parseFloat(row.c)}));
        const result={...pickClose(parsed,monthKey),src:"新浪历史收盘"};
        resolve(result);
      }catch(error){ fail(`新浪历史报价无效：${error.message}`,error); }
    };
    const timer=setTimeout(()=>{ if(!settled) fail("新浪历史报价超时"); },30000);
    window[callback]=undefined;
    script.async=true;
    script.src=`https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20${callback}=/US_MinKService.getDailyK?symbol=${encodeURIComponent(normalizedUsSymbol(symbol))}&_=${Date.now()}`;
    script.onload=()=>{
      const rows=window[callback];
      if(!settled) Array.isArray(rows)?succeed(rows):fail("新浪历史报价响应格式无效");
    };
    script.onerror=event=>fail("新浪历史报价加载失败",new Error(String(event?.type||"script error")));
    document.head.appendChild(script);
  });
}
// 综合获取
async function fetchStockPrice(market, symbol, monthKey){
  const m=normalizedMarket(market);
  const code=tencentCode(market, symbol);
  // 当前月: 直接用实时价(最近交易日)
  if(isCurMonth(monthKey)){
    try{ return await tencentRealtime(code); }
    catch(e){ /* 落到历史逻辑 */ }
  }
  // 历史月统一走腾讯。美股在腾讯未覆盖目标月时，回退新浪 JSONP 日线。
  let out;
  if(m==="us"){
    try{ out=await tencentKline(code, monthKey); }
    catch(tencentError){
      try{ out=await sinaUsKline(symbol,monthKey); }
      catch(sinaError){
        throw new Error(`腾讯：${tencentError.message}；新浪：${sinaError.message}`);
      }
    }
  }else{
    out=await tencentKline(code, monthKey);
  }
  if(!(out && out.price>0)) throw new Error("未获取到有效收盘价");
  return out;
}
async function fetchStockUpdate(row,monthKey){
  const {price,date,src}=await fetchStockPrice(row.market,row.symbol,monthKey);
  if(!(price>0)) throw new Error("价格为0");
  return {price,date,priceAt:`${date}${src?"("+src+")":""}`};
}
function applyStockUpdate(month,row,result){
  row.price=result.price;
  row.priceStatus="ok";
  row.priceAt=result.priceAt;
  row.manualPriceAt=null;
}
async function updateOnePrice(idx){
  const m=ledger.months[activeMonth]; const r=m.balance[idx];
  if(!r.auto||!r.symbol){ alert("该条目未配置自动更新"); return; }
  setStatus(`获取 ${r.symbol} 价格中…`);
  try{
    const result=await fetchStockUpdate(r,activeMonth);
    const ok=await transact(`更新股价：${r.name}`,()=>applyStockUpdate(m,r,result));
    if(ok) setStatus(`${r.name} 已更新: ${result.price} @ ${result.date}`);
  }catch(e){
    const recorded=await transact(`记录股价获取失败：${r.name}`,()=>{ r.priceStatus="warn"; });
    if(recorded) setStatus(`${r.name} 自动获取失败(${e.message})，请手动填写`);
  }
}
async function updateAllPrices(){
  const m=ledger.months[activeMonth];
  const targets=m.balance.map((r,i)=>({r,i})).filter(x=>x.r.auto&&x.r.symbol);
  if(!targets.length){ setStatus("本月没有可自动更新的股价条目"); return; }
  const results=[];
  for(const {r,i} of targets){
    try{
      results.push({i,status:"ok",...await fetchStockUpdate(r,activeMonth)});
    }catch(e){ results.push({i,status:"warn",error:e.message}); }
  }
  const saved=await transact(`批量更新股价（成功 ${results.filter(result=>result.status==="ok").length}/${targets.length}）`,()=>results.forEach(result=>{
    const row=m.balance[result.i];
    if(!row) throw new Error("资产在更新期间已变化");
    if(result.status==="ok") applyStockUpdate(m,row,result); else row.priceStatus="warn";
  }));
  if(!saved) return;
  const ok=results.filter(x=>x.status==="ok").length;
  const failed=results.filter(x=>x.status!=="ok");
  const reason=failed.length?`；失败：${failed.map(x=>`${targets.find(t=>t.i===x.i)?.r.name||"未知资产"}（${x.error||"无返回"}）`).join("；")}`:"";
  setStatus(`股价更新完成: 成功 ${ok}/${targets.length}${reason}`);
}
