"use strict";
/* =========================================================
   Wealth Tracker —— 单 JSON、本地优先的资产价值追踪工具
   -----------------------------------------------------------------
   一个账本 = 一个 JSON 文件。每月保存期末资产、流水、汇率、期初快照、
   同步版本与变更日志；流水通过稳定资产 ID 关联账户和持仓。
   Chrome/Edge 可通过 File System Access API 自动写回原文件；其他浏览器
   在内存中编辑后下载备份。localStorage 只记住最近账本名称，不保存账本数据。
   ========================================================= */

const APP_NAME = "WEALTH TRACKER";
// 资产大类定义: 决定录入时填哪些字段
const ASSET_CLASSES = {
  stock:     { name:"股票",     hasQty:true,  hasAccount:true,  hasAuto:true,  sign:1  },
  fund:      { name:"基金",     hasQty:false, hasAccount:true,  hasAuto:false, sign:1  },
  cash:      { name:"现金",     hasQty:false, hasAccount:true,  hasAuto:false, sign:1  },
  liability: { name:"负债",     hasQty:false, hasAccount:true,  hasAuto:false, sign:-1 },
  fixed:     { name:"固定资产", hasQty:false, hasAccount:false, hasAuto:false, sign:1  },
};
// 流水类型定义: from/to 指定各端是"哪类资产"还是自由文本
// side 值: 'cash'|'holding'(股票+基金+固定资产)|'asset'(全部非负债资产)|'liability'|'free'
const FLOW_TYPES = {
  income:   { name:"收入", from:"free",      to:"asset",     needQtyPrice:false, subcat:true, newAsset:true, toLabel:"流入资产" },
  // 保持 dividend 作为 JSON 内部标识，避免已保存账本失去兼容性。
  dividend: { name:"资产收益", from:"asset",   to:"cash",     needQtyPrice:false, newHolding:false, assetIncome:true, fromLabel:"收益来源（已有资产）", toLabel:"到账账户" },
  expense:  { name:"支出", from:"cash",      to:"free",      needQtyPrice:false, subcat:true  },
  transfer: { name:"转账", from:"cash",      to:"cash",      needQtyPrice:false },
  buy:      { name:"买入", from:"cash",      to:"holding",   needQtyPrice:true, newHolding:true  },
  sell:     { name:"卖出", from:"holding",   to:"cash",      needQtyPrice:true, newHolding:true },
  repay:    { name:"还款", from:"cash",      to:"liability", needQtyPrice:false },
};
const HAS_FS = ("showOpenFilePicker" in window && "showDirectoryPicker" in window);
const IDB_DB = "familyLedgerDB", IDB_STORE = "handles";

// ---------- 运行时状态 ----------
let ledger = null;          // 当前账本对象
let fileHandle = null;      // 绑定的本地文件句柄(必需)
let directoryHandle = null; // 创建账本时选择的目录句柄（用于显示与恢复）
let demoMode = false;       // 网页首次体验的示例账本：仅内存展示，需主动下载副本
let activeMonth = null;     // 当前选中的月份 tab
let balanceEditMode = false;// 资产表编辑状态跨重新渲染保留，切换月份时重置
let flowEditMode = false;   // 流水表编辑状态跨重新渲染保留，切换月份时重置
let encryptionKey = null;   // 仅保留在当前浏览器内存中的 AES 密钥
let encryptionMeta = null;
// 已知账本注册表: name -> fileHandle。会话内内存 + IndexedDB 持久化(句柄可跨刷新恢复)
const registry = {};


// ---------- 工具 ----------
function uid(p){ return (p||"id")+"_"+Date.now().toString(36)+Math.random().toString(36).slice(2,6); }
function escapeHTML(value){
  return String(value??"").replace(/[&<>'"]/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"}[ch]));
}
function escapeAttr(value){ return escapeHTML(value); }
function renderReadmeInline(value){
  let safe=escapeHTML(value);
  safe=safe.replace(/`([^`]+)`/g,"<code>$1</code>");
  safe=safe.replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>");
  return safe.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,(_,label,url)=>{
    const href=/^(https?:\/\/|\.\/|\/)/.test(url)?url:"#";
    const external=/^https?:\/\//.test(href);
    return `<a href="${escapeAttr(href)}"${external?' target="_blank" rel="noopener"':""}>${label}</a>`;
  });
}
function renderReadmeMarkdown(markdown){
  const out=[]; let list="", paragraph=[]; let inCode=false, code=[];
  const closeList=()=>{ if(list){ out.push(`</${list}>`); list=""; } };
  const flushParagraph=()=>{ if(paragraph.length){ out.push(`<p>${renderReadmeInline(paragraph.join(" "))}</p>`); paragraph=[]; } };
  const closeText=()=>{ flushParagraph(); closeList(); };
  for(const rawLine of String(markdown||"").replace(/\r/g,"").split("\n")){
    if(rawLine.trim().startsWith("```")){
      if(inCode) out.push(`<pre><code>${escapeHTML(code.join("\n"))}</code></pre>`);
      else closeText();
      inCode=!inCode; code=[]; continue;
    }
    if(inCode){ code.push(rawLine); continue; }
    const heading=rawLine.match(/^(#{1,3})\s+(.+)$/);
    const ordered=rawLine.match(/^\d+\.\s+(.+)$/);
    const unordered=rawLine.match(/^[-*]\s+(.+)$/);
    if(heading){ closeText(); out.push(`<h3>${renderReadmeInline(heading[2])}</h3>`); }
    else if(ordered||unordered){
      flushParagraph(); const type=ordered?"ol":"ul";
      if(list&&list!==type) closeList();
      if(!list){ list=type; out.push(`<${type}>`); }
      out.push(`<li>${renderReadmeInline((ordered||unordered)[1])}</li>`);
    }else if(!rawLine.trim()) closeText();
    else { closeList(); paragraph.push(rawLine.trim()); }
  }
  if(inCode) out.push(`<pre><code>${escapeHTML(code.join("\n"))}</code></pre>`);
  else closeText();
  return out.join("\n");
}
async function loadGuide(){
  const target=$("guideContent");
  if(!target) return;
  const downloads=`<p><a href="./README.md?v=20260804-v27" download="README.md">下载 README</a>　<a href="./PROJECT_CONTEXT.md?v=20260804-v27" download="PROJECT_CONTEXT.md">下载 Project Context</a></p>`;
  if(location.protocol==="file:"){
    target.innerHTML=`<h3>使用说明</h3><p>本地文件模式下，浏览器禁止网页直接读取同目录 README。请通过下方链接打开或下载说明文件；在 HTTPS 网页或 PWA 中会自动显示 README 的最新内容。</p>${downloads}`;
    return;
  }
  try{
    const response=await fetch("./README.md?v=20260804-v27",{cache:"no-store"});
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    target.innerHTML=downloads+renderReadmeMarkdown(await response.text());
  }catch(error){
    target.innerHTML=`<h3>使用说明暂不可用</h3><p>无法读取 README。请检查部署目录中是否包含 README.md。</p>${downloads}`;
  }
}
function textValue(value,max=160){ return String(value??"").replace(/[\u0000-\u001f\u007f]/g," ").trim().slice(0,max); }
function isValidMonthKey(value){ return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value||"")); }
function isValidDateKey(value,monthKey){
  const text=String(value||"");
  if(!/^\d{4}-\d{2}-\d{2}$/.test(text)||monthKey&&text.slice(0,7)!==monthKey) return false;
  const parsed=new Date(`${text}T00:00:00Z`);
  return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===text;
}
function assertLedgerShape(data){
  if(!data||typeof data!=="object"||Array.isArray(data)||!data.months||typeof data.months!=="object"||Array.isArray(data.months)) throw new Error("不是有效的资产追踪 JSON");
  for(const [key,month] of Object.entries(data.months)){
    if(!isValidMonthKey(key)||!month||typeof month!=="object"||Array.isArray(month)) throw new Error(`月份 ${key||"(空)"} 格式无效`);
    if(month.balance!=null&&!Array.isArray(month.balance)) throw new Error(`${key} 的资产列表格式无效`);
    if(month.flows!=null&&!Array.isArray(month.flows)) throw new Error(`${key} 的流水列表格式无效`);
    if(month.opening!=null&&!Array.isArray(month.opening)) throw new Error(`${key} 的期初快照格式无效`);
    if(month.fxRates!=null&&(!month.fxRates||typeof month.fxRates!=="object"||Array.isArray(month.fxRates))) throw new Error(`${key} 的汇率表格式无效`);
    if(month.openingPrices!=null&&(!month.openingPrices||typeof month.openingPrices!=="object"||Array.isArray(month.openingPrices))) throw new Error(`${key} 的期初价格基线格式无效`);
  }
}
function migrateLedger(data){
  assertLedgerShape(data);
  data.name=textValue(data.name||"未命名资产追踪",80);
  Object.entries(data.months).forEach(([key,month])=>{
    month.balance=Array.isArray(month.balance)?month.balance:[];
    month.flows=Array.isArray(month.flows)?month.flows:[];
    if(month.copiedFrom!=null){
      const copiedFrom=textValue(month.copiedFrom,20);
      if(copiedFrom) month.copiedFrom=copiedFrom; else delete month.copiedFrom;
    }
    month.fxRates=month.fxRates&&typeof month.fxRates==="object"?month.fxRates:{CNY:1};
    if(month.fxRates.CNY==null) month.fxRates.CNY=1;
    Object.entries(month.fxRates).forEach(([currency,rate])=>{
      if(currency.startsWith("_")) return;
      if(!Number.isFinite(Number(rate))||Number(rate)<=0) throw new Error(`${key} 的 ${textValue(currency,12)} 汇率无效`);
      month.fxRates[currency]=Number(rate);
    });
    const ids=new Set();
    month.balance.forEach(row=>{
      if(!row||typeof row!=="object") throw new Error("资产条目格式无效");
      if(!ASSET_CLASSES[row.cls]) throw new Error(`未知资产类型：${textValue(row.cls,30)}`);
      row.id=textValue(row.id,100);
      if(!row.id) row.id=uid("a");
      if(ids.has(row.id)) throw new Error(`${key} 存在重复资产 ID：${row.id}`);
      ids.add(row.id);
      ["name","group","account","currency","market","symbol"].forEach(key=>{ if(row[key]!=null) row[key]=textValue(row[key]); });
      ["qty","price","value","costBasisCNY"].forEach(field=>{
        if(row[field]==null) return;
        if(!Number.isFinite(Number(row[field]))) throw new Error(`${key} 的资产「${row.name||row.id}」存在无效${field}`);
        row[field]=Number(row[field]);
      });
      if(row.costBasisCNY==null && row.cls!=="cash" && row.cls!=="liability") {
        const rate=Number(month.fxRates[row.currency||"CNY"]||1);
        row.costBasisCNY=Math.abs((row.cls==="stock"?Number(row.qty||0)*Number(row.price||0):Number(row.value||0))*rate);
      }
    });
    if(month.openingPrices){
      const prices={};
      Object.entries(month.openingPrices).forEach(([id,entry])=>{
        const assetId=textValue(id,100), price=Number(entry?.price);
        if(!assetId||!ids.has(assetId)||!Number.isFinite(price)||price<=0) return;
        prices[assetId]={price,date:textValue(entry.date||"",20),src:textValue(entry.src||"",40)};
      });
      if(Object.keys(prices).length) month.openingPrices=prices;
      else delete month.openingPrices;
    }
    const flowIds=new Set();
    month.flows.forEach(flow=>{
      if(!flow||typeof flow!=="object"||!FLOW_TYPES[flow.kind]) throw new Error("存在未知或损坏的流水类型");
      flow.id=textValue(flow.id,100);
      if(!flow.id) flow.id=uid("f");
      if(flowIds.has(flow.id)) throw new Error(`${key} 存在重复流水 ID：${flow.id}`);
      flowIds.add(flow.id);
      if(!isValidDateKey(flow.date,key)) throw new Error(`${key} 存在无效或不属于本月的流水日期`);
      ["from","to"].forEach(side=>{
        const idKey=`${side}AssetId`, idxKey=`${side}Idx`;
        if(flow[idKey]!=null) flow[idKey]=textValue(flow[idKey],100);
        if(!flow[idKey]&&Number.isInteger(flow[idxKey])){
          if(!month.balance[flow[idxKey]]) throw new Error(`${key} 的流水引用了不存在的资产`);
          flow[idKey]=month.balance[flow[idxKey]].id;
        }
        delete flow[idxKey];
      });
      ["fromText","toText","note","subcat","currency","toCurrency","holdingCurrency"].forEach(key=>{ if(flow[key]!=null) flow[key]=textValue(flow[key]); });
    });
    const validIds=new Set(month.balance.map(row=>row.id));
    month.flows.forEach(flow=>{
      const type=FLOW_TYPES[flow.kind];
      ["from","to"].forEach(side=>{
        if(type[side]!=="free" && (!flow[`${side}AssetId`]||!validIds.has(flow[`${side}AssetId`])))
          throw new Error(`${key} 的${type.name}流水引用了不存在的${side==="from"?"来源":"去向"}资产`);
      });
      ["amount","qty","price","toAmount","holdingAmount","fxRate","costAddedCNY","costReductionCNY","realizedPnlCNY"].forEach(field=>{
        if(flow[field]!=null&&!Number.isFinite(Number(flow[field]))) throw new Error(`${key} 存在无效流水金额`);
        if(flow[field]!=null) flow[field]=Number(flow[field]);
      });
      // 历史账本曾允许收入等流水引用非标准类别。导入时只校验 ID 存在，
      // 不追溯性改变其现金流、余额或成本口径；新流水由录入界面实施类别约束。
      if(flow.nonCashIncome!=null) flow.nonCashIncome=flow.nonCashIncome===true;
      if(flow.incomeAssetMode!=null) flow.incomeAssetMode=textValue(flow.incomeAssetMode,20);
    });
  });
  const childByParent=new Map();
  Object.entries(data.months).forEach(([key,month])=>{
    if(!month.copiedFrom) return;
    const parentKey=month.copiedFrom;
    if(!isValidMonthKey(parentKey)||!data.months[parentKey]||parentKey>=key) throw new Error(`${key} 的继承来源 ${parentKey} 无效`);
    if(childByParent.has(parentKey)) throw new Error(`${parentKey} 同时被多个后续月份继承，月份链存在分叉`);
    childByParent.set(parentKey,key);
  });
  ensureMonthMetadata(data);
  return data;
}
function assetByFlow(month,flow,side){
  const id=flow?.[`${side}AssetId`];
  return id?month.balance.find(row=>row.id===id):null;
}
function setFlowAsset(flow,side,asset){
  if(asset?.id) flow[`${side}AssetId`]=asset.id;
  else delete flow[`${side}AssetId`];
  delete flow[`${side}Idx`];
}
function flowChangeSummary(flow,month,prefix){
  const type=FLOW_TYPES[flow?.kind]?.name||flow?.kind||"流水";
  const assets=new Map((month?.balance||[]).map(row=>[row.id,row.name||"未命名资产"]));
  const from=flow?.fromAssetId?assets.get(flow.fromAssetId):(flow?.fromText||"");
  const to=flow?.toAssetId?assets.get(flow.toAssetId):(flow?.toText||"");
  const route=from&&to?`${from} → ${to}`:(to?`到 ${to}`:(from?`从 ${from}`:""));
  return `${prefix}${type}流水：${fmtFull(flowAmount(flow))} ${flow?.currency||"CNY"}${route?`（${route}）`:""}`;
}
function describeMonthChanges(before,after,fallback){
  if(!before||!after) return [];
  const details=[];
  const beforeFlows=new Map((before.flows||[]).map(flow=>[flow.id,flow]));
  const afterFlows=new Map((after.flows||[]).map(flow=>[flow.id,flow]));
  const changedFlowIds=new Set();
  afterFlows.forEach((flow,id)=>{
    const old=beforeFlows.get(id);
    if(!old){ changedFlowIds.add(id); details.push(flowChangeSummary(flow,after,"新增")); }
    else if(JSON.stringify(old)!==JSON.stringify(flow)){
      changedFlowIds.add(id);
      details.push(`${flowChangeSummary(old,before,"修改前")}；${flowChangeSummary(flow,after,"修改后")}`);
    }
  });
  beforeFlows.forEach((flow,id)=>{ if(!afterFlows.has(id)){ changedFlowIds.add(id); details.push(flowChangeSummary(flow,before,"删除")); } });

  const beforeAssets=new Map((before.balance||[]).map(row=>[row.id,row]));
  const afterAssets=new Map((after.balance||[]).map(row=>[row.id,row]));
  const flowChanged=changedFlowIds.size>0;
  afterAssets.forEach((row,id)=>{
    const old=beforeAssets.get(id);
    if(!old){ details.push(`新增资产「${row.name}」`); return; }
    const changes=[];
    if(old.group!==row.group) changes.push(`分组 ${old.group||"未分组"} → ${row.group||"未分组"}`);
    if(Boolean(old.auto)!==Boolean(row.auto)) changes.push(`自动股价 ${old.auto?"开启":"关闭"} → ${row.auto?"开启":"关闭"}`);
    if(old.symbol!==row.symbol&&row.cls==="stock") changes.push(`代码 ${old.symbol||"—"} → ${row.symbol||"—"}`);
    if(old.priceStatus!==row.priceStatus&&row.cls==="stock") changes.push(`价格状态 ${old.priceStatus||"未更新"} → ${row.priceStatus==="ok"?"已更新":row.priceStatus==="warn"?"更新失败":row.priceStatus||"未更新"}`);
    // 流水本身已完整说明余额/数量联动，避免同一变更重复占满同步提示。
    if(!flowChanged){
      if(row.cls==="stock"){
        if(Number(old.qty||0)!==Number(row.qty||0)) changes.push(`数量 ${fmtQuantity(old.qty)} → ${fmtQuantity(row.qty)}`);
        if(Number(old.price||0)!==Number(row.price||0)) changes.push(`价格 ${fmtPrice(old.price)} → ${fmtPrice(row.price)} ${row.currency||"CNY"}`);
      }else if(Number(old.value||0)!==Number(row.value||0)){
        const field=row.cls==="cash"||row.cls==="liability"?"余额":"估值";
        changes.push(`${field} ${fmtFull(old.value)} → ${fmtFull(row.value)} ${row.currency||"CNY"}`);
      }
    }
    if(changes.length) details.push(`「${row.name}」${changes.join("；")}`);
  });
  beforeAssets.forEach((row,id)=>{ if(!afterAssets.has(id)) details.push(`删除资产「${row.name}」`); });
  const currencies=new Set([...Object.keys(before.fxRates||{}),...Object.keys(after.fxRates||{})]);
  currencies.forEach(currency=>{
    const old=Number(before.fxRates?.[currency]??1), value=Number(after.fxRates?.[currency]??1);
    if(old!==value) details.push(`${currency} 汇率 ${fmtPrice(old)} → ${fmtPrice(value)}`);
  });
  return (details.length?details:[fallback]).slice(0,20);
}
function appendMonthChange(month,label,details=[]){
  month.changeLog=Array.isArray(month.changeLog)?month.changeLog:[];
  month.changeLog.push({revision:Number(month.revision||0),at:month.updatedAt,label:textValue(label||"更新月度数据",120),details:(details||[]).map(item=>textValue(item,240)).filter(Boolean).slice(0,20)});
  if(month.changeLog.length>80) month.changeLog.splice(0,month.changeLog.length-80);
}
function markMonthChanged(key,label,details=[]){
  const month=ledger?.months?.[key];
  if(!month) return;
  month.revision=Number(month.revision||0)+1;
  month.updatedAt=new Date().toISOString();
  appendMonthChange(month,label,details);
}
async function transact(label,mutator,{touch=true,render=true}={}){
  const snapshot=structuredClone(ledger);
  const beforeMonth=activeMonth?snapshot?.months?.[activeMonth]:null;
  try{
    const result=await mutator();
    if(result===false){ ledger=snapshot; return false; }
    if(touch) markMonthChanged(activeMonth,label,describeMonthChanges(beforeMonth,ledger?.months?.[activeMonth],label));
    await persist(touch);
    if(render){ renderMonthTabs(); renderMonthPanel(); renderTrend(); }
    return true;
  }catch(error){
    ledger=snapshot;
    console.error(label,error);
    alert(`${label}失败：${error.message||"数据未保存"}`);
    if(render){ renderMonthTabs(); renderMonthPanel(); renderTrend(); }
    return false;
  }
}
function fmtFull(n){
  if(n==null||isNaN(n)) return "-";
  n=Number(n);
  const neg=n<0, a=Math.abs(n);
  let s;
  if(a>=100) s=Math.round(a).toLocaleString("zh-CN");
  else if(a>=10) s=a.toFixed(1);
  else s=a.toFixed(2);
  return (neg?"-":"")+s;
}
function fmtCompact(n){
  if(n==null||isNaN(n)) return "-";
  n=Number(n);
  const neg=n<0, a=Math.abs(n);
  let s;
  if(a>=1e6)      s=(a/1e6).toFixed(2)+"M";
  else if(a>=1e4) s=Math.round(a/1e3)+"K";
  else if(a>=100) s=Math.round(a).toLocaleString("zh-CN");
  else if(a>=10)  s=a.toFixed(1);
  else            s=a.toFixed(2);
  return (neg?"-":"")+s;
}
function fmt(n){ return fmtCompact(n); }
function fmtTrend(n){
  if(n==null||isNaN(n)) return "-";
  return fmtCompact(n);
}
function amount(n){
  const full=fmtFull(n), compact=fmtCompact(n);
  return `<span class="amount" title="完整金额：${full}">${compact}</span>`;
}
function fmtMoney(n){
  if(n==null||isNaN(n)) return "-";
  const value=Number(n), neg=value<0;
  return (neg?"-":"")+Math.round(Math.abs(value)).toLocaleString("zh-CN");
}
function fmtQuantity(n){
  if(n==null||isNaN(n)) return "-";
  return Number(n).toLocaleString("zh-CN",{minimumFractionDigits:0,maximumFractionDigits:4});
}
function fmtPrice(n){
  if(n==null||isNaN(n)) return "-";
  return Number(n).toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:4});
}
function moneyCell(n,currency,formatter=fmtMoney){
  return `<span class="money"><span>${formatter(n)}</span>${currency?`<span class="currency-code">${currency}</span>`:""}</span>`;
}
function setStatus(s){ document.getElementById("status").textContent = s; }
function $(id){ return document.getElementById(id); }
function requestPassword({title="账本密码",hint="",confirm=false}={}){
  $("passwordDlgTitle").textContent=title;
  $("passwordDlgHint").textContent=hint;
  $("passwordCurrentWrap").hidden=true;
  $("passwordNewWrap").hidden=false;
  $("passwordConfirmWrap").hidden=!confirm;
  $("passwordNew").value=""; $("passwordConfirm").value=""; $("passwordCurrent").value="";
  $("passwordDialog").hidden=false;
  requestAnimationFrame(()=>$("passwordNew").focus());
  return new Promise(resolve=>{
    const close=value=>{ $("passwordDialog").hidden=true; resolve(value); };
    $("btnPasswordCancel").onclick=()=>close(null);
    $("btnPasswordOk").onclick=()=>{
      const value=$("passwordNew").value;
      if(confirm&&value!==$("passwordConfirm").value){ alert("两次输入的密码不一致"); return; }
      close(value);
    };
  });
}
function parseArithmetic(value,label="金额"){
  const source=String(value??"").replace(/,/g,"").replaceAll("×","*").replaceAll("÷","/").trim();
  if(!source) throw new Error(`请填写${label}`);
  if(!/^[0-9+\-*/().\s]+$/.test(source)) throw new Error(`${label}只支持数字、小数点、括号和 + - × ÷ 运算`);
  let i=0;
  const skip=()=>{ while(/\s/.test(source[i]||"")) i++; };
  const primary=()=>{
    skip();
    if(source[i]==="("){
      i++; const out=sum(); skip();
      if(source[i]!==")") throw new Error(`${label}表达式括号不匹配`);
      i++; return out;
    }
    const match=source.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
    if(!match) throw new Error(`${label}表达式格式无效`);
    i+=match[0].length;
    return Number(match[0]);
  };
  const unary=()=>{ skip(); if(source[i]==="+"){ i++; return unary(); } if(source[i]==="-"){ i++; return -unary(); } return primary(); };
  const product=()=>{
    let out=unary();
    while(true){ skip(); const op=source[i]; if(op!=="*"&&op!=="/") break; i++; const right=unary(); if(op==="/"){ if(right===0) throw new Error(`${label}不能除以 0`); out/=right; } else out*=right; }
    return out;
  };
  const sum=()=>{
    let out=product();
    while(true){ skip(); const op=source[i]; if(op!=="+"&&op!=="-") break; i++; const right=product(); out=op==="+"?out+right:out-right; }
    return out;
  };
  const result=sum(); skip();
  if(i!==source.length||!Number.isFinite(result)) throw new Error(`${label}表达式结果无效`);
  return result;
}
function refreshAssetSuggestions(){
  const groups=new Set(), accounts=new Set();
  Object.values(ledger?.months||{}).forEach(month=>(month.balance||[]).forEach(row=>{
    if(row.group) groups.add(textValue(row.group,80));
    if(row.account) accounts.add(textValue(row.account,80));
  }));
  const render=(id,items)=>$(id).innerHTML=[...items].filter(Boolean).sort((a,b)=>a.localeCompare(b,"zh-CN"))
    .map(value=>`<option value="${escapeAttr(value)}"></option>`).join("");
  render("assetGroupList",groups); render("assetAccountList",accounts);
}

function newLedger(name){
  return {
    schema:"family-ledger-v2", name, createdAt:new Date().toISOString(),
    months:{}   // 汇率下沉到每个月(与时间相关)
  };
}
function newMonth(){
  const now=new Date().toISOString();
  return { balance:[], flows:[], fxRates:{CNY:1}, createdAt:now, updatedAt:now, revision:0, sourceRevision:0, changeLog:[] };
}
function ensureMonthMetadata(data){
  const now=new Date().toISOString();
  Object.values(data?.months||{}).forEach(m=>{
    if(!m.createdAt) m.createdAt=now;
    if(!m.updatedAt) m.updatedAt=m.createdAt;
    if(m.copiedFrom&&!m.sourceUpdatedAt) m.sourceUpdatedAt=m.createdAt;
    if(!Number.isFinite(Number(m.revision))) m.revision=0;
    if(!Number.isFinite(Number(m.sourceRevision))) m.sourceRevision=0;
    m.changeLog=Array.isArray(m.changeLog)?m.changeLog.filter(entry=>entry&&Number.isFinite(Number(entry.revision))).slice(-80).map(entry=>({
      revision:Number(entry.revision),at:textValue(entry.at||m.updatedAt,40),label:textValue(entry.label||"更新月度数据",120),
      details:Array.isArray(entry.details)?entry.details.map(item=>textValue(item,240)).filter(Boolean).slice(0,20):[]
    })):[];
  });
}
/* 资产条目 balance row 结构:
   { id, cls:'stock'|'cash'|'liability'|'fixed', group, name, account,
     qty, price, currency, value,           // value=原币金额(股票=qty*price;其它直接填)
     auto:bool, market, symbol, priceStatus:'ok'|'warn'|null, priceAt }
   总金额(人民币) = value * fxRate(currency) * clsSign
*/


// ---------- 计算 ----------
function curFx(){ const m=ledger.months[activeMonth]; if(m&&!m.fxRates) m.fxRates={CNY:1}; return m?m.fxRates:{CNY:1}; }
function fxRate(cur,mKey=activeMonth){
  const m=ledger.months[mKey]; const rates=m?.fxRates||{CNY:1};
  const r=rates[cur]; return (r==null||isNaN(r))?1:Number(r);
}
// 原币金额: 股票=数量×价格; 其它=直接填的 value
function rowNative(row){
  if(row.cls==="stock") return Number(row.qty||0)*Number(row.price||0);
  return Number(row.value||0);
}
// 人民币总金额(带符号: 负债为负)
function rowCNY(row,mKey=activeMonth){
  const cls = ASSET_CLASSES[row.cls]; const sign = cls?cls.sign:1;
  return rowNative(row)*fxRate(row.currency||"CNY",mKey)*sign;
}
// 收集当前月出现过的所有货币
function usedCurrencies(){
  const s = new Set(["CNY"]);
  const m = ledger.months[activeMonth];
  if(m) m.balance.forEach(r=>{ if(r.currency) s.add(r.currency); });
  return [...s];
}
function monthTotals(mKey){
  const m = ledger.months[mKey];
  return m?balanceTotals(m.balance,m.fxRates):{net:0,assets:0,liab:0};
}
function monthKeys(){ return Object.keys(ledger?.months||{}).sort(); }
function previousMonthKey(mKey){
  const [year,month]=mKey.split("-").map(Number);
  const d=new Date(year,month-2,1);
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0");
}
function cashFlowTotals(mKey){
  const m=ledger.months[mKey];
  const detail={income:0,nonCashIncome:0,dividend:0,expense:0,buy:0,sell:0,repay:0,transfer:0};
  let inflow=0, outflow=0;
  (m?.flows||[]).forEach(f=>{
    const amount=flowAmount(f)*fxRate(f.currency||"CNY",mKey);
    if(f.kind==="income"){
      if(f.nonCashIncome===true) detail.nonCashIncome+=amount;
      else { detail.income+=amount; inflow+=amount; }
    }else{
      detail[f.kind]=(detail[f.kind]||0)+amount;
    }
    if(f.kind==="dividend") inflow+=amount;
    else if(f.kind==="expense"||f.kind==="repay") outflow+=amount;
    else if(f.kind==="buy"){ if(amount>=0) outflow+=amount; else inflow-=amount; }
    else if(f.kind==="sell"){ if(amount>=0) inflow+=amount; else outflow-=amount; }
  });
  return {inflow,outflow,net:inflow-outflow,detail};
}
// 某月按分组的人民币金额(用于堆叠图)
function monthGroupTotals(mKey){
  const m=ledger.months[mKey]; const g={};
  if(m) m.balance.forEach(r=>{ const k=r.group||"未分组"; g[k]=(g[k]||0)+rowCNY(r,mKey); });
  return g;
}
function flowCNY(f,mKey){ return flowAmount(f)*fxRate(f.currency||"CNY",mKey); }
