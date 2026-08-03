function contributionGroup(row){
  const prefix=row.cls==="liability"?"负债":"资产";
  return prefix+"·"+(row.group||ASSET_CLASSES[row.cls]?.name||"未分组");
}
function balanceTotals(balance,fxRates){
  let net=0, assets=0, liab=0;
  (balance||[]).forEach(row=>{
    const sign=ASSET_CLASSES[row.cls]?.sign||1;
    const rate=Number(fxRates?.[row.currency||"CNY"]||1);
    const value=rowNative(row)*rate*sign;
    net+=value; if(value<0) liab+=value; else assets+=value;
  });
  return {net,assets,liab};
}
// 首月没有真实上月快照时，反向重放流水构造期初。自动报价股票可用保存的上月底价格，
// 其余资产按“无流水则估值不变”处理。
function openingBaseline(mKey){
  const m=ledger.months[mKey];
  const balance=structuredClone(m?.balance||[]);
  [...(m?.flows||[])].reverse().forEach(flow=>applyFlowToBalance(balance,flow,-1));
  balance.forEach(row=>{
    const price=m?.openingPrices?.[row.id]?.price;
    if(row.cls==="stock"&&row.auto&&Number.isFinite(Number(price))&&Number(price)>0) row.price=Number(price);
  });
  return {balance,fxRates:m?.fxRates||{CNY:1}};
}
// 逐资产扣除流水的直接影响：交易按成本/成交额，资产收益归入来源资产，剩余即价格、汇率或手工估值贡献。
// 该结果同时供月度资产负债表与整体趋势使用，避免两处归因口径不一致。
function assetProfitAttribution(mKey,prevKey){
  const m=ledger.months[mKey];
  if(!m) return {m:mKey,rowPnl:{},entries:[],isBaseline:true};
  const hasPrevious=Boolean(prevKey&&ledger.months[prevKey]);
  const prev=hasPrevious?ledger.months[prevKey]:openingBaseline(mKey);
  const prevFxKey=hasPrevious?prevKey:mKey;
  const expected={}, expectedNative={}, assetIncome={}, realized={};
  const addExpected=(assetId,value)=>{ if(assetId) expected[assetId]=(expected[assetId]||0)+value; };
  const addExpectedNative=(assetId,value)=>{ if(assetId) expectedNative[assetId]=(expectedNative[assetId]||0)+value; };
  const addAssetIncome=(assetId,value)=>{ if(assetId) assetIncome[assetId]=(assetIncome[assetId]||0)+value; };
  const addRealized=(assetId,value)=>{ if(assetId) realized[assetId]=(realized[assetId]||0)+value; };
  (m.flows||[]).forEach(f=>{
    const value=flowCNY(f,mKey);
    if(f.kind==="income"){
      addExpected(f.toAssetId,+value); addExpectedNative(f.toAssetId,+flowAmount(f));
    }else if(f.kind==="expense"){
      addExpected(f.fromAssetId,-value); addExpectedNative(f.fromAssetId,-flowAmount(f));
    }
    else if(f.kind==="buy"){
      addExpected(f.fromAssetId,-value); addExpected(f.toAssetId,+value);
      addExpectedNative(f.fromAssetId,-flowAmount(f));
      addRealized(f.toAssetId,Number(f.realizedPnlCNY||0));
    }else if(f.kind==="sell"){
      addExpected(f.toAssetId,+value); addExpected(f.fromAssetId,-value);
      addExpectedNative(f.toAssetId,+flowAmount(f));
      addRealized(f.fromAssetId,Number(f.realizedPnlCNY||0));
    }else if(f.kind==="dividend"){
      addExpected(f.toAssetId,+value); addExpectedNative(f.toAssetId,+flowAmount(f)); addAssetIncome(f.fromAssetId,value);
    }else if(f.kind==="transfer"){
      addExpected(f.fromAssetId,-value);
      const toRow=assetByFlow(m,f,"to"), toCurrency=f.toCurrency||toRow?.currency||f.currency||"CNY";
      const toAmount=Number(f.toAmount!=null?f.toAmount:f.amount||0);
      addExpected(f.toAssetId,toAmount*fxRate(toCurrency,mKey));
      addExpectedNative(f.fromAssetId,-flowAmount(f)); addExpectedNative(f.toAssetId,+toAmount);
    }else if(f.kind==="repay"){
      addExpected(f.fromAssetId,-value); addExpected(f.toAssetId,+value);
      addExpectedNative(f.fromAssetId,-flowAmount(f)); addExpectedNative(f.toAssetId,-flowAmount(f));
    }
  });
  const curById=new Map(m.balance.map(row=>[row.id,row]));
  const prevById=new Map((prev.balance||[]).map(row=>[row.id,row]));
  const rowPnl={}, entries=[];
  new Set([...curById.keys(),...prevById.keys()]).forEach(id=>{
    const current=curById.get(id), previous=prevById.get(id), row=current||previous;
    const previousValue=previous?rowNative(previous)*fxRate(previous.currency||"CNY",prevFxKey)*(ASSET_CLASSES[previous.cls]?.sign||1):0;
    const delta=(current?rowCNY(current,mKey):0)-previousValue;
    const pnl=delta-(expected[id]||0)+(assetIncome[id]||0);
    const manualAdjustment=row?.cls==="cash"
      ? ((current?rowNative(current):0)-(previous?rowNative(previous):0)-(expectedNative[id]||0))*fxRate(row.currency||"CNY",mKey)
      : 0;
    const fxImpact=row?.cls==="cash"?pnl-(assetIncome[id]||0)-manualAdjustment:0;
    rowPnl[id]=pnl;
    entries.push({id,row,pnl,income:assetIncome[id]||0,realized:realized[id]||0,manualAdjustment,fxImpact,unrealized:pnl-(assetIncome[id]||0)-(realized[id]||0)});
  });
  return {m:mKey,rowPnl,entries,isBaseline:!hasPrevious};
}
function profitAttribution(mKey,prevKey){
  const hasPrevious=Boolean(prevKey&&ledger.months[prevKey]);
  const asset=assetProfitAttribution(mKey,prevKey);
  const deltas={};
  (ledger.months[mKey]?.flows||[]).forEach(f=>{
    const value=flowCNY(f,mKey);
    if(f.kind==="income") deltas["收入"]=(deltas["收入"]||0)+value;
    else if(f.kind==="expense") deltas["支出"]=(deltas["支出"]||0)-value;
  });
  asset.entries.forEach(({row,pnl})=>{
    const group=contributionGroup(row);
    deltas[group]=(deltas[group]||0)+pnl;
  });
  const opening=hasPrevious?monthTotals(prevKey):balanceTotals(openingBaseline(mKey).balance,ledger.months[mKey]?.fxRates);
  const netDelta=monthTotals(mKey).net-opening.net;
  const explained=Object.values(deltas).reduce((sum,value)=>sum+value,0);
  const residual=netDelta-explained;
  if(Math.abs(residual)>0.01) deltas["未解释调整"]=residual;
  return {m:mKey,deltas,netDelta,isBaseline:!hasPrevious};
}


// ================= 趋势区 =================
let trendState={win:"all", from:null, to:null};
let trendHiddenGroups=new Set(); // 被隐藏的分组名
function trendMonthKeys(){
  const all=monthKeys();
  if(!all.length) return [];
  if(trendState.win==="12") return all.slice(-12);
  if(trendState.win==="ytd"){ const y=new Date().getFullYear()+"-01"; return all.filter(k=>k>=y); }
  if(trendState.win==="custom" && trendState.from && trendState.to)
    return all.filter(k=>k>=trendState.from && k<=trendState.to);
  return all;
}
function palette(i){ const c=["#2e6f4e","#b8923f","#2f4858","#a6392f","#7d5ba6","#3d7ea6","#c77b3a","#6b8e3d","#9c5a4a","#5a6b8c"]; return c[i%c.length]; }
function renderTrend(){
  if(!ledger){ $("trendSummary").innerHTML=""; $("trendCharts").innerHTML=""; return; }
  const keys=trendMonthKeys();
  if(keys.length<1){ $("trendSummary").innerHTML=`<div class="mut">暂无数据</div>`; $("trendCharts").innerHTML=""; return; }
  renderTrendSummary(keys);
  $("trendCharts").innerHTML = profitChart(keys) + stackedChart(keys);
  // 还原勾选状态
  $("trendCharts").querySelectorAll(".grp-toggle").forEach(cb=>{
    cb.checked = !trendHiddenGroups.has(cb.dataset.grp);
  });
}
// 事件委托: 分组切换 — 挂一次即可
document.addEventListener("change", e=>{
  if(e.target.classList.contains("grp-toggle")){
    const g=e.target.dataset.grp;
    e.target.checked ? trendHiddenGroups.delete(g) : trendHiddenGroups.add(g);
    renderTrend();
  }
});
// 趋势图悬停 tooltip
document.addEventListener("mouseover", e=>{
  if(!e.target.classList) return;
  const isProfit=e.target.classList.contains("profit-hover-col");
  const isStack=e.target.classList.contains("hover-col")||isProfit;
  const isCash=e.target.classList.contains("cash-hover-col");
  if(!isStack&&!isCash) return;
  const i=Number(e.target.dataset.i);
  const H=isProfit?window.__profitHover:(isStack?window.__stackHover:window.__cashHover); if(!H||!H.data[i]) return;
  const d=H.data[i];
  const wrap=e.target.closest(".svg-wrap");
  const tip=wrap.querySelector(".chart-tip");
  const line=wrap.querySelector(".hover-line");
  // 竖线定位(用命中区中心)
  const cx=Number(e.target.getAttribute("x"))+Number(e.target.getAttribute("width"))/2;
  if(line){ line.setAttribute("x1",cx); line.setAttribute("x2",cx); line.style.display=""; }
  let body;
  if(isStack){
    const stackNames=isProfit?H.names:H.gNames;
    const absolute=!isProfit&&H.mode==="absolute";
    const rows=stackNames.map((gn,gi)=>({gn,gi,value:absolute?(d.groups[gn]||0):(d.deltas[gn]||0)}))
      .filter(r=>(isProfit||!trendHiddenGroups.has(r.gn)) && r.value!==0)
      .sort((a,b)=>Math.abs(b.value)-Math.abs(a.value));
    body=rows.map(r=>`<div class="tip-row"><span><i style="background:${isProfit?H.colorFor(r.gn,r.gi):H.palette[r.gi]}"></i>${escapeHTML(r.gn)}</span><b class="num ${r.value>0?"pos":"neg"}">${!absolute&&r.value>0?"+":""}${fmtTrend(r.value)}</b></div>`).join("");
    if(!absolute) body+=`<div class="tip-row tip-net"><span>净资产变动</span><b class="num ${d.netDelta>0?"pos":d.netDelta<0?"neg":""}">${d.netDelta>0?"+":""}${fmtTrend(d.netDelta)}</b></div>`;
  }else{
    body=`<div class="tip-row"><span><i style="background:var(--green)"></i>流入</span><b class="num pos">${fmtTrend(d.inf)}</b></div>
      <div class="tip-row"><span><i style="background:var(--red)"></i>流出</span><b class="num neg">${fmtTrend(d.outf)}</b></div>
      <div class="tip-row tip-net"><span>净现金流</span><b class="num ${d.net<0?"neg":"pos"}">${d.net>=0?"+":""}${fmtTrend(d.net)}</b></div>`;
  }
  tip.innerHTML=`<div class="tip-title">${escapeHTML(isStack?d.m+(isProfit?" · 盈亏归因":H.mode==="absolute"?" · 期末规模":" · 本月变动"):d.m)}</div>${body}`;
  tip.style.display="block";
  // 定位: 靠近鼠标, 右侧优先, 越界翻到左侧
  const wr=wrap.getBoundingClientRect();
  const px = (cx/getVbW(wrap)) * wr.width;
  const tipW=tip.offsetWidth||150;
  let left = px + 12; if(left+tipW>wr.width) left = px - tipW - 12; if(left<0) left=4;
  tip.style.left=left+"px"; tip.style.top="8px";
});
function getVbW(wrap){ const svg=wrap.querySelector("svg"); const vb=svg&&svg.getAttribute("viewBox"); return vb?Number(vb.split(" ")[2]):wrap.clientWidth; }
document.addEventListener("mouseout", e=>{
  if(!e.target.classList||(!e.target.classList.contains("hover-col")&&!e.target.classList.contains("profit-hover-col")&&!e.target.classList.contains("cash-hover-col"))) return;
  const wrap=e.target.closest(".svg-wrap"); if(!wrap) return;
  const tip=wrap.querySelector(".chart-tip"); const line=wrap.querySelector(".hover-line");
  if(tip) tip.style.display="none"; if(line) line.style.display="none";
});

function renderTrendSummary(keys){
  const allKeys=monthKeys();
  // base = 窗口首月的前一个已有月份(体现"期初")；无前月则退回首月自身
  const firstIdx=allKeys.indexOf(keys[0]);
  const baseKey = firstIdx>0 ? allKeys[firstIdx-1] : keys[0];
  const base=monthTotals(baseKey), last=monthTotals(keys[keys.length-1]);
  // 窗口内现金流合计
  let inflow=0, outflow=0;
  keys.forEach(k=>{ const totals=cashFlowTotals(k); inflow+=totals.inflow; outflow+=totals.outflow; });
  const net=inflow-outflow;
  const signed=(n)=>`${n>0?"+":""}${amount(n)}`;
  const changeCard=(label,cur,b)=>{
    const d=cur-b, tone=d>0?"pos":d<0?"neg":"neutral";
    return `<div class="card trend-card ${tone}">
      <div class="change-label"><span>${label}</span><span>窗口变化</span></div>
      <div class="change-value num ${tone==="neutral"?"":tone}">${signed(d)}</div>
      <div class="change-meta"><span>期初 ${amount(b)}</span><span>期末 ${amount(cur)}</span></div>
    </div>`;
  };
  const cashTone=net>0?"pos":net<0?"neg":"neutral";
  const cashCard=`<div class="card trend-card ${cashTone}">
    <div class="change-label"><span>净现金流</span><span>窗口累计</span></div>
    <div class="change-value num ${cashTone==="neutral"?"":cashTone}">${signed(net)}</div>
    <div class="change-meta"><span>流入 ${amount(inflow)}</span><span>流出 ${amount(outflow)}</span></div>
  </div>`;
  $("trendSummary").innerHTML=`<div class="cards metric-cards">
    ${changeCard("净资产", last.net, base.net)}
    ${changeCard("总资产", last.assets, base.assets)}
    ${changeCard("总负债", last.liab, base.liab)}
    ${cashCard}
  </div>`;
}

// 平滑折线路径(Catmull-Rom → 贝塞尔)
function smoothPath(pts){
  if(pts.length<2) return pts.length?`M${pts[0][0]},${pts[0][1]}`:"";
  let d=`M${pts[0][0]},${pts[0][1]}`;
  for(let i=0;i<pts.length-1;i++){
    const p0=pts[i-1]||pts[i], p1=pts[i], p2=pts[i+1], p3=pts[i+2]||p2;
    const c1x=p1[0]+(p2[0]-p0[0])/6, c1y=p1[1]+(p2[1]-p0[1])/6;
    const c2x=p2[0]-(p3[0]-p1[0])/6, c2y=p2[1]-(p3[1]-p1[1])/6;
    d+=` C${c1x},${c1y} ${c2x},${c2y} ${p2[0]},${p2[1]}`;
  }
  return d;
}
// 资产规模按月展示变动值；窗口首月仍相较其真实上月，整个账本首月记为 0。
function stackedChart(keys){
  const allKeys=monthKeys();
  const groupSet={};
  const data=keys.map(k=>{
    const priorIndex=allKeys.indexOf(k)-1;
    const prevKey=priorIndex>=0?allKeys[priorIndex]:null;
    const groups=monthGroupTotals(k), prevGroups=prevKey?monthGroupTotals(prevKey):{};
    Object.keys(groups).forEach(n=>groupSet[n]=true);
    Object.keys(prevGroups).forEach(n=>groupSet[n]=true);
    return {m:k,groups,prevGroups,isBaseline:!prevKey};
  });
  const gNames=Object.keys(groupSet).sort((a,b)=>{
    const last=data[data.length-1].groups;
    return Math.abs(last[b]||0)-Math.abs(last[a]||0);
  });
  data.forEach(d=>{
    d.deltas={};
    gNames.forEach(gn=>d.deltas[gn]=d.isBaseline?0:(d.groups[gn]||0)-(d.prevGroups[gn]||0));
  });
  const changeCell=value=>{
    const tone=value>0?"pos":value<0?"neg":"zero";
    return `<span class="amount change-cell ${tone}">${value>0?"+":""}${fmtTrend(value)}</span>`;
  };
  const rows=data.map(d=>`<tr><td class="num">${d.m}</td>${gNames.map(gn=>`<td>${changeCell(d.deltas[gn])}</td>`).join("")}</tr>`).join("");
  const openingGroups=data[0].isBaseline ? data[0].groups : data[0].prevGroups;
  const openingKey=data[0].isBaseline ? keys[0] : allKeys[allKeys.indexOf(keys[0])-1];
  const openingMonthTotals=monthTotals(openingKey), openingAssets=openingMonthTotals.assets, openingLiabs=Math.abs(openingMonthTotals.liab);
  const openingTotals=gNames.map(gn=>{
    const value=openingGroups[gn]||0;
    const denominator=value<0?openingLiabs:openingAssets;
    const share=denominator?Math.abs(value)/denominator*100:0;
    return `<td><div class="trend-total"><span class="amount ${value>0?"pos":value<0?"neg":""}">${value>0?"+":""}${fmtTrend(value)}</span><small>${share.toFixed(1)}% ${value<0?"总负债":"总资产"}</small></div></td>`;
  }).join("");
  const finalGroups=data[data.length-1].groups;
  const finalMonthTotals=monthTotals(keys[keys.length-1]), finalAssets=finalMonthTotals.assets, finalLiabs=Math.abs(finalMonthTotals.liab);
  const totals=gNames.map(gn=>{
    const value=finalGroups[gn]||0;
    const denominator=value<0?finalLiabs:finalAssets;
    const share=denominator?Math.abs(value)/denominator*100:0;
    return `<td><div class="trend-total"><span class="amount ${value>0?"pos":value<0?"neg":""}">${value>0?"+":""}${fmtTrend(value)}</span><small>${share.toFixed(1)}% ${value<0?"总负债":"总资产"}</small></div></td>`;
  }).join("");
  const heads=gNames.map((gn,gi)=>`<th><span class="group-head"><i style="background:${palette(gi)}"></i>${escapeHTML(gn)}</span></th>`).join("");
  return `<div class="chart-block"><div class="chart-title">资产规模趋势</div>
    <div class="hint">单元格为相较上月的期末规模变动；期初和期末汇总中，资产占比以总资产为分母，负债占比以总负债为分母。</div>
    <div class="trend-table-wrap"><table class="trend-table"><thead><tr><th>月份</th>${heads}</tr></thead>
      <tbody><tr class="trend-opening-row"><td>期初汇总</td>${openingTotals}</tr>${rows}<tr class="trend-total-row"><td>期末汇总</td>${totals}</tr></tbody></table></div>
  </div>`;
}
function compactProfitContributions(rawNames,rawData,maxVisible=6){
  const totals={};
  rawData.forEach(d=>rawNames.forEach(name=>totals[name]=(totals[name]||0)+(d.deltas[name]||0)));
  const pinned=["收入","支出"].filter(name=>Math.abs(totals[name]||0)>0.01);
  const remaining=rawNames.filter(name=>!pinned.includes(name)&&Math.abs(totals[name]||0)>0.01)
    .sort((a,b)=>Math.abs(totals[b])-Math.abs(totals[a]));
  const kept=[...pinned,...remaining.slice(0,Math.max(0,maxVisible-pinned.length))];
  const hidden=rawNames.filter(name=>!kept.includes(name));
  const data=rawData.map(d=>{
    const deltas={};
    kept.forEach(name=>deltas[name]=d.deltas[name]||0);
    const other=hidden.reduce((sum,name)=>sum+(d.deltas[name]||0),0);
    if(Math.abs(other)>0.01) deltas["其他贡献"]=other;
    return {...d,deltas};
  });
  const names=[...kept];
  if(data.some(d=>Math.abs(d.deltas["其他贡献"]||0)>0.01)) names.push("其他贡献");
  return {names,data};
}
function profitColor(name,index){
  if(name==="收入") return "var(--green)";
  if(name==="支出") return "var(--red)";
  if(name==="其他贡献"||name==="未解释调整") return "var(--muted)";
  return palette(index);
}
function profitSummaryCards(names,data,colorFor){
  const totals={};
  data.forEach(d=>names.forEach(name=>totals[name]=(totals[name]||0)+(d.deltas[name]||0)));
  const rows=Object.entries(totals).filter(([,value])=>Math.abs(value)>0.01)
    .sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]));
  if(!rows.length) return "";
  const cards=rows.map(([name,value])=>{
    const tone=value>0?"pos":value<0?"neg":"neutral";
    const label=name.startsWith("资产·")?name.slice(3):name;
    const index=names.indexOf(name);
    return `<div class="card profit-card ${tone}"><div class="label"><i class="profit-swatch" style="background:${colorFor(name,index)}"></i>${escapeHTML(label)}</div><div class="profit-value num ${tone==="neutral"?"":tone}">${value>0?"+":""}${amount(value)}</div></div>`;
  }).join("");
  return `<div class="profit-summary"><div class="cards">${cards}</div></div>`;
}
// 净资产盈亏归因：投资分组按期末价值变化扣除买入成本、加回卖出成交额和资产收益。
function profitChart(keys){
  const W=Math.max(520,keys.length*72), H=160, PL=8, PR=8, PT=14, PB=22;
  const allKeys=monthKeys(), categorySet={};
  const rawData=keys.map((k,index)=>{
    const priorIndex=allKeys.indexOf(k)-1;
    const prevKey=index>0?keys[index-1]:(priorIndex>=0?allKeys[priorIndex]:null);
    const d=profitAttribution(k,prevKey);
    Object.keys(d.deltas).forEach(name=>categorySet[name]=true);
    return d;
  });
  const rawNames=Object.keys(categorySet);
  const compact=compactProfitContributions(rawNames,rawData);
  const names=compact.names, data=compact.data;
  const colorFor=profitColor;
  const maxV=Math.max(1,...data.map(d=>{
    const values=names.map(name=>d.deltas[name]||0);
    return Math.max(values.reduce((sum,v)=>sum+Math.max(0,v),0),-values.reduce((sum,v)=>sum+Math.min(0,v),0),Math.abs(d.netDelta));
  }));
  const x=i=>keys.length<=1?W/2:PL+i*(W-PL-PR)/(keys.length-1);
  const zeroY=PT+(H-PT-PB)/2, scale=(H-PT-PB)/2/maxV;
  const bw=Math.max(12,Math.min(38,(W-PL-PR)/keys.length*.58));
  let bars="";
  data.forEach((d,i)=>{
    let pos=0,neg=0;
    names.forEach((name,ni)=>{
      const value=d.deltas[name]||0; if(!value) return;
      const h=Math.abs(value)*scale, y=value>0?zeroY-(pos+value)*scale:zeroY+neg*scale;
      if(value>0) pos+=value; else neg+=Math.abs(value);
      bars+=`<rect x="${x(i)-bw/2}" y="${y}" width="${bw}" height="${h}" rx="2" fill="${colorFor(name,ni)}" fill-opacity=".86"><title>${escapeHTML(name)} ${value>0?"+":""}${fmtMoney(value)}</title></rect>`;
    });
  });
  const line=smoothPath(data.map((d,i)=>[x(i),zeroY-d.netDelta*scale]));
  const dots=data.map((d,i)=>`<circle cx="${x(i)}" cy="${zeroY-d.netDelta*scale}" r="2.6" fill="var(--bg)" stroke="var(--text)" stroke-width="1.5"/>`).join("");
  const hover=keys.map((k,i)=>{
    const cw=(W-PL-PR)/Math.max(1,keys.length);
    return `<rect class="profit-hover-col" x="${x(i)-cw/2}" y="0" width="${cw}" height="${H}" fill="transparent" data-i="${i}"/>`;
  }).join("");
  window.__profitHover={data,names,colorFor};
  const summary=profitSummaryCards(names,data,colorFor);
  return `<div class="chart-block profit-analysis"><div class="profit-analysis-head"><div class="chart-title">盈亏趋势</div><span class="profit-line-key"><i></i>净资产变动</span></div>
    ${summary}
    <div class="svg-wrap" style="position:relative"><svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <line x1="${PL}" y1="${zeroY}" x2="${W-PR}" y2="${zeroY}" class="zero-line"/>
      ${bars}
      <path d="${line}" fill="none" stroke="var(--text)" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      ${dots}
      <line class="hover-line" x1="0" y1="0" x2="0" y2="${H}" stroke="var(--text)" stroke-width="1" stroke-dasharray="3 3" style="display:none"/>
      ${hover}
    </svg><div class="chart-tip" style="display:none"></div></div>${xAxisLabels(keys)}</div>`;
}
// 月份标签行(HTML, 避免SVG拉伸变形)
function xAxisLabels(keys){
  return `<div class="xaxis">${keys.map(k=>`<span>${k.slice(2)}</span>`).join("")}</div>`;
}

// 窗口选择事件
$("trendWindow").addEventListener("change",e=>{
  trendState.win=e.target.value;
  $("trendCustom").hidden = e.target.value!=="custom";
  if(e.target.value!=="custom") renderTrend();
});
$("trendApply").addEventListener("click",()=>{
  trendState.from=$("trendFrom").value; trendState.to=$("trendTo").value;
  renderTrend();
});
$("trendRefresh").addEventListener("click",()=>{
  renderTrend();
  setStatus("已刷新整体趋势");
});
