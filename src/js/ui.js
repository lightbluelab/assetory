// ---------- 渲染: 顶部 ----------
function applyLedgerIdentity(){
  $("pageTitle").textContent = ledger ? `${APP_NAME} - ${ledger.name}` : APP_NAME;
  $("brandName").textContent = ledger ? ledger.name : "资产价值追踪";
}
function renderLedgerManager(){
  const names=Object.keys(registry).sort();
  $("ledgerManagerCurrent").innerHTML = ledger ? `当前账本：<b>${escapeHTML(ledger.name)}</b>` : "当前未打开账本";
  $("btnBackup").disabled=!ledger;
  $("btnManagerRename").disabled=!ledger;
  $("btnManagerPassword").disabled=!ledger;
  $("btnManagerPassword").textContent=encryptionKey?"修改密码":"设置密码";
  $("ledgerManagerList").innerHTML = names.length
    ? names.map(n=>`<div class="ledger-item"><button class="ledger-switch" data-ledger-switch="${escapeAttr(n)}"><span class="ledger-name">${escapeHTML(n)}</span><span class="ledger-state">${ledger&&n===ledger.name?"当前":"切换"}</span></button><button class="mini danger" data-ledger-remove="${escapeAttr(n)}">删除记录</button></div>`).join("")
    : `<div class="empty">尚未打开或创建账本</div>`;
}
function renderStorageInfo(){
  if(!ledger){ $("storageInfo").textContent=""; return; }
  const bytes = new Blob([JSON.stringify(ledger)]).size;
  const mCount = Object.keys(ledger.months).length;
  const location = demoMode ? " · 演示模式（未保存）" : (fileHandle ? ` · ${directoryHandle?.name||"本地文件"}` : " · 导入模式");
  $("storageInfo").textContent = `${mCount} 个月 · ${(bytes/1024).toFixed(1)} KB${location}`;
}

// ---------- 渲染: 月份 tabs ----------
function renderMonthTabs(){
  const nav = $("monthTabs");
  const keys = monthKeys();
  if(activeMonth && !ledger.months[activeMonth]) activeMonth=null;
  if(!activeMonth && keys.length) activeMonth = keys[keys.length-1];
  const latestKey=keys[keys.length-1];
  nav.innerHTML = keys.map(k=>{
    return `
    <div class="month-tab ${k===activeMonth?"active":""}" data-m="${k}">
      <span class="lbl">${k}</span>${k===latestKey?`<span class="close" data-del="${k}" title="删除此月（将先下载备份）">✕</span>`:""}</div>`;
  }).join("") + `<button class="add-tab" id="btnAddMonth">＋ 添加月份</button>`;

  nav.querySelectorAll(".month-tab").forEach(el=>{
    el.addEventListener("click",()=>{
      if(activeMonth!==el.dataset.m){ balanceEditMode=false; flowEditMode=false; }
      activeMonth=el.dataset.m; renderMonthTabs(); renderMonthPanel();
    });
  });
  nav.querySelectorAll(".close").forEach(el=>{
    el.addEventListener("click",async e=>{
      e.stopPropagation();
      const k=el.dataset.del;
      // 只允许删除最新月
      if(k!==latestKey){
        alert(`只允许删除最新月份（${latestKey}）。\n「${k}」是旧月份，无法删除以防止数据链断裂。`);
        return;
      }
      // 检查是否被后续月份依赖（理论上最新月不会被依赖，但保险起见）
      const hasDep=Object.values(ledger.months).some(m=>m.copiedFrom===k);
      if(hasDep){
        alert(`「${k}」被后续月份引用，无法删除。`);
        return;
      }
      if(!confirm(`删除 ${k} 的全部数据？\n⚠️ 将先自动备份当前 JSON 文件，然后删除。`)) return;
      const backupName=(ledger.name||"ledger").replace(/_ledger_data\.json$/,"")+`_backup_before_del_${k}.json`;
      if(!(await backupCurrentLedger(backupName))) return;
      const previousActive=activeMonth;
      if(activeMonth===k) activeMonth=null;
      const ok=await transact("删除月份",()=>{ delete ledger.months[k]; },{touch:false});
      if(!ok) activeMonth=previousActive;
    });
  });
  $("btnAddMonth").addEventListener("click",addMonth);
  requestAnimationFrame(()=>nav.querySelector(".month-tab.active")?.scrollIntoView({block:"nearest",inline:"nearest"}));
}

async function addMonth(){
  const now=new Date();
  const def = now.getFullYear()+"-"+String(now.getMonth()+1).padStart(2,"0");
  const k = prompt("添加月份 (YYYY-MM):", def);
  if(!k) return;
  if(!isValidMonthKey(k)){ alert("请输入有效月份（YYYY-MM）"); return; }
  if(ledger.months[k]){ balanceEditMode=false; flowEditMode=false; activeMonth=k; renderMonthTabs(); renderMonthPanel(); return; }
  const month=newMonth();
  const keys=monthKeys();
  const next=keys.find(x=>x>k)||null;
  // 取最近的一个更早月份作为拷贝对象: 拷贝资产负债表 + 汇率, 不拷贝流水
  const prev = keys.filter(x=>x<k).pop();
  if(prev){
    // 拷贝上月资产,但已清仓(数量/金额归零)的持有资产不再带入
    month.balance = ledger.months[prev].balance
      .map(r=>{
        const c={...r};
        delete c.openedThisMonth;
        delete c.priceStatus; delete c.priceAt; delete c.manualPriceAt;
        if(isClosed(c)) c.inactive=true; else delete c.inactive;
        return c;
      });
    month.fxRates = {...(ledger.months[prev].fxRates||{CNY:1})};
    month.copiedFrom = prev;
    month.sourceUpdatedAt = ledger.months[prev].updatedAt||month.createdAt;
    month.sourceRevision=Number(ledger.months[prev].revision||0);
    month.opening = month.balance.map(r=>({id:r.id,cls:r.cls,name:r.name,qty:r.qty,value:r.value,price:r.price}));
  }
  const previousActive=activeMonth; balanceEditMode=false; flowEditMode=false; activeMonth=k;
  const ok=await transact("添加月份",()=>{
    ledger.months[k]=month;
    applyRecurringFlowsToMonth(k);
    // 在现有月份之间补建月份时，把原直接子月改为继承新月份，保持单一时间链。
    if(prev&&next&&ledger.months[next]?.copiedFrom===prev){
      ledger.months[next].copiedFrom=k;
      ledger.months[next].sourceRevision=Number(month.revision||0);
      ledger.months[next].sourceUpdatedAt=month.updatedAt;
    }
  },{touch:false});
  if(!ok) activeMonth=previousActive;
}

// ---------- 渲染: 月面板 (资产负债表) ----------
function renderMonthPanel(){
  const el = $("monthPanel");
  if(!ledger){ el.innerHTML = `<div class="empty">请先「新建账本」或「打开…」一个账本。</div>`; return; }
  if(!activeMonth){ el.innerHTML = `<div class="empty">还没有月份，点上方「＋ 添加月份」开始。</div>`; return; }
  const m = ledger.months[activeMonth];
  const t = monthTotals(activeMonth);
  const net = t.net || 0;
  const prevKey=previousMonthKey(activeMonth);
  const prevTotals=ledger.months[prevKey] ? monthTotals(prevKey) : null;
  const cashFlow=cashFlowTotals(activeMonth);
  const prevCashFlow=prevTotals ? cashFlowTotals(prevKey) : null;
  // 与整体趋势一致：若中间月份缺失，仍以前一个已存在月份作为盈亏比较基准。
  const pnlPrevKey=monthKeys().filter(k=>k<activeMonth).pop()||null;
  const assetPnl=assetProfitAttribution(activeMonth,pnlPrevKey);
  const manualFields=new Set((reconcile(activeMonth)?.issues||[]).filter(i=>i.id&&i.field).map(i=>`${i.id}:${i.field}`));
  const metricCard=(label,value,prevValue)=>{
    const valueClass=value<0?"neg":"";
    if(prevValue==null) return `<div class="card"><div class="label">${label}</div><div class="value num ${valueClass}">${amount(value)}</div></div>`;
    const delta=value-prevValue, deltaClass=delta>0?"pos":delta<0?"neg":"";
    const pct=prevValue===0 ? "—" : `${delta>0?"+":""}${(delta/Math.abs(prevValue)*100).toFixed(1)}%`;
    return `<div class="card"><div class="label">${label}</div><div class="value num ${valueClass}">${amount(value)}</div>
      <div class="cf-sub mut">月环比 <span class="num ${deltaClass}">${delta>0?"+":""}${amount(delta)}</span> · <span class="${deltaClass}">${pct}</span></div></div>`;
  };
  const pnlCell=(value,id)=>{
    const tone=value>0?"pos":value<0?"neg":"pnl-zero";
    const detail=assetPnl.entries.find(entry=>entry.id===id);
    const title=detail?.row?.cls==="cash"
      ? `本月盈亏：${fmtFull(value)}\n汇率影响：${fmtFull(detail.fxImpact||0)}\n资产收益：${fmtFull(detail.income||0)}\n余额调整：${fmtFull(detail.manualAdjustment||0)}`
      : detail?`本月盈亏：${fmtFull(value)}\n已实现：${fmtFull(detail.realized||0)}\n资产收益：${fmtFull(detail.income||0)}\n估值/汇兑：${fmtFull(detail.unrealized||0)}`:`完整本月盈亏：${fmtFull(value)}`;
    return `<span class="amount ${tone}" title="${escapeAttr(title)}">${value>0?"+":""}${fmtTrend(value)}</span>`;
  };

  // 按分组聚合
  const groups = {};
  const visibleBalance=m.balance.map((r,idx)=>({r,idx})).filter(({r})=>!r.inactive);
  visibleBalance.forEach(({r,idx})=>{ (groups[r.group||"未分组"] ||= []).push({r,idx}); });
  // 分组之间按组总金额降序
  const groupNames = Object.keys(groups).sort((a,b)=>{
    const sa=groups[a].reduce((s,x)=>s+rowCNY(x.r),0);
    const sb=groups[b].reduce((s,x)=>s+rowCNY(x.r),0);
    return sb-sa;
  });
  const sortedGroups=groupNames.map(name=>({name,items:groups[name].slice().sort((a,b)=>rowCNY(b.r)-rowCNY(a.r))}));

  let body = "";
  if(!visibleBalance.length){
    body = `<tr><td colspan="9" class="empty">本月暂无资产条目，点「＋ 添加资产」开始。</td></tr>`;
  }else{
    sortedGroups.forEach(({name:g,items})=>{
      let gSum=0, gPnl=0, gAssets=0, gLiabs=0;
      items.forEach(({r})=>{ const value=rowCNY(r); gSum+=value; gPnl+=assetPnl.rowPnl[r.id]||0; if(value>=0) gAssets+=value; else gLiabs+=Math.abs(value); });
      // 分组标题行
      body += `<tr class="group-head"><td colspan="9">${escapeHTML(g)}</td></tr>`;
      // 资产行
      body += items.map(({r,idx})=>{
        const cls=ASSET_CLASSES[r.cls]; const cny=rowCNY(r);
        const pct = cny<0 ? (t.liab?Math.abs(cny/t.liab*100):0) : (t.assets?cny/t.assets*100:0);
        const pnl=assetPnl.rowPnl[r.id]||0;
        const manual=field=>manualFields.has(`${r.id}:${field}`)?` <span class="badge manual" title="该字段存在未由流水解释的手动调整">手调</span>`:"";
        const manualPriceBadge=r.manualPriceAt===activeMonth
          ? ` <span class="badge manual-ok" title="本月已人工校正">✓</span>`
          : ` <button type="button" class="badge manual price-status-btn" data-price-edit="${idx}" title="需要人工维护；点击修改价格" aria-label="修改价格">✎</button>`;
        let priceCell="-";
        if(r.cls==="stock"){
          const badge = (r.auto && r.priceStatus==="ok")?`<span class="badge ok" title="已更新 ${escapeAttr(r.priceAt||"")}">✓</span>`
                     : ((r.auto && r.priceStatus==="warn")?`<button type="button" class="badge warn price-status-btn" data-price-edit="${idx}" title="自动获取失败；点击手动修改价格" aria-label="修改价格">❗</button>`
                     : ((r.auto&&r.manualPriceAt===activeMonth)?`<span class="badge manual-ok" title="已手动修正">✓</span>`:(r.auto?"":manualPriceBadge)));
          priceCell=`${moneyCell(r.price,r.currency||"CNY",fmtPrice)} ${badge}`;
        }else if(!cls.hasQty){
          priceCell=moneyCell(rowNative(r),r.currency||"CNY")+((r.cls==="fund"||r.cls==="fixed")?manualPriceBadge:"");
        }
        const autoBtn = (cls&&cls.hasAuto&&r.auto)
          ? `<button class="mini icon-btn" data-price="${idx}" title="更新股价：${escapeAttr(r.market||"")}:${escapeAttr(r.symbol||"")}" aria-label="更新股价">↻</button>` : "";
        return `<tr>
          <td>${escapeHTML(r.name||"-")}${r.symbol?` <span class="mut">${escapeHTML(r.market||"")}${r.market?":":""}${escapeHTML(r.symbol)}</span>`:""} ${positionBadge(r)}</td>
          <td>${escapeHTML(cls?cls.name:r.cls)}</td>
          <td>${escapeHTML(cls&&cls.hasAccount?(r.account||"-"):"-")}</td>
          <td class="num">${cls&&cls.hasQty?fmtQuantity(r.qty)+manual("qty"):"-"}</td>
          <td class="num">${priceCell}</td>
          <td class="num ${cny<0?"neg":""}">${fmtMoney(cny)}${manual("value")}</td>
          <td class="num mut">${pct.toFixed(1)}%</td>
          <td class="num">${pnlCell(pnl,r.id)}</td>
          <td class="ops">${autoBtn}<button class="mini icon-btn" data-edit="${idx}" title="编辑资产与价格" aria-label="编辑资产">✎</button><button class="mini danger icon-btn" data-del="${idx}" title="删除资产" aria-label="删除资产">×</button></td>
        </tr>`;
      }).join("");
      // 分组汇总行
      const assetShare=t.assets?(gAssets/t.assets*100):0;
      const liabilityShare=t.liab?(gLiabs/Math.abs(t.liab)*100):0;
      const gPct = gAssets&&gLiabs
        ? `资 ${assetShare.toFixed(1)}% · 债 ${liabilityShare.toFixed(1)}%`
        : `${(gLiabs?liabilityShare:assetShare).toFixed(1)}%`;
      body += `<tr class="subtotal"><td class="subtotal-label">小计</td><td></td><td></td><td></td><td></td>
        <td class="num subtotal-amount ${gSum<0?"neg":""}">${fmtMoney(gSum)}</td><td class="num mut subtotal-pct">${gPct}</td><td class="num">${pnlCell(gPnl)}</td><td></td></tr>`;
    });
  }
  const mobileBalance = sortedGroups.map(({name:g,items})=>{
    return `<div class="mobile-group">${escapeHTML(g)}</div>`+items.map(({r,idx})=>{
      const cls=ASSET_CLASSES[r.cls], cny=rowCNY(r), pct=cny<0?(t.liab?Math.abs(cny/t.liab*100):0):(t.assets?cny/t.assets*100:0);
      const pnl=assetPnl.rowPnl[r.id]||0;
      const needsManualPrice=(r.cls==="fund"||r.cls==="fixed")&&r.manualPriceAt!==activeMonth;
      const failedAutoPrice=r.cls==="stock"&&r.auto&&r.priceStatus==="warn";
      const priceAction=(needsManualPrice||failedAutoPrice)?` <button type="button" class="badge ${failedAutoPrice?"warn":"manual"} price-status-btn" data-price-edit="${idx}" title="点击修改价格" aria-label="修改价格">${failedAutoPrice?"❗":"✎"}</button>`:"";
      const price=(cls.hasQty?`${fmtQuantity(r.qty)} × ${fmtPrice(r.price)} ${escapeHTML(r.currency||"CNY")}`:moneyCell(rowNative(r),r.currency||"CNY"))+priceAction;
      const autoBtn=(cls.hasAuto&&r.auto)?`<button class="mini icon-btn" data-price="${idx}" title="更新股价">↻</button>`:"";
      return `<article class="mobile-asset"><div class="mobile-title"><span>${escapeHTML(r.name||"-")} ${positionBadge(r)}</span><span class="${cny<0?"neg":""}">${fmtMoney(cny)}</span></div>
        <div class="mobile-meta"><span>${escapeHTML(cls.name)} · ${escapeHTML(r.account||r.currency||"-")}</span><span>占${pct.toFixed(1)}%</span></div>
        <div class="mobile-values"><span>${price}</span><span class="${pnl>0?"pos":pnl<0?"neg":""}">本月 ${pnl>0?"+":""}${fmtTrend(pnl)}</span></div>
        <div class="mobile-ops">${autoBtn}<button class="mini icon-btn" data-edit="${idx}" title="编辑资产与价格">✎</button><button class="mini danger icon-btn" data-del="${idx}" title="删除资产">×</button></div></article>`;
    }).join("");
  }).join("");

  el.innerHTML = `
    ${renderDemoBanner()}
    ${renderMonthMeta()}
    ${renderCopyBanner()}
    <div class="cards metric-cards">
      ${metricCard("净资产", net, prevTotals?.net)}
      ${metricCard("总资产", t.assets, prevTotals?.assets)}
      ${metricCard("总负债", t.liab, prevTotals?.liab)}
      ${metricCard("净现金流", cashFlow.net, prevCashFlow?.net)}
    </div>
    <div class="tbl-head">
      <h3>资产负债表 · ${activeMonth}</h3>
      <div>
        <button class="mini" id="btnUpdateAll" title="批量刷新本月所有可自动更新的股价，并自动获取汇率">↻ 更新股价和汇率</button>
        <button class="mini" id="btnBalanceEdit">编辑</button>
        <button class="primary mini" id="btnAddAsset">＋ 添加资产</button>
      </div>
    </div>
    <div class="table-wrap balance-table-wrap"><table class="balance">
      <thead><tr><th>项目</th><th>类别</th><th>账户</th><th>数量</th><th>价格</th><th>金额(¥)</th><th>占比</th><th>本月盈亏</th><th>操作</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    <div class="balance-mobile">${mobileBalance||`<div class="empty">本月暂无资产条目</div>`}</div>
    ${renderFxBar()}
    <div class="tbl-head" style="margin-top:24px">
      <h3>流水表 · ${activeMonth}</h3>
      <div><button class="mini" id="btnRecurringToggle" type="button">周期流水</button><button class="mini" id="btnFlowEdit">编辑</button><button class="primary mini" id="btnAddFlow">＋ 添加流水</button></div>
    </div>
    ${renderRecurringFlowManager()}
    ${renderFlowSummary()}
    <div class="table-wrap"><table class="flow">
      <thead><tr><th>日期</th><th>类型</th><th>流出方</th><th>流入方</th><th>金额</th><th>备注</th><th>操作</th></tr></thead>
      <tbody>${renderFlowRows()}</tbody>
    </table></div>
    <p class="hint">收入、资产收益、支出、转账、买入、卖出、还款和手工估值调整会自动同步修改上方资产负债表；删除流水会回滚其影响。</p>`;

  // 事件
  const demoBackup=$("btnDemoBackup"); if(demoBackup) demoBackup.addEventListener("click",()=>backupCurrentLedger());
  const demoCreate=$("btnDemoCreate"); if(demoCreate) demoCreate.addEventListener("click",openCreateDialog);
  const setTableEditing=(selector,button,editing)=>{
    const table=el.querySelector(selector);
    table.classList.toggle("editing",editing);
    if(selector===".balance") el.querySelector(".balance-mobile")?.classList.toggle("editing",editing);
    button.textContent=editing?"完成":"编辑";
  };
  setTableEditing(".balance",$("btnBalanceEdit"),balanceEditMode);
  setTableEditing(".flow",$("btnFlowEdit"),flowEditMode);
  $("btnBalanceEdit").addEventListener("click",e=>{ balanceEditMode=!balanceEditMode; setTableEditing(".balance",e.currentTarget,balanceEditMode); });
  $("btnFlowEdit").addEventListener("click",e=>{ flowEditMode=!flowEditMode; setTableEditing(".flow",e.currentTarget,flowEditMode); });
  $("btnAddAsset").addEventListener("click",()=>openAssetDialog(null));
  $("btnUpdateAll").addEventListener("click",async()=>{ await updateAllPrices(); await autoFetchFx(); });
  el.querySelectorAll("[data-edit]").forEach(b=>b.addEventListener("click",()=>openAssetDialog(+b.dataset.edit)));
  el.querySelectorAll("[data-del]").forEach(b=>b.addEventListener("click",async()=>{
    const row=m.balance[+b.dataset.del];
    if(!row) return;
    const keys=monthKeys().filter(key=>key>=activeMonth);
    const related=keys.reduce((count,key)=>count+(ledger.months[key].flows||[]).filter(flow=>flow.fromAssetId===row.id||flow.toAssetId===row.id).length,0);
    if(!confirm(`删除资产「${row.name}」将影响 ${keys.length} 个月，并删除 ${related} 条相关流水。\n系统会先下载完整备份，是否继续？`)) return;
    if(!(await backupCurrentLedger())) return;
    await transact("删除资产",()=>{
      keys.forEach(key=>{
        const month=ledger.months[key];
        const relatedFlows=(month.flows||[]).filter(flow=>flow.fromAssetId===row.id||flow.toAssetId===row.id);
        // 先回滚流水对现金、负债及其他持仓的影响，再删除资产和流水记录。
        relatedFlows.forEach(flow=>applyFlowToBalance(month.balance,flow,-1));
        month.flows=(month.flows||[]).filter(flow=>flow.fromAssetId!==row.id&&flow.toAssetId!==row.id);
        month.balance=(month.balance||[]).filter(asset=>asset.id!==row.id);
        if(month.opening) month.opening=month.opening.filter(asset=>asset.id!==row.id);
        if(month.openingPrices) delete month.openingPrices[row.id];
        if(key!==activeMonth) markMonthChanged(key,`删除资产：${row.name}及关联流水`);
      });
      ledger.recurringFlows=(ledger.recurringFlows||[]).filter(rule=>rule.fromAssetId!==row.id&&rule.toAssetId!==row.id);
      // 后续月份的期初可能仍带有被删除流水造成的现金影响，沿继承链重建。
      let source=activeMonth;
      while(true){
        const child=childMonthOf(source);
        if(!child) break;
        rebuildChildFromParent(source,child);
        source=child;
      }
    });
  }));
  el.querySelectorAll("[data-price]").forEach(b=>b.addEventListener("click",()=>updateOnePrice(+b.dataset.price)));
  el.querySelectorAll("[data-price-edit]").forEach(b=>b.addEventListener("click",()=>openPriceEditor(+b.dataset.priceEdit)));
  $("btnAddFlow").addEventListener("click",()=>openFlowDialog(null));
  $("btnRecurringToggle").addEventListener("click",()=>{
    const panel=$("recurringManager");
    if(panel) panel.open=!panel.open;
  });
  el.querySelectorAll("[data-fedit]").forEach(b=>b.addEventListener("click",()=>openFlowDialog(b.dataset.fedit)));
  el.querySelectorAll("[data-fdel]").forEach(b=>b.addEventListener("click",()=>deleteFlow(b.dataset.fdel)));
  bindRecurringFlowManager();
  bindFxBar();
  const bn=$("btnSyncNext"); if(bn) bn.addEventListener("click",()=>{ if(confirm("将本月期末同步为下月期初并重算下月？")) syncToNext(activeMonth); });
  const ba=$("btnSyncAll"); if(ba) ba.addEventListener("click",()=>{ if(confirm("沿拷贝链把改动同步到后续所有月份并重算？")) syncToAll(activeMonth); });
}

// ---------- 流水表渲染 ----------
function renderDemoBanner(){
  if(!demoMode) return "";
  return `<div class="banner info">当前为示例账本，数据仅在本次浏览器会话中展示，不会自动保存。
    <button class="mini" id="btnDemoBackup">下载示例副本</button>
    <button class="mini" id="btnDemoCreate">新建自己的账本</button>
  </div>`;
}
function assetLabel(assetId){
  const m=ledger.months[activeMonth]; const r=m.balance.find(row=>row.id===assetId);
  if(!r) return "(已删除)";
  const acc = r.account? r.account+"·" : "";
  return acc + (r.name||"");
}
// ---------- 月面板顶部: 拷贝来源 + 对账提示 ----------
function needsChildSync(fromKey,childKey){
  const parent=ledger.months[fromKey], child=ledger.months[childKey];
  if(!parent||!child) return false;
  return Number(parent.revision||0)>Number(child.sourceRevision||0);
}
function monthTimeText(value){
  const time=Date.parse(value||"");
  return Number.isFinite(time)?new Date(time).toLocaleString("zh-CN",{hour12:false}):"—";
}
function changesSince(month,revision){
  const current=Number(month.revision||0), received=Number(revision||0);
  const changes=(month.changeLog||[]).filter(change=>Number(change.revision)>received&&Number(change.revision)<=current);
  const firstRecorded=changes.length?Math.min(...changes.map(change=>Number(change.revision))):Infinity;
  const out=[];
  if(received+1<firstRecorded) out.push({revision:`v${received+1}–v${Math.min(current,firstRecorded-1)}`,label:"早期变更未记录详情"});
  changes.forEach(change=>out.push({revision:`v${Number(change.revision)}`,label:change.label,at:change.at,details:Array.isArray(change.details)?change.details:[]}));
  return out;
}
function renderCopyBanner(){
  const m=ledger.months[activeMonth];
  const child=childMonthOf(activeMonth);
  if(!child||!needsChildSync(activeMonth,child)) return "";
  const next=ledger.months[child];
  const changes=changesSince(m,next.sourceRevision);
  const changeHtml=changes.length
    ? `<ul class="sync-changes">${changes.slice(-12).map(change=>`<li><b>${escapeHTML(change.revision)}</b>　${escapeHTML(change.label)}${change.at?` <span class="mut">${escapeHTML(monthTimeText(change.at))}</span>`:""}${change.details?.length?`<ul class="sync-change-details">${change.details.map(detail=>`<li>${escapeHTML(detail)}</li>`).join("")}</ul>`:""}</li>`).join("")}${changes.length>12?`<li class="mut">另有 ${changes.length-12} 项较早修改</li>`:""}</ul>`
    : `<p class="mut" style="margin:8px 0 0">未找到可读的变更摘要；同步后将开始记录。</p>`;
  return `<details class="reconcile-status warn"><summary><i class="status-dot"></i><span class="status-label">后续月份待同步</span><span class="status-detail">${child} 期初待更新</span></summary>
    <div class="status-content">自 ${child} 上次接收 ${activeMonth} 的版本后，发生以下修改：
      ${changeHtml}
      <br>本月：创建于 ${monthTimeText(m.createdAt)}；最后修改 ${monthTimeText(m.updatedAt)}
      <br>${child}：创建于 ${monthTimeText(next.createdAt)}；最后修改 ${monthTimeText(next.updatedAt)}；已接收来源版本 ${Number(next.sourceRevision||0)} / 当前来源版本 ${Number(m.revision||0)}
      <div class="sync-row"><button class="mini" id="btnSyncNext">同步到下月</button><button class="mini" id="btnSyncAll">同步到后续所有月份</button></div></div></details>`;
}
function renderMonthMeta(){
  const m=ledger.months[activeMonth];
  const relation=m.copiedFrom?`继承自 ${escapeHTML(m.copiedFrom)}（来源版本 ${Number(m.sourceRevision||0)}）`:"独立创建";
  return `<div class="month-meta mut">创建：${monthTimeText(m.createdAt)}　最后修改：${monthTimeText(m.updatedAt)}　${relation}</div>`;
}

function renderFlowSummary(){
  const {inflow,outflow,net,detail}=cashFlowTotals(activeMonth);
  return `<div class="cashflow">
    <div class="cf-main">
      <div class="cf-item in"><span class="cf-lbl">现金流入</span><span class="cf-val num">+${amount(inflow)}</span>
        <span class="cf-sub mut">现金收入 ${fmt(detail.income)} · 资产收益 ${fmt(detail.dividend)} · 卖出 ${fmt(detail.sell)}${detail.nonCashIncome?` · 非现金收入 ${fmt(detail.nonCashIncome)}（不计现金流）`:""}</span></div>
      <div class="cf-arrow">→</div>
      <div class="cf-item out"><span class="cf-lbl">现金流出</span><span class="cf-val num">-${amount(outflow)}</span>
        <span class="cf-sub mut">支出 ${fmt(detail.expense)} · 买入 ${fmt(detail.buy)} · 还款 ${fmt(detail.repay)}</span></div>
      <div class="cf-arrow">=</div>
      <div class="cf-item net"><span class="cf-lbl">净现金流</span>
        <span class="cf-val num ${net<0?"neg":"pos"}">${net>=0?"+":""}${amount(net)}</span>
        <span class="cf-sub mut">内部转账 ${fmt(detail.transfer)}（不计净额）</span></div>
    </div>
  </div>`;
}
function renderRecurringFlowManager(){
  const rules=ledger.recurringFlows||[];
  const rows=rules.map(rule=>`<div class="recurring-row">
    <div class="recurring-row-main"><strong>${escapeHTML(recurringRuleLabel(rule))}</strong><span class="mut">${moneyCell(rule.amount,recurringRuleCurrency(rule))}${rule.note?` · ${escapeHTML(rule.note)}`:""}</span></div>
    <div class="recurring-actions"><button class="mini" data-redit="${escapeAttr(rule.id)}">编辑</button><button class="mini danger" data-rdel="${escapeAttr(rule.id)}">删</button></div>
  </div>`).join("");
  return `<details id="recurringManager" class="recurring-manager"><summary>周期流水 <span class="mut">${rules.length?`${rules.length} 条规则`:"未设置"}</span></summary>
    <div class="recurring-content"><div class="recurring-list">${rows||`<div class="mut">暂无周期流水规则。</div>`}</div><button class="mini" id="btnAddRecurring">＋ 添加周期流水</button></div>
  </details>`;
}
function renderFlowRows(){
  const m=ledger.months[activeMonth];
  if(!m.flows || !m.flows.length)
    return `<tr><td colspan="7" class="empty">本月暂无流水，点「＋ 添加流水」开始。</td></tr>`;
  const sorted = m.flows.map((f,i)=>({f,i})).sort((a,b)=>(a.f.date||"").localeCompare(b.f.date||""));
  return sorted.map(({f,i})=>{
    const ft=FLOW_TYPES[f.kind];
    const fromTxt = escapeHTML(f.fromAssetId ? assetLabel(f.fromAssetId) : (f.fromText||"-"));
    const toTxt   = escapeHTML(f.toAssetId ? assetLabel(f.toAssetId) : (f.toText||"-"));
    let amt = moneyCell(f.amount,f.currency||"CNY");
    if(f.kind==="dividend" && f.holdingAmount!=null && f.holdingCurrency && f.holdingCurrency!==f.currency)
      amt = moneyCell(f.holdingAmount,f.holdingCurrency) + ' <span class="mut">→</span> ' + amt;
    if(f.qty!=null&&f.price!=null) amt += ` <span class="mut">(${fmtQuantity(f.qty)} × ${fmtPrice(f.price)})</span>`;
    const typeCell = escapeHTML(ft?ft.name:f.kind) + (f.recurringId?` <span class="badge" title="由周期流水规则生成">↻</span>`:"") + (f.subcat?` <span class="mut">/${escapeHTML(f.subcat)}</span>`:"");
    const direction=f.kind==="valuation"?(Number(f.amount||0)>=0?"flow-in":"flow-out"):(f.kind==="income"||f.kind==="dividend"||f.kind==="sell")?"flow-in":((f.kind==="expense"||f.kind==="buy"||f.kind==="repay")?"flow-out":"");
    return `<tr>
      <td>${escapeHTML(f.date||"-")}</td>
      <td class="${direction}">${typeCell}</td>
      <td>${fromTxt}<span class="flow-route-mobile">→ ${toTxt}</span></td>
      <td>${toTxt}</td>
      <td class="num ${direction}">${amt}</td>
      <td>${escapeHTML(f.note||"")}</td>
      <td class="ops">${f.kind==="valuation"?"":`<button class="mini" data-fedit="${escapeAttr(f.id)}">编辑</button>`}<button class="mini danger" data-fdel="${escapeAttr(f.id)}">删</button></td>
    </tr>`;
  }).join("");
}

function renderFxBar(){
  const curs = usedCurrencies();
  const items = curs.map(c=>{
    const st=(curFx()._status&&curFx()._status[c]);
    const badge = c==="CNY" ? "" : (st==="ok"?`<span class="badge ok" title="已自动获取 ${escapeAttr(curFx()._date||"")}">✓</span>`
                  : (st==="warn"?`<span class="badge warn" title="自动获取失败,请手动填写">❗</span>`:""));
    return `<label class="fx">${escapeHTML(c)}
      <input type="number" step="0.0001" data-fx="${escapeAttr(c)}" value="${fxRate(c)}" ${c==="CNY"?"disabled":""} style="width:90px" />${badge}
    </label>`;
  }).join("");
  return `<div class="fxbar"><span class="mut">本月汇率（→ 人民币，默认1，仅本月生效）：</span>${items}
    <button class="mini" id="btnAutoFx" title="按当月末/最近交易日自动获取汇率">↻ 自动获取汇率</button></div>`;
}
function bindFxBar(){
  document.querySelectorAll("[data-fx]").forEach(inp=>{
    inp.addEventListener("change",async()=>{
      const value=Number(inp.value);
      if(!Number.isFinite(value)||value<=0){ alert("请输入大于 0 的汇率"); return; }
      await transact("手动更新汇率",()=>{
        curFx()[inp.dataset.fx]=value;
        if(curFx()._status) curFx()._status[inp.dataset.fx]="manual";
      });
    });
  });
  const b=$("btnAutoFx"); if(b) b.addEventListener("click",autoFetchFx);
}
// 自动获取当月汇率(Frankfurter, 免key, 支持历史)。目标日=当月末与今天取较早者

// ---------- 资产录入/编辑对话框 ----------
function manualValuationDate(monthKey){
  const today=new Date().toISOString().slice(0,10);
  if(today.slice(0,7)===monthKey) return today;
  const [year,month]=monthKey.split("-").map(Number);
  return `${monthKey}-${String(new Date(year,month,0).getDate()).padStart(2,"0")}`;
}
function supportsManualValuationFlow(row){ return ["cash","liability","fixed"].includes(row?.cls); }
function openAssetDialog(editIdx){
  const m = ledger.months[activeMonth];
  refreshAssetSuggestions();
  const editing = editIdx!=null;
  const r = editing ? m.balance[editIdx] : {cls:"stock",currency:"CNY",auto:false};
  const dlg = $("assetDialog");
  $("assetDlgTitle").textContent = editing ? "编辑资产详情" : "添加资产";
  $("adCls").value = r.cls||"stock";
  $("adGroup").value = r.group||"";
  $("adName").value = r.name||"";
  $("adAccount").value = r.account||"";
  $("adQty").value = r.qty!=null?r.qty:"";
  $("adPrice").value = r.price!=null?r.price:"";
  $("adValue").value = r.value!=null?r.value:"";
  $("adCurrency").value = r.currency||"CNY";
  $("adAuto").checked = !!r.auto;
  $("adMarket").value = r.market||"";
  $("adSymbol").value = r.symbol||"";
  dlg.dataset.edit = editing ? editIdx : "";
  delete dlg.dataset.priceOnly;
  applyAssetFields();
  dlg.hidden=false;
}
function openPriceEditor(editIdx){
  openAssetDialog(editIdx);
  const dlg=$("assetDialog"), row=ledger.months[activeMonth]?.balance?.[editIdx];
  if(!row) return;
  dlg.dataset.priceOnly="1";
  $("assetDlgTitle").textContent=row.cls==="stock"?"修改价格":"修改估值";
  applyAssetFields();
  const input=$(row.cls==="stock"?"adPrice":"adValue");
  requestAnimationFrame(()=>{ input?.focus(); input?.select(); });
}
// 根据大类显示/隐藏字段
function applyAssetFields(){
  const cls = ASSET_CLASSES[$("adCls").value];
  const show=(id,on)=>{ $(id).style.display = on?"":"none"; };
  show("f-account", cls.hasAccount);
  show("f-qty", cls.hasQty);
  show("f-price", cls.hasQty);      // 股票用 数量+价格
  show("f-value", !cls.hasQty);     // 其它用 直接金额
  show("f-auto", cls.hasAuto);
  const autoOn = cls.hasAuto && $("adAuto").checked;
  show("f-market", autoOn);
  show("f-symbol", autoOn);
  $("f-value").querySelector("span").textContent = ($("adCls").value==="liability"||$("adCls").value==="fixed")
    ? "金额/价值(原币)" : "金额(原币)";
  const editing=!!$("assetDialog").dataset.edit;
  const priceOnly=$("assetDialog").dataset.priceOnly==="1";
  ["adCls","adName","adAccount","adCurrency","adQty"].forEach(id=>$(id).disabled=editing);
  $("adGroup").disabled=priceOnly;
  $("adAuto").disabled=priceOnly||!cls.hasAuto;
  $("adMarket").disabled=priceOnly||!autoOn;
  $("adSymbol").disabled=priceOnly||!autoOn;
}
$("adCls").addEventListener("change",applyAssetFields);
$("adAuto").addEventListener("change",applyAssetFields);
$("btnAssetCancel").addEventListener("click",()=>{ $("assetDialog").hidden=true; });
$("btnAssetOk").addEventListener("click",async()=>{
  const m = ledger.months[activeMonth];
  const idx = $("assetDialog").dataset.edit;
  if(idx!==""){
    const row=m.balance[+idx];
    if(!row) return;
    const isStock=row.cls==="stock";
    const nextPrice=isStock?Number($("adPrice").value):Number($("adValue").value);
    if(!Number.isFinite(nextPrice)||nextPrice<0){ alert("请输入不小于 0 的价格或估值"); return; }
    if(isStock&&$("adAuto").checked&&!textValue($("adSymbol").value,30)){ alert("开启自动更新时必须填写股票代码"); return; }
    const ok=await transact(`更新资产：${row.name||"未命名资产"}`,()=>{
      row.group=textValue($("adGroup").value,80)||"未分组";
      const priceChanged=isStock ? nextPrice!==Number(row.price||0) : nextPrice!==Number(row.value||0);
      if(isStock){
        const quoteChanged=row.auto!==$("adAuto").checked||row.market!==textValue($("adMarket").value,16)||row.symbol!==textValue($("adSymbol").value,30);
        row.price=nextPrice;
        row.auto=$("adAuto").checked;
        if(row.auto){ row.market=textValue($("adMarket").value,16); row.symbol=textValue($("adSymbol").value,30); }
        else { row.priceStatus=null; row.market=""; row.symbol=""; }
        if(quoteChanged&&m.openingPrices) delete m.openingPrices[row.id];
        if(priceChanged){ row.manualPriceAt=activeMonth; if(row.auto) row.priceStatus="manual"; }
      }else{
        const adjustment=nextPrice-Number(row.value||0);
        if(supportsManualValuationFlow(row)&&Math.abs(adjustment)>0.000001){
          const rec={id:uid("f"),kind:"valuation",date:manualValuationDate(activeMonth),toAssetId:row.id,
            amount:adjustment,currency:row.currency||"CNY",note:"手工估值调整"};
          m.flows.push(rec);
          applyFlow(rec,+1);
        }else row.value=nextPrice;
        if(row.cls==="fund"||row.cls==="fixed") row.manualPriceAt=activeMonth;
      }
    });
    if(ok) $("assetDialog").hidden=true;
    return;
  }
  const cls = ASSET_CLASSES[$("adCls").value];
  const row = {
    cls: $("adCls").value,
    group: textValue($("adGroup").value,80)||"未分组",
    name: textValue($("adName").value,80),
    account: cls.hasAccount ? textValue($("adAccount").value,80) : "",
    currency: textValue($("adCurrency").value,12)||"CNY",
  };
  if(!row.name){ alert("请填写项目名称"); return; }
  if(cls.hasQty){
    row.qty = Number($("adQty").value);
    row.price = Number($("adPrice").value);
    if(!Number.isFinite(row.qty)||!Number.isFinite(row.price)||row.qty<0||row.price<0){ alert("数量和价格不能小于 0"); return; }
    row.auto = cls.hasAuto && $("adAuto").checked;
    if(row.auto){
      row.market=textValue($("adMarket").value,16); row.symbol=textValue($("adSymbol").value,30);
      if(!row.symbol){ alert("开启自动更新时必须填写股票代码"); return; }
    }
    else { row.priceStatus=null; row.market=""; row.symbol=""; }  // 手动价: 不显示自动状态标识
    row.manualPriceAt = row.auto ? null : activeMonth;
  }else{
    row.value = Number($("adValue").value)||0;
    row.manualPriceAt = (row.cls==="fund"||row.cls==="fixed") ? activeMonth : null;
  }
  // 确保货币进入当月汇率表
  row.costBasisCNY=Math.abs((row.cls==="stock"?row.qty*row.price:row.value)*fxRate(row.currency));
  const ok=await transact(`添加资产：${row.name}`,()=>{
    if(curFx()[row.currency]==null) curFx()[row.currency]=1;
    row.id=uid("a"); m.balance.push(row);
  });
  if(ok) $("assetDialog").hidden=true;
});


// ---------- 事件绑定 ----------
$("btnLedgerManager").addEventListener("click",()=>{ renderLedgerManager(); $("ledgerManagerDialog").hidden=false; });
$("btnBackup").addEventListener("click",()=>backupCurrentLedger());
$("fallbackJsonInput").addEventListener("change",async e=>{
  const file=e.target.files?.[0]; e.target.value="";
  if(file) await importFallbackFile(file);
});
$("btnManagerDone").addEventListener("click",()=>$("ledgerManagerDialog").hidden=true);
$("btnManagerCreate").addEventListener("click",()=>{ $("ledgerManagerDialog").hidden=true; openCreateDialog(); });
$("btnManagerOpen").addEventListener("click",async()=>{ $("ledgerManagerDialog").hidden=true; await openFromFile(); });
$("btnManagerRename").addEventListener("click",renameCurrentLedger);
$("btnManagerPassword").addEventListener("click",setLedgerPassword);
$("ledgerManagerList").addEventListener("click",e=>{
  const remove=e.target.closest("[data-ledger-remove]"); if(remove){ removeLedgerRecord(remove.dataset.ledgerRemove); return; }
  const switcher=e.target.closest("[data-ledger-switch]"); if(switcher) switchLedger(switcher.dataset.ledgerSwitch);
});
