// ---------- PWA：仅缓存程序资源，不保存或上传用户账本 ----------
let deferredInstallPrompt=null;
function isMobileDevice(){ return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)||navigator.maxTouchPoints>1; }
function showInstallGuide(){
  const isiOS=/iPhone|iPad|iPod/i.test(navigator.userAgent)||(/Macintosh/.test(navigator.userAgent)&&navigator.maxTouchPoints>1);
  $("installGuideContent").innerHTML=isiOS
    ? `<p>请点击浏览器底部或顶部的“分享”按钮，然后选择“添加到主屏幕”。</p><p>添加后可从桌面以独立应用方式打开 Wealth Tracker。</p>`
    : `<p>请在浏览器菜单中选择“安装应用”或“添加到主屏幕”。</p><p>添加后可从桌面以独立应用方式打开 Wealth Tracker。</p>`;
  $("installGuideDialog").hidden=false;
}
function initPWA(){
  if(isMobileDevice()&&!window.matchMedia("(display-mode: standalone)").matches) $("btnInstallApp").hidden=false;
  if(!window.isSecureContext||!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("./service-worker.js?v=20260804-v28",{scope:"./"}).then(reg=>{
    reg.addEventListener("updatefound",()=>{
      const worker=reg.installing;
      if(!worker) return;
      worker.addEventListener("statechange",()=>{
        if(worker.state==="installed"&&navigator.serviceWorker.controller)
          setStatus("发现新版本，刷新页面后生效");
      });
    });
  }).catch(error=>console.warn("PWA 注册失败",error));
}
window.addEventListener("beforeinstallprompt",event=>{
  event.preventDefault();
  deferredInstallPrompt=event;
  $("btnInstallApp").hidden=false;
});
window.addEventListener("appinstalled",()=>{
  deferredInstallPrompt=null;
  $("btnInstallApp").hidden=true;
  setStatus("Wealth Tracker 已安装为本机应用");
});
$("btnInstallApp").addEventListener("click",async()=>{
  if(!deferredInstallPrompt){ showInstallGuide(); return; }
  await deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt=null;
  $("btnInstallApp").hidden=true;
});
$("btnInstallGuideDone").addEventListener("click",()=>{ $("installGuideDialog").hidden=true; });

// 新建账本对话框
$("btnCreateCancel").addEventListener("click",()=>{ $("createDialog").hidden=true; });
$("btnCreateOk").addEventListener("click",async()=>{
  const name=($("newName").value||"").trim();
  const password=$("newPassword").value, confirmPassword=$("newPasswordConfirm").value;
  if(!name){ alert("请输入账本名称"); return; }
  if(password!==confirmPassword){ alert("两次输入的密码不一致"); return; }
  if(!HAS_FS){
    ledger=newLedger(name); fileHandle=null; directoryHandle=null; demoMode=false; encryptionKey=null; encryptionMeta=null;
    if(password){
      try{ const protectedData=await protectLedger(ledger,password); encryptionKey=protectedData.key; encryptionMeta=protectedData.meta; }
      catch(e){ ledger=null; alert("无法设置密码: "+e.message); return; }
    }
    $("createDialog").hidden=true; renderAll();
    const backedUp=await backupCurrentLedger();
    setStatus(backedUp?"已创建账本；当前浏览器不支持自动写回，请保管已下载的 JSON":"账本仅保留在当前页面内存中，请尽快重新下载备份");
    return;
  }
  let handle, directory;
  const safeName=name.replaceAll("/","_").replaceAll("\\","_").replace(/[<>:"|?*\u0000-\u001F]/g,"_").trim()||"ledger";
  const filename=safeName+"_ledger_data.json";
  try{
    directory = await window.showDirectoryPicker({id:"wealth-tracker-directory",mode:"readwrite"});
    try{
      await directory.getFileHandle(filename);
      alert(`所选目录中已存在 ${filename}。为避免覆盖账本，请修改名称或选择其他目录。`);
      return;
    }catch(e){ if(e.name!=="NotFoundError") throw e; }
    handle = await directory.getFileHandle(filename,{create:true});
  }catch(e){ if(e.name==="AbortError") return; alert("选择本地目录失败: "+e.message); return; }
  if(!(await verifyPermission(handle,true))){ alert("未授予文件写入权限，创建失败"); return; }
  ledger = newLedger(name); demoMode=false; encryptionKey=null; encryptionMeta=null;
  if(password){
    try{ const protectedData=await protectLedger(ledger,password); encryptionKey=protectedData.key; encryptionMeta=protectedData.meta; }
    catch(e){ ledger=null; alert("无法设置密码: "+e.message); return; }
  }
  try{
    await useHandle(handle,{isNew:true,directory});
    $("createDialog").hidden=true;
    setStatus(`已创建账本：${directory.name}/${handle.name}，后续修改将自动保存`);
  }catch(e){ ledger=null; fileHandle=null; directoryHandle=null; alert("创建失败: "+e.message); }
});

// ---------- 启动 ----------
(async function boot(){
  initPWA();
  renderAll();
  const launch=new URLSearchParams(location.search);
  if(launch.get("demo")==="1"){
    history.replaceState(null,"",location.pathname);
    await loadDemoLedger();
    return;
  }
  if(!HAS_FS){
    setStatus("当前为导入模式：可打开 JSON 并下载备份；Chrome/Edge 的 HTTPS 页面支持自动写回本地文件");
    return;
  }
  let saved={};
  try{
    saved = await idbGetAll();       // 恢复已知账本句柄
    Object.entries(saved).forEach(([name,h])=>{ if(!name.startsWith("dir:")) registry[name]=h; });
    renderLedgerManager();
  }catch(e){ console.warn("恢复失败",e); }
  const action=launch.get("action"), last=localStorage.getItem(LS_ACTIVE);
  if(action) history.replaceState(null,"",location.pathname);
  if(action==="create"){
    openCreateDialog();
    return;
  }
  if(action==="open"){
    $("ledgerManagerDialog").hidden=false;
    setStatus(Object.keys(registry).length?"请选择已有账本，或点击「打开 JSON」导入其他账本":"请选择「打开 JSON」导入账本");
    return;
  }
  if(last && registry[last]){
    const h=registry[last];
    // 刷新或从介绍页返回时，授权仍有效则直接恢复；否则保留已知记录供用户点击授权。
    if((await h.queryPermission({mode:"readwrite"}))==="granted"){
      await useHandle(h,{isNew:false,directory:saved[`dir:${last}`]});
      setStatus("已恢复账本: "+last);
      return;
    }
    if(action==="resume"){
      $("ledgerManagerDialog").hidden=false;
      setStatus("请选择上次账本以重新授权打开");
      return;
    }
  }
  if(action==="resume"){
    $("ledgerManagerDialog").hidden=false;
    setStatus("未找到上次账本，请点击「打开 JSON」选择文件");
    return;
  }
  if(!ledger) setStatus("请「＋ 新建」或「打开文件…」开始");
})();
