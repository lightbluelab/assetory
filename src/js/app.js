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
  navigator.serviceWorker.register("./service-worker.js?v=20260804-v27",{scope:"./"}).then(reg=>{
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
  loadGuide();
  renderAll();
  const isWeb=/^https?:$/.test(location.protocol);
  if(!HAS_FS){
    if(isWeb && await loadDemoLedger()) return;
    setStatus("当前为导入模式：可打开 JSON 并下载备份；Chrome/Edge 的 HTTPS 页面支持自动写回本地文件");
    return;
  }
  try{
    const saved = await idbGetAll();       // 恢复已知账本句柄
    Object.entries(saved).forEach(([name,h])=>{ if(!name.startsWith("dir:")) registry[name]=h; });
    renderLedgerManager();
    const last = localStorage.getItem(LS_ACTIVE);
    if(last && registry[last]){
      const h=registry[last];
      // 刷新后需用户再次授权(浏览器安全策略); 授权成功则自动载入
      if((await h.queryPermission({mode:"readwrite"}))==="granted"){
        await useHandle(h,{isNew:false,directory:saved[`dir:${last}`]});
        setStatus("已恢复账本: "+last);
        return;
      }
    }
  }catch(e){ console.warn("恢复失败",e); }
  if(!ledger && isWeb && !Object.keys(registry).length && await loadDemoLedger()) return;
  if(!ledger) setStatus("请「＋ 新建」或「打开文件…」开始");
})();
