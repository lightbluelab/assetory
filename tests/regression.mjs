import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source=file=>fs.readFileSync(new URL(`../${file}`,import.meta.url),"utf8");
const functionSource=(text,name,nextName)=>{
  const start=text.indexOf(`function ${name}(`);
  const end=text.indexOf(`function ${nextName}(`,start);
  assert.ok(start>=0&&end>start,`无法提取 ${name}`);
  return text.slice(start,end);
};

// 无文件句柄时，事务持久化必须标记未备份修改；下载备份后才允许清除。
{
  const listeners={};
  const context={
    window:{addEventListener:(name,fn)=>listeners[name]=fn},
    document:{addEventListener(){},createElement(){ return {click(){},href:"",download:""}; }},
    location:{href:"https://example.test/assetory.html"}, confirm:()=>false,
    setStatus(){},renderStorageInfo(){},setTimeout(fn){fn();},URL:{createObjectURL:()=>"blob:test",revokeObjectURL(){}},
    Blob,console
  };
  vm.createContext(context);
  const core=source("src/js/core.js"), storage=source("src/js/storage.js");
  await vm.runInContext(`${core}\n${storage}\n(async()=>{
    setStatus=()=>{}; renderStorageInfo=()=>{}; serializeLedger=async()=>ledger;
    ledger={name:"测试账本",months:{}}; demoMode=false; fileHandle=null; fallbackDirty=false;
    await persist();
    if(!hasUnsavedFallbackChanges()) throw new Error("内存修改未标记 dirty");
    await backupCurrentLedger();
    if(hasUnsavedFallbackChanges()) throw new Error("备份后 dirty 未清除");
  })()`,context);
  assert.equal(typeof listeners.beforeunload,"function");
}

// 首月使用 openingBaseline；非首月继续使用真实前月期末。
{
  const trends=source("src/js/trends.js");
  const code=functionSource(trends,"periodOpeningTotals","renderTrendSummary");
  const calls=[];
  const context={monthKeys:()=>["2026-01","2026-02"],monthTotals:key=>({net:key==="2026-01"?100:200}),openingBaseline:key=>{calls.push(key);return {balance:[{value:40}],fxRates:{CNY:1}};},balanceTotals:()=>({net:40})};
  vm.createContext(context); vm.runInContext(code,context);
  assert.equal(vm.runInContext(`periodOpeningTotals("2026-01").net`,context),40);
  assert.deepEqual(calls,["2026-01"]);
  assert.equal(vm.runInContext(`periodOpeningTotals("2026-02").net`,context),100);
}

// 允许恰好归零和从零开空；禁止一笔交易穿过零仓。
{
  const tx=source("src/js/transactions.js");
  const code=functionSource(tx,"validateFlowCapacity","removeUnreferencedOpenedAssets");
  const context={
    assetByFlow:(month,rec,side)=>month.balance.find(row=>row.id===rec[`${side}AssetId`]),
    holdingFlowAmount:rec=>Number(rec.holdingAmount??rec.amount??0),flowAmount:rec=>Number(rec.amount??0),
    fmtQuantity:value=>String(value),fmtFull:value=>String(value),Error
  };
  vm.createContext(context); vm.runInContext(code,context);
  const validate=(qty,rec)=>vm.runInContext(`validateFlowCapacity({balance:[{id:"s",cls:"stock",qty:${qty}}]},${JSON.stringify(rec)})`,context);
  assert.doesNotThrow(()=>validate(10,{kind:"sell",fromAssetId:"s",qty:10}));
  assert.throws(()=>validate(10,{kind:"sell",fromAssetId:"s",qty:11}),/穿过零仓/);
  assert.doesNotThrow(()=>validate(0,{kind:"sell",fromAssetId:"s",qty:5}));
  assert.doesNotThrow(()=>validate(-10,{kind:"buy",toAssetId:"s",qty:10}));
  assert.throws(()=>validate(-10,{kind:"buy",toAssetId:"s",qty:11}),/穿过零仓/);
}

// 最新 schema 强制显式 opening；规范 demo 可导入、对账并在同步后保持期末数值。
{
  const dummy=new Proxy({dataset:{},style:{},value:"",checked:false,hidden:false,addEventListener(){},querySelector(){return dummy;},querySelectorAll(){return[];}},{get:(target,key)=>key in target?target[key]:()=>{}});
  const context={console,structuredClone,Date,Math,Number,Map,Set,JSON,Error,document:{getElementById:()=>dummy,addEventListener(){}},window:{showOpenFilePicker(){},showDirectoryPicker(){}},alert(){},confirm:()=>true,prompt:()=>null};
  vm.createContext(context);
  vm.runInContext(`${source("src/js/core.js")}\n${source("src/js/transactions.js")}\nthis.api={loadLedger,reconcile,rebuildChildFromParent,applyFlowToBalance};`,context);
  const unsupported={schema:"unsupported-ledger",name:"旧格式",months:{}};
  assert.throws(()=>context.api.loadLedger(unsupported),/版本不受支持/);
  const invalid={schema:"assetory-ledger-v1",name:"缺字段",createdAt:"2026-01-01T00:00:00.000Z",months:{"2026-01":{balance:[],flows:[],fxRates:{CNY:1}}}};
  assert.throws(()=>context.api.loadLedger(invalid),/opening/);
  const demo=JSON.parse(source("assetory-demo-ledger.json"));
  context.ledger=context.api.loadLedger(structuredClone(demo));
  vm.runInContext("ledger=globalThis.ledger",context);
  assert.ok(Object.keys(context.ledger.months).every(key=>Array.isArray(context.ledger.months[key].opening)));
  assert.ok(Object.keys(context.ledger.months).every(key=>context.api.reconcile(key)!==null));
  const before=structuredClone(context.ledger.months["2026-02"].balance);
  context.api.rebuildChildFromParent("2026-01","2026-02");
  const values=rows=>rows.map(row=>[row.id,row.qty??null,row.value??null,row.price??null]);
  assert.deepEqual(values(context.ledger.months["2026-02"].balance),values(before));

  const stock=[{id:"s",cls:"stock",qty:0,value:0}];
  context.api.applyFlowToBalance(stock,{kind:"income",incomeAssetMode:"value",toAssetId:"s",amount:100,qty:null,price:null},1);
  assert.equal(stock[0].qty,0);
  assert.equal(stock[0].value,100);
  const malformed=structuredClone(demo);
  delete malformed.months["2026-01"].flows[0].incomeAssetMode;
  assert.throws(()=>context.api.loadLedger(malformed),/资产计量模式/);

  const missingAssetId=structuredClone(demo);
  delete missingAssetId.months["2026-01"].balance[0].id;
  assert.throws(()=>context.api.loadLedger(missingAssetId),/必填字段 id/);
  const missingFlowId=structuredClone(demo);
  delete missingFlowId.months["2026-01"].flows[0].id;
  assert.throws(()=>context.api.loadLedger(missingFlowId),/必填字段 id/);
  const missingCost=structuredClone(demo);
  delete missingCost.months["2026-01"].balance.find(row=>row.cls==="stock").costBasisCNY;
  assert.throws(()=>context.api.loadLedger(missingCost),/costBasisCNY/);
  const missingMetadata=structuredClone(demo);
  delete missingMetadata.months["2026-01"].revision;
  assert.throws(()=>context.api.loadLedger(missingMetadata),/revision/);
  const wrongEndpoint=structuredClone(demo);
  wrongEndpoint.months["2026-01"].flows.find(flow=>flow.kind==="expense").fromAssetId="stock-voo";
  assert.throws(()=>context.api.loadLedger(wrongEndpoint),/资产类别无效/);
  const invalidOpening=structuredClone(demo);
  invalidOpening.months["2026-01"].opening[0].cls="stock";
  assert.throws(()=>context.api.loadLedger(invalidOpening),/资产类型与期末资产不一致/);
  const openingWithoutCost=structuredClone(demo);
  assert.equal(Object.hasOwn(openingWithoutCost.months["2026-01"].opening.find(row=>row.cls==="stock"),"costBasisCNY"),false);
  assert.doesNotThrow(()=>context.api.loadLedger(openingWithoutCost));
}

// 趋势与月面板统一使用显式期初和上一个实际存在月份。
{
  const core=source("src/js/core.js"), trends=source("src/js/trends.js"), ui=source("src/js/ui.js");
  assert.match(trends,/const balance=\(m\?\.opening\|\|\[\]\)/);
  assert.match(trends,/balanceGroupTotals\(firstOpening\.balance,keys\[0\]\)/);
  assert.match(ui,/const prevKey=previousAvailableMonthKey\(activeMonth\)/);
  assert.doesNotMatch(ui,/const pnlPrevKey=/);
  assert.doesNotMatch(trends,/trendHiddenGroups|__stackHover|__cashHover|cash-hover-col|grp-toggle/);
  assert.doesNotMatch(source("src/js/transactions.js"),/opened=|childValuationAdjustments/);
  const previous=functionSource(core,"previousAvailableMonthKey","cashFlowTotals");
  const context={monthKeys:()=>["2026-01","2026-03"]}; vm.createContext(context); vm.runInContext(previous,context);
  assert.equal(vm.runInContext('previousAvailableMonthKey("2026-03")',context),"2026-01");
}

// 完整金额保留小数，币种文本进入 HTML 前必须转义。
{
  const core=source("src/js/core.js");
  const format=functionSource(core,"fmtFull","fmtCompact");
  const money=functionSource(core,"moneyCell","setStatus");
  const context={escapeHTML:value=>String(value).replaceAll("<","&lt;")}; vm.createContext(context); vm.runInContext(format+money,context);
  assert.equal(vm.runInContext("fmtFull(1234.56)",context),"1,234.56");
  assert.match(vm.runInContext('moneyCell(1,"<img>",String)',context),/&lt;img>/);
}

console.log("全部回归测试通过");
