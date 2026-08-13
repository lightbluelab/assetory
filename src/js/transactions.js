// ---------- 流水 → 资产负债 联动引擎 ----------
function flowAmount(f){ return Number(f.amount||0); }  // 保存时已算好(股票=数量×价格; 其它=直填)
function holdingFlowAmount(f){ return Number(f.holdingAmount!=null?f.holdingAmount:f.amount||0); }
function incomeUsesQuantity(f,target){
  return target?.cls==="stock"&&f.incomeAssetMode==="quantity";
}
function applyFlowToBalance(balance,f,sign){
  const byId=id=>balance.find(row=>row.id===id);
  const requireRow=id=>{ const row=byId(id); if(!row) throw new Error("流水引用的资产不存在，请先修复或删除该流水"); return row; };
  const addVal=(id,d)=>{ const row=requireRow(id); row.value=(Number(row.value)||0)+d; if(Number(row.value)!==0) delete row.inactive; };
  const addQty=(id,d)=>{ const row=requireRow(id); row.qty=(Number(row.qty)||0)+d; if(Number(row.qty)!==0) delete row.inactive; };
  const addHolding=(id,qty,amount,direction)=>{ const row=byId(id); if(!row) throw new Error("流水引用的资产不存在"); if(row.cls==="stock") addQty(id,qty*direction); else addVal(id,amount*direction); };
  const addCost=(id,d)=>{ const row=requireRow(id); row.costBasisCNY=Math.max(0,Number(row.costBasisCNY||0)+d); };
  const amt=flowAmount(f), toAmt=Number(f.toAmount!=null?f.toAmount:f.amount||0), holdAmt=holdingFlowAmount(f), q=Number(f.qty||0);
  switch(f.kind){
    case "income": {
      const target=requireRow(f.toAssetId);
      const quantityMode=incomeUsesQuantity(f,target);
      if(quantityMode) addQty(f.toAssetId,q*sign); else addVal(f.toAssetId,+amt*sign);
      if(f.nonCashIncome===true) addCost(f.toAssetId,Number(f.costAddedCNY||0)*sign);
      break;
    }
    case "assetIncome": addVal(f.toAssetId,+amt*sign); break;
    case "expense": addVal(f.fromAssetId,-amt*sign); break;
    case "transfer": addVal(f.fromAssetId,-amt*sign); addVal(f.toAssetId,+toAmt*sign); break;
    case "buy": addVal(f.fromAssetId,-amt*sign); addHolding(f.toAssetId,q,holdAmt,+sign); addCost(f.toAssetId,(Number(f.costAddedCNY||0)-Number(f.costReductionCNY||0))*sign); break;
    case "sell": addVal(f.toAssetId,+amt*sign); addHolding(f.fromAssetId,q,holdAmt,-sign); addCost(f.fromAssetId,(Number(f.costAddedCNY||0)-Number(f.costReductionCNY||0))*sign); break;
    case "repay": addVal(f.fromAssetId,-amt*sign); addVal(f.toAssetId,-amt*sign); break;
    case "valuation": addVal(f.toAssetId,+amt*sign); break;
  }
}
// sign=+1 应用, -1 回滚
function applyFlow(f,sign){ applyFlowToBalance(ledger.months[activeMonth].balance,f,sign); }
// ---------- 跨月同步: 将某月期末同步为下月期初并重算 ----------
// 找到以 fromKey 为拷贝来源的下一月
function childMonthOf(fromKey){
  return monthKeys().find(k=>ledger.months[k].copiedFrom===fromKey)||null;
}
// 重建 childKey 的期初(取自 parentKey 期末), 保留 child 自己的流水/价格/交易建仓资产, 再重算期末
function rebuildChildFromParent(parentKey, childKey){
  const parent=ledger.months[parentKey], child=ledger.months[childKey];
  const oldBal=child.balance;
  // child 自己"本月交易建仓"的资产(不来自父月)仅在仍有流水引用时保留。
  const parentIds=new Set(parent.balance.map(row=>row.id));
  const oldById=new Map(oldBal.map(row=>[row.id,row]));
  const explicitLocal=(child.opening||[]).filter(open=>!parentIds.has(open.id)).map(open=>({...oldById.get(open.id),...open}));
  // 流水建仓资产不属于期初；以零持仓加入重放基线。删除建仓流水后不再保留。
  const flowAssetIds=new Set();
  (child.flows||[]).forEach(f=>{
    if(f.fromAssetId) flowAssetIds.add(f.fromAssetId);
    if(f.toAssetId) flowAssetIds.add(f.toAssetId);
  });
  const explicitIds=new Set(explicitLocal.map(row=>row.id));
  const flowOpened=oldBal.filter(r=>r.openedThisMonth&&flowAssetIds.has(r.id)&&!explicitIds.has(r.id)).map(r=>{
    const c={...r};
    if(c.cls==="stock") c.qty=0;
    else c.value=0;
    c.costBasisCNY=0;
    return c;
  });
  const ownNew=explicitLocal.concat(flowOpened);
  // 继承资产 = 父月期末(剔除已清仓), 深拷贝作为期初。
  // 子月自己的价格、估值和自动更新状态属于月末估值，不应被来源月同步覆盖。
  const childOverrides={}; oldBal.forEach(r=>{
    childOverrides[r.id]={
      price:r.price,
      group:r.group,auto:r.auto,market:r.market,symbol:r.symbol,
      priceStatus:r.priceStatus,priceAt:r.priceAt,manualPriceAt:r.manualPriceAt
    };
  });
  const inherited = parent.balance.map(r=>{
    const c={...r}; delete c.openedThisMonth;
    const own=childOverrides[c.id];
    if(own){
      ["group","auto","market","symbol","priceStatus","priceAt","manualPriceAt"].forEach(key=>{ if(own[key]!==undefined) c[key]=own[key]; });
    }
    if(isClosed(c)) c.inactive=true; else delete c.inactive;
    return c;
  });
  // 新期初 = 继承 + child自建
  const opening = inherited.concat(ownNew.map(r=>({...r})));
  // 期初快照
  child.opening = opening.map(balanceSnapshotRow);
  // 期末 = 期初深拷贝, 再叠加 child 自己的流水
  const bal = opening.map(r=>({...r}));
  // 子月自己的价格属于子月期末；期初快照仍保留父月真实期末价格。
  bal.forEach(row=>{ const own=childOverrides[row.id]; if(own?.price!=null) row.price=own.price; });
  // 流水以资产 ID 引用，缺失引用会中止同步，不会静默指向其他资产。
  (child.flows||[]).forEach(f=>{
    applyFlowToBalance(bal,f,+1);
  });
  child.balance=bal;
  child.fxRates=child.fxRates||{...(parent.fxRates||{CNY:1})};
  child.sourceRevision=Number(parent.revision||0);
  child.revision=Number(child.revision||0)+1;
  child.updatedAt=new Date().toISOString();
  appendMonthChange(child,`同步自 ${parentKey}（来源版本 ${child.sourceRevision}）`);
}
// 同步到下月(一级)
async function syncToNext(fromKey){
  const child=childMonthOf(fromKey);
  if(!child){ setStatus("没有以本月为来源的下一月"); return; }
  const ok=await transact("同步到下月",()=>rebuildChildFromParent(fromKey, child),{touch:false});
  if(ok) setStatus(`已把 ${fromKey} 的期末同步到 ${child}`);
}
// 同步到后续所有月(沿拷贝链一路重建)
async function syncToAll(fromKey){
  let cur=fromKey, n=0;
  const ok=await transact("同步后续月份",()=>{
    while(true){ const child=childMonthOf(cur); if(!child) break; rebuildChildFromParent(cur,child); cur=child; n++; }
  },{touch:false});
  if(ok) setStatus(n?`已同步到后续 ${n} 个月`:"没有后续月份");
}

// 持仓状态标识: 建仓(本月新开)/清仓(归零)/绿黄红灯(价格更新新鲜度)
function positionBadge(r){
  if(r.cls!=="stock"&&r.cls!=="fixed"&&r.cls!=="fund") return "";
  const closed = r.cls==="stock" ? Number(r.qty||0)===0 : Number(r.value||0)===0;
  if(closed) return `<span class="badge closed" title="已清仓，下月不再拷贝">清仓</span>`;
  if(r.cls==="stock"&&Number(r.qty||0)<0) return `<span class="badge short" title="负数量持仓">做空</span>`;
  if(r.openedThisMonth) return `<span class="badge opened" title="本月交易建仓">建仓</span>`;
  return "";
}
function isClosed(r){
  if(r.cls==="stock") return Number(r.qty||0)===0;
  if(r.cls==="fixed"||r.cls==="fund") return Number(r.value||0)===0;
  if(r.cls==="cash"||r.cls==="liability") return Number(r.value||0)===0;
  return false;
}
function findFlow(id){ const m=ledger.months[activeMonth]; const i=m.flows.findIndex(x=>x.id===id); return {m,i,f:m.flows[i]}; }

// ---------- 对账: 期末 = 期初 + 流水 + 价格更新, 找出不符合预期的变更 ----------
function reconcile(mKey){
  const m=ledger.months[mKey];
  if(!m.opening) return null;
  const openMap={}; m.opening.forEach(o=>openMap[o.id]=o);
  const dQty={}, dVal={};
  const bal=m.balance;
  const rowById=id=>bal.find(row=>row.id===id);
  const isFixed=id=>["fixed","fund"].includes(rowById(id)?.cls);
  (m.flows||[]).forEach(f=>{
    const a=Number(f.amount||0), t=Number(f.toAmount!=null?f.toAmount:f.amount||0), h=holdingFlowAmount(f), q=Number(f.qty||0);
    switch(f.kind){
      case "income":{ const id=f.toAssetId; if(id){ const quantityMode=incomeUsesQuantity(f,rowById(id)); if(quantityMode) dQty[id]=(dQty[id]||0)+q; else dVal[id]=(dVal[id]||0)+a; } break; }
      case "assetIncome":{ const id=f.toAssetId; if(id) dVal[id]=(dVal[id]||0)+a; break; }
      case "expense": { const id=f.fromAssetId; if(id) dVal[id]=(dVal[id]||0)-a; break; }
      case "transfer":{ const i1=f.fromAssetId,i2=f.toAssetId; if(i1)dVal[i1]=(dVal[i1]||0)-a; if(i2)dVal[i2]=(dVal[i2]||0)+t; break; }
      case "buy":  { const c=f.fromAssetId; if(c)dVal[c]=(dVal[c]||0)-a;
                     const hold=f.toAssetId; if(hold){ if(isFixed(hold)) dVal[hold]=(dVal[hold]||0)+h; else dQty[hold]=(dQty[hold]||0)+q; } break; }
      case "sell": { const c=f.toAssetId; if(c)dVal[c]=(dVal[c]||0)+a;
                     const hold=f.fromAssetId; if(hold){ if(isFixed(hold)) dVal[hold]=(dVal[hold]||0)-h; else dQty[hold]=(dQty[hold]||0)-q; } break; }
      case "repay":{ const c=f.fromAssetId,l=f.toAssetId; if(c)dVal[c]=(dVal[c]||0)-a; if(l)dVal[l]=(dVal[l]||0)-a; break; }
      case "valuation":{ const id=f.toAssetId; if(id) dVal[id]=(dVal[id]||0)+a; break; }
    }
  });
  const EPS=0.01, issues=[];
  bal.forEach(r=>{
    const o=openMap[r.id];
    if(!o){ if(r.openedThisMonth) return; issues.push({msg:`新增资产「${r.name}」（期初不存在，且非交易建仓）`}); return; }
    if(r.cls==="stock"){
      const exp=Number(o.qty||0)+(dQty[r.id]||0);
      if(Math.abs(Number(r.qty||0)-exp)>EPS) issues.push({id:r.id,field:"qty",msg:`「${r.name}」数量 期望 ${fmt(exp)}，实际 ${fmt(r.qty)}（差 ${fmt(r.qty-exp)}）`});
    }else{
      if(r.cls==="fund") return;   // 基金价值靠手动更新, 不计入异常提示
      const exp=Number(o.value||0)+(dVal[r.id]||0);
      if(Math.abs(Number(r.value||0)-exp)>EPS){
        const tag=r.cls==="fixed"?"（固定资产手动更新）":"";
        issues.push({id:r.id,field:"value",msg:`「${r.name}」金额 期望 ${fmt(exp)}，实际 ${fmt(r.value)}（差 ${fmt(r.value-exp)}）${tag}`});
      }
    }
  });
  m.opening.forEach(o=>{ if(!bal.some(r=>r.id===o.id)) issues.push({msg:`资产「${o.name}」已被删除`}); });
  return { from:m.copiedFrom, issues };
}

async function deleteFlow(id){
  if(!confirm("删除该流水?其对资产负债表的影响将被回滚。")) return;
  await transact("删除流水",()=>{
    const {m,i,f}=findFlow(id); if(i<0) throw new Error("流水不存在");
    applyFlow(f,-1);
    m.flows.splice(i,1);
    removeUnreferencedOpenedAssets(m);
  });
}

// ---------- 流水录入/编辑对话框 ----------
// 现金/投资/负债资产的下拉选项 (返回 balance 索引)
function assetOptions(side, selId){
  const m=ledger.months[activeMonth];
  const opts = m.balance.filter(r=>{
    if(side==="cash") return r.cls==="cash";
    if(side==="holding") return r.cls==="stock"||r.cls==="fixed"||r.cls==="fund";
    if(side==="asset") return r.cls!=="liability";
    if(side==="liability") return r.cls==="liability";
    return false;
  });
  return opts.map(r=>`<option value="${escapeAttr(r.id)}" ${r.id===selId?"selected":""}>${escapeHTML(assetLabel(r.id))} (${escapeHTML(r.currency||"CNY")})</option>`).join("");
}
function openFlowDialog(id){
  const editing = id!=null;
  refreshAssetSuggestions();
  const f = editing ? findFlow(id).f : {kind:"expense",date:activeMonth+"-01"};
  const dlg=$("flowDialog");
  $("flowDlgTitle").textContent = editing?"编辑流水":"添加流水";
  $("fdKind").value=f.kind||"expense";
  $("fdDate").value=f.date||(activeMonth+"-01");
  $("fdAmount").value=f.kind==="assetIncome"&&f.holdingAmount!=null?f.holdingAmount:(f.amount!=null?f.amount:"");
  $("fdQty").value=f.qty!=null?f.qty:"";
  $("fdPrice").value=f.price!=null?f.price:"";
  $("fdNote").value=f.note||"";
  $("fdSubcat").value=f.subcat||"";
  if($("fdLiquidate")) $("fdLiquidate").checked=false;
  dlg.dataset.edit = editing?id:"";
  buildFlowFields(f);
  dlg.hidden=false;
}
// 收集已用过的二级分类(按类型)供 datalist 提示
function refreshSubcatList(){
  const kind=$("fdKind").value;
  const set=new Set();
  Object.values(ledger.months).forEach(m=>(m.flows||[]).forEach(f=>{ if(f.kind===kind&&f.subcat) set.add(f.subcat); }));
  $("subcatList").innerHTML=[...set].map(s=>`<option value="${escapeAttr(s)}">`).join("");
}
// 依据类型渲染 流出方/流入方 控件
function buildFlowFields(f){
  const ft=FLOW_TYPES[$("fdKind").value];
  $("fdFromLabel").textContent=ft.fromLabel||"流出方";
  $("fdToLabel").textContent=ft.toLabel||"流入方";
  $("fdAmountLabel").textContent=ft.assetIncome?"资产收益金额":"金额";
  const mkSide=(side, wrapId, selId, curVal, curText)=>{
    const wrap=$(wrapId);
    if(side==="free"){
      wrap.innerHTML=`<input id="${selId}" placeholder="自定义填写(可空)" value="${escapeAttr(curText||"")}" />`;
    }else{
      const label = side==="cash"?"现金账户":(side==="holding"?"持有资产":(side==="asset"?"已有资产":"负债"));
      let opts=assetOptions(side, curVal);
      if((side==="holding"&&ft.newHolding)||(side==="asset"&&ft.newAsset)) opts += `<option value="__new__">＋ 新建资产…</option>`;
      if(!opts){ wrap.innerHTML=`<span class="mut">无可选${escapeHTML(label)}，请先在资产负债表添加</span>`; return; }
      wrap.innerHTML=`<select id="${selId}">${opts}</select>`;
      $(selId).addEventListener("change",()=>{ toggleNewInvest(); refreshExchangeRate(); });
    }
  };
  mkSide(ft.from,"fd-from-wrap","fdFrom", f?f.fromAssetId:null, f?f.fromText:"");
  mkSide(ft.to,"fd-to-wrap","fdTo", f?f.toAssetId:null, f?f.toText:"");
  // 金额 vs 数量+价格
  $("fd-amount").style.display = ft.needQtyPrice?"none":"";
  $("fd-qp").style.display = ft.needQtyPrice?"":"none";
  $("fd-subcat").style.display = ft.subcat?"":"none";
  refreshSubcatList();
  toggleNewInvest();
  refreshQtyPriceMode();
  refreshExchangeRate();
  if(f?.fxRate && !$("fd-fx").hidden) $("fdFxRate").value=f.fxRate;
}
function refreshExchangeRate(){
  const ft=FLOW_TYPES[$("fdKind").value];
  const holdSel=(ft.from==="holding"||ft.from==="asset")?$("fdFrom"):(ft.to==="holding"?$("fdTo"):null);
  const cashSel=ft.from==="cash"?$("fdFrom"):(ft.to==="cash"?$("fdTo"):null);
  const box=$("fd-fx");
  let baseCur, quoteCur;
  if(holdSel&&cashSel&&holdSel.value!=="__new__"&&cashSel.value!=="__new__"){
    const holding=assetById(holdSel.value), cash=assetById(cashSel.value);
    baseCur=holding?.currency||"CNY"; quoteCur=cash?.currency||"CNY";
  }else if(ft.from==="cash"&&ft.to==="cash"&&$("fdFrom")&&$("fdTo")){
    const from=assetById($("fdFrom").value), to=assetById($("fdTo").value);
    baseCur=from?.currency||"CNY"; quoteCur=to?.currency||"CNY";
  }else{ box.hidden=true; return; }
  if(ft.assetIncome) $("fdAmountLabel").textContent="资产收益金额（"+baseCur+"）";
  if(baseCur===quoteCur){ box.hidden=true; return; }
  const rate=fxRate(baseCur)/fxRate(quoteCur);
  $("fdFxLabel").textContent=`汇率（自动带入：1 ${baseCur} = ? ${quoteCur}）`;
  $("fdFxRate").value=rate.toFixed(6).replace(/0+$/,"").replace(/\.$/,"");
  box.hidden=false;
}
function assetById(id){ return ledger.months[activeMonth]?.balance.find(row=>row.id===id)||null; }
function flowAssetSelector(){
  const ft=FLOW_TYPES[$("fdKind").value];
  if(ft.from==="holding") return $("fdFrom");
  if(ft.to==="holding"||ft.to==="asset"&&ft.newAsset) return $("fdTo");
  return null;
}
// 当交易持有端或收入流入端选择“新建资产”时，展开新建字段。
function toggleNewInvest(){
  const assetSel=flowAssetSelector();
  const show=assetSel&&assetSel.value==="__new__";
  $("fd-newinv").style.display = show ? "" : "none";
  updateNiCls();
}
// 判断买入/卖出当前选中的持有端是否为"按金额"类(固定资产/基金),股票才用数量×价格
function holdingIsFixed(){
  const holdSel=flowAssetSelector();
  if(!holdSel) return false;
  if(holdSel.value==="__new__"){ const c=$("niCls")&&$("niCls").value; return c!=="stock"; }
  const r=assetById(holdSel.value);
  return r&&r.cls!=="stock";
}
function flowUsesQtyPrice(){
  const ft=FLOW_TYPES[$("fdKind").value];
  if(ft.needQtyPrice) return !holdingIsFixed();
  return $("fdKind").value==="income"&&!holdingIsFixed();
}
function refreshQtyPriceMode(){
  const ft=FLOW_TYPES[$("fdKind").value];
  const kind=$("fdKind").value;
  // 清仓仅适用于卖出，还清仅适用于还款。
  const canLiq = kind==="sell"||kind==="repay";
  $("fd-liquidate").hidden = !canLiq;
  $("fdLiqLabel").textContent = kind==="repay" ? "还清（结清对方全部余额）" : "清仓（全部卖出当前持仓）";
  if(!canLiq && $("fdLiquidate")) $("fdLiquidate").checked=false;
  const usesQtyPrice=flowUsesQtyPrice();
  $("fd-qp").style.display=usesQtyPrice?"":"none";
  $("fd-amount").style.display=usesQtyPrice?"none":"";
  applyLiquidate();
}
// 清仓/还清: 用当前全部持仓/负债余额填满并锁定输入
function applyLiquidate(){
  const kind=$("fdKind").value;
  const on = (kind==="sell"||kind==="repay") && $("fdLiquidate") && $("fdLiquidate").checked;
  const setDis=(id,dis)=>{ const el=$(id); if(el) el.disabled=dis; };
  if(!on){ setDis("fdQty",false); setDis("fdAmount",false); return; }
  if(kind==="repay"){
    // 还清: 流入方是负债, 填其当前余额(负债 value 记为正)
    const to=$("fdTo"); const r=to&&to.value!=="__new__"?assetById(to.value):null;
    if(r){ $("fdAmount").value=Number(r.value||0); setDis("fdAmount",true); }
    return;
  }
  // 买入/卖出的清仓针对持有端
  const ft=FLOW_TYPES[kind];
  const sel = ft.from==="holding"?$("fdFrom"):(ft.to==="holding"?$("fdTo"):null);
  const r = sel&&sel.value!=="__new__"?assetById(sel.value):null;
  if(r){
    if(r.cls==="stock"){ $("fdQty").value=Number(r.qty||0); setDis("fdQty",true); }
    else { $("fdAmount").value=Number(r.value||0); setDis("fdAmount",true); }
  }
}
// 新建资产: 股票显示数量/自动更新, 固定资产不显示
function updateNiCls(){
  const isStock = $("niCls") ? $("niCls").value==="stock" : true;
  if($("ni-stock-only")) $("ni-stock-only").style.display = isStock?"":"none";
  if(!isStock && $("ni-auto-fields")) $("ni-auto-fields").style.display="none";
  else if($("niAuto")) $("ni-auto-fields").style.display=$("niAuto").checked?"":"none";
  refreshQtyPriceMode();
}
$("niAuto").addEventListener("change",()=>{ $("ni-auto-fields").style.display=$("niAuto").checked?"":"none"; });
$("fdLiquidate").addEventListener("change",applyLiquidate);
$("niCls").addEventListener("change",updateNiCls);
$("fdKind").addEventListener("change",()=>buildFlowFields(null));
$("btnFlowCancel").addEventListener("click",()=>{ $("flowDialog").hidden=true; });
function buildFlowDraft(){
  const m=ledger.months[activeMonth], kind=$("fdKind").value, ft=FLOW_TYPES[kind];
  if(!ft) throw new Error("请选择有效流水类型");
  const readSide=(side,selId)=>{
    const el=$(selId);
    if(side==="free") return {text:textValue(el?.value,160)};
    if(!el) throw new Error("缺少可选资产，请先添加对应账户");
    if(el.value==="__new__") return {isNew:true};
    const asset=assetById(el.value);
    if(!asset) throw new Error("所选资产已不存在，请重新选择");
    return {asset};
  };
  const from=readSide(ft.from,"fdFrom"), to=readSide(ft.to,"fdTo");
  const holdIsNew=(ft.to==="holding"&&to.isNew)||(ft.from==="holding"&&from.isNew)||(ft.to==="asset"&&ft.newAsset&&to.isNew);
  let newAsset=null;
  if(holdIsNew){
    const name=textValue($("niName").value,80), cls=$("niCls").value;
    if(!name) throw new Error("请填写新建资产的项目名称");
    if(!["stock","fund","cash","fixed"].includes(cls)) throw new Error("新建资产类型无效");
    if(kind==="sell"&&cls!=="stock") throw new Error("做空仅支持股票资产");
    newAsset={id:uid("a"),cls,group:textValue($("niGroup").value,80)||"未分组",name,account:textValue($("niAccount").value,80),currency:textValue($("niCurrency").value,12)||"CNY",openedThisMonth:true};
    if(cls==="stock"){
      newAsset.qty=0; newAsset.price=Number($("fdPrice").value);
      if(!Number.isFinite(newAsset.price)||newAsset.price<=0) throw new Error("请填写有效价格");
      newAsset.auto=$("niAuto").checked;
      if(newAsset.auto){
        newAsset.market=$("niMarket").value; newAsset.symbol=textValue($("niSymbol").value,30);
        if(!newAsset.symbol) throw new Error("开启自动更新时必须填写股票代码");
      }
    }else{ newAsset.value=0; if(cls==="fixed") newAsset.account=""; }
    if(ft.to==="holding"||ft.to==="asset") to.asset=newAsset; else from.asset=newAsset;
  }
  const hold=ft.from==="holding"||ft.from==="asset"?from.asset:((ft.to==="holding"||ft.to==="asset"&&ft.newAsset)?to.asset:null);
  const usesQtyPrice=flowUsesQtyPrice();
  const date=$("fdDate").value||(activeMonth+"-01");
  if(!isValidDateKey(date,activeMonth)) throw new Error("流水日期必须是当前月份内的有效日期");
  if(kind==="transfer"&&from.asset?.id===to.asset?.id) throw new Error("转出与转入账户不能相同");
  if(kind==="repay"&&(from.asset?.currency||"CNY")!==(to.asset?.currency||"CNY")) throw new Error("跨币种还款请先转账换汇，再从同币种现金账户还款");
  const rec={kind,date,note:textValue($("fdNote").value,240)};
  if(ft.subcat) rec.subcat=textValue($("fdSubcat").value,80);
  if(usesQtyPrice){
    rec.qty=Number($("fdQty").value); rec.price=Number($("fdPrice").value); rec.amount=rec.qty*rec.price;
    if(!Number.isFinite(rec.qty)||!Number.isFinite(rec.price)||rec.qty<=0||rec.price<=0) throw new Error("数量和价格必须大于 0");
  }else{
    rec.amount=parseArithmetic($("fdAmount").value,"金额");
    if(!Number.isFinite(rec.amount)||rec.amount<=0) throw new Error("金额必须大于 0");
  }
  if(ft.from==="free") rec.fromText=from.text; else setFlowAsset(rec,"from",from.asset);
  if(ft.to==="free") rec.toText=to.text; else setFlowAsset(rec,"to",to.asset);
  if(kind==="income"){
    rec.nonCashIncome=to.asset?.cls!=="cash";
    rec.incomeAssetMode=usesQtyPrice?"quantity":"value";
  }
  const holdCur=hold?.currency||null;
  const cash=ft.from==="cash"?from.asset:(ft.to==="cash"?to.asset:null);
  const cashCur=cash?.currency||null;
  if(holdCur&&cashCur&&holdCur!==cashCur){
    const rate=Number($("fdFxRate").value);
    if(!Number.isFinite(rate)||rate<=0) throw new Error("请填写有效换汇汇率");
    rec.holdingAmount=rec.amount; rec.amount=rec.holdingAmount*rate;
    rec.fxRate=rate; rec.holdingCurrency=holdCur; rec.currency=cashCur;
  }else if(ft.from==="cash"&&ft.to==="cash"&&from.asset.currency!==to.asset.currency){
    const rate=Number($("fdFxRate").value);
    if(!Number.isFinite(rate)||rate<=0) throw new Error("请填写有效换汇汇率");
    rec.toAmount=rec.amount*rate; rec.fxRate=rate; rec.toCurrency=to.asset.currency; rec.currency=from.asset.currency;
  }else rec.currency=(from.asset||to.asset)?.currency||"CNY";
  return {rec,newAsset};
}
function refreshFlowCostMetadata(month,rec,monthKey=activeMonth){
  delete rec.costAddedCNY; delete rec.costReductionCNY; delete rec.realizedPnlCNY;
  if(rec.kind==="income"&&rec.nonCashIncome===true){
    const target=assetByFlow(month,rec,"to");
    if(target&&target.cls!=="cash") rec.costAddedCNY=Math.abs(flowCNY(rec,monthKey));
  }else if(rec.kind==="buy"){
    const hold=assetByFlow(month,rec,"to");
    if(!hold) return;
    if(hold.cls!=="stock"){ rec.costAddedCNY=flowCNY(rec,monthKey); return; }
    const position=Number(hold.qty||0), quantity=Number(rec.qty||0), trade=flowCNY(rec,monthKey);
    if(position>=0){ rec.costAddedCNY=trade; return; }
    const reduction=Number(hold.costBasisCNY||0)*quantity/(-position);
    if(reduction) rec.costReductionCNY=reduction;
    rec.realizedPnlCNY=reduction-trade;
  }else if(rec.kind==="sell"){
    const hold=assetByFlow(month,rec,"from");
    if(!hold) return;
    if(hold.cls!=="stock"){
      const held=Math.abs(Number(hold.value||0)), sold=Math.abs(Number(rec.holdingAmount!=null?rec.holdingAmount:rec.amount||0));
      const reduction=Number(hold.costBasisCNY||0)*(held>0?Math.min(1,sold/held):0);
      rec.costReductionCNY=reduction; rec.realizedPnlCNY=flowCNY(rec,monthKey)-reduction;
      return;
    }
    const position=Number(hold.qty||0), quantity=Number(rec.qty||0), trade=flowCNY(rec,monthKey);
    if(position<=0){ rec.costAddedCNY=trade; rec.realizedPnlCNY=0; return; }
    const reduction=Number(hold.costBasisCNY||0)*quantity/position;
    if(reduction) rec.costReductionCNY=reduction;
    rec.realizedPnlCNY=trade-reduction;
  }
}
function validateFlowCapacity(month,rec){
  const EPS=0.000001;
  if(rec.kind==="buy"){
    const holding=assetByFlow(month,rec,"to");
    if(!holding) throw new Error("买入资产不存在");
    const position=Number(holding.qty||0), bought=Number(rec.qty||0);
    if(holding.cls==="stock"&&position<0&&bought>-position+EPS)
      throw new Error(`买入数量会从空头穿过零仓。请先回补 ${fmtQuantity(-position)} 股至 0，再用第二笔买入建立多头`);
  }else if(rec.kind==="sell"){
    const holding=assetByFlow(month,rec,"from");
    if(!holding) throw new Error("卖出资产不存在");
    const available=holding.cls==="stock"?Number(holding.qty||0):Number(holding.value||0);
    const sold=holding.cls==="stock"?Number(rec.qty||0):holdingFlowAmount(rec);
    if(holding.cls==="stock"&&available>0&&sold>available+EPS)
      throw new Error(`卖出数量会从多头穿过零仓。请先卖出 ${fmtQuantity(available)} 股至 0，再用第二笔卖出建立空头`);
    if(holding.cls!=="stock"&&sold>available+EPS) throw new Error(`卖出金额超过当前持仓（可用 ${fmtFull(available)}）`);
  }else if(rec.kind==="repay"){
    const liability=assetByFlow(month,rec,"to");
    if(!liability) throw new Error("还款负债不存在");
    if(flowAmount(rec)>Number(liability.value||0)+EPS) throw new Error(`还款金额超过当前负债余额（可还 ${fmtFull(liability.value)}）`);
  }
}
function removeUnreferencedOpenedAssets(month){
  const refs=new Set(month.flows.flatMap(flow=>[flow.fromAssetId,flow.toAssetId]).filter(Boolean));
  month.balance=month.balance.filter(row=>!row.openedThisMonth||refs.has(row.id));
}

$("btnFlowOk").addEventListener("click",async()=>{
  let draft;
  try{ draft=buildFlowDraft(); }catch(error){ alert(error.message); return; }
  const editId=$("flowDialog").dataset.edit;
  const flowLabel=`${editId?"修改":"新增"}流水：${FLOW_TYPES[draft.rec.kind]?.name||draft.rec.kind}`;
  const ok=await transact(flowLabel,()=>{
    const m=ledger.months[activeMonth], {rec,newAsset}=draft;
    if(editId){
      const pos=m.flows.findIndex(flow=>flow.id===editId);
      if(pos<0) throw new Error("原流水不存在");
      applyFlow(m.flows[pos],-1); rec.id=editId; m.flows[pos]=rec;
    }else{ rec.id=uid("f"); m.flows.push(rec); }
    if(newAsset){ m.balance.push(newAsset); if(curFx()[newAsset.currency]==null) curFx()[newAsset.currency]=1; }
    validateFlowCapacity(m,rec);
    refreshFlowCostMetadata(m,rec);
    applyFlow(rec,+1);
    removeUnreferencedOpenedAssets(m);
  });
  if(ok) $("flowDialog").hidden=true;
});

function renderAll(){
  const hasLedger=Boolean(ledger);
  if(hasLedger) document.body.classList.remove("launch-mode");
  document.querySelector(".trend-area").hidden = !hasLedger;
  $("monthTabs").hidden = !hasLedger;
  $("monthPanel").hidden = !hasLedger;
  applyLedgerIdentity(); renderLedgerManager();
  if(hasLedger){ renderMonthTabs(); renderMonthPanel(); renderTrend(); }
  else { $("monthTabs").innerHTML=""; $("monthPanel").innerHTML=""; renderTrend(); }
  renderStorageInfo();
}
