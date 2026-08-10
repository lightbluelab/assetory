// ---------- IndexedDB: 持久化文件句柄 ----------
function idbOpen(){
  return new Promise((res,rej)=>{
    const req=indexedDB.open(IDB_DB,1);
    req.onupgradeneeded=()=>req.result.createObjectStore(IDB_STORE);
    req.onsuccess=()=>res(req.result); req.onerror=()=>rej(req.error);
  });
}
async function idbSet(key,val){ const db=await idbOpen(); return new Promise((res,rej)=>{
  const tx=db.transaction(IDB_STORE,"readwrite"); tx.objectStore(IDB_STORE).put(val,key);
  tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); }); }
async function idbGetAll(){ const db=await idbOpen(); return new Promise((res,rej)=>{
  const tx=db.transaction(IDB_STORE,"readonly"); const st=tx.objectStore(IDB_STORE);
  const keys=st.getAllKeys(), vals=st.getAll(); const out={};
  tx.oncomplete=()=>{ keys.result.forEach((k,i)=>out[k]=vals.result[i]); res(out); }; tx.onerror=()=>rej(tx.error); }); }
async function idbDel(key){ const db=await idbOpen(); return new Promise((res,rej)=>{
  const tx=db.transaction(IDB_STORE,"readwrite"); tx.objectStore(IDB_STORE).delete(key);
  tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); }); }
const LS_ACTIVE = "familyLedger.active";  // 记住上次打开的账本名


function b64(bytes){
  const data=new Uint8Array(bytes); let binary="";
  for(let i=0;i<data.length;i+=0x8000) binary+=String.fromCharCode(...data.subarray(i,i+0x8000));
  return btoa(binary);
}
function unb64(value){ return Uint8Array.from(atob(value),c=>c.charCodeAt(0)); }
async function deriveEncryptionKey(password,salt){
  const material=await crypto.subtle.importKey("raw",new TextEncoder().encode(password),"PBKDF2",false,["deriveKey"]);
  return crypto.subtle.deriveKey({name:"PBKDF2",salt,iterations:210000,hash:"SHA-256"},material,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
}
async function protectLedger(data,password){
  if(!crypto.subtle) throw new Error("当前浏览器不支持本地加密");
  const salt=crypto.getRandomValues(new Uint8Array(16)), iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await deriveEncryptionKey(password,salt);
  const ciphertext=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,new TextEncoder().encode(JSON.stringify(data)));
  return {schema:"nimble-ledger-encrypted-v1",encryption:{kdf:"PBKDF2-SHA-256",iterations:210000,salt:b64(salt)},iv:b64(iv),ciphertext:b64(ciphertext),key,meta:{salt:b64(salt)}};
}
async function serializeLedger(){
  if(!encryptionKey) return ledger;
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:"AES-GCM",iv},encryptionKey,new TextEncoder().encode(JSON.stringify(ledger)));
  return {schema:"nimble-ledger-encrypted-v1",encryption:{kdf:"PBKDF2-SHA-256",iterations:210000,salt:encryptionMeta.salt},iv:b64(iv),ciphertext:b64(ciphertext)};
}
async function unlockLedger(wrapper,password){
  try{
    const salt=unb64(wrapper.encryption.salt), key=await deriveEncryptionKey(password,salt);
    const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:unb64(wrapper.iv)},key,unb64(wrapper.ciphertext));
    return {data:JSON.parse(new TextDecoder().decode(plain)),key,meta:{salt:wrapper.encryption.salt}};
  }catch(e){ throw new Error("密码错误或加密账本已损坏"); }
}


// ---------- 存储层 (严格文件绑定) ----------
async function persist(touchActiveMonth=true){
  if(!ledger) return;
  if(demoMode){
    setStatus("示例账本已修改；请点击「下载示例副本」保存为自己的 JSON");
    renderStorageInfo();
    return;
  }
  if(!fileHandle){ setStatus("⚠️ 未绑定文件，无法保存"); return; }
  try{
    const w = await fileHandle.createWritable();
    await w.write(JSON.stringify(await serializeLedger(),null,2));
    await w.close();
    localStorage.setItem(LS_ACTIVE, ledger.name);
    setStatus(`已自动保存到 ${directoryHandle?.name ? directoryHandle.name+"/" : ""}${fileHandle.name} · ${new Date().toLocaleTimeString()}`);
  }catch(e){
    setStatus("保存失败: "+e.message);
    renderStorageInfo();
    throw new Error("写入文件失败："+e.message+"（可能是权限被回收，请重新用「打开 JSON」授权）");
  }
  renderStorageInfo();
}


// ---------- 账本 加载/创建/打开 (严格文件绑定) ----------
async function verifyPermission(handle, write){
  const opts={mode: write?"readwrite":"read"};
  if((await handle.queryPermission(opts))==="granted") return true;
  if((await handle.requestPermission(opts))==="granted") return true;
  return false;
}
async function useHandle(handle, {isNew, directory}={}){
  let nextLedger=ledger, nextEncryptionKey=encryptionKey, nextEncryptionMeta=encryptionMeta, needsMigrationSave=false;
  if(!isNew){
    const file=await handle.getFile();
    let obj=JSON.parse(await file.text());
    nextEncryptionKey=null; nextEncryptionMeta=null;
    if(obj.schema==="nimble-ledger-encrypted-v1"){
      const password=await requestPassword({title:`打开加密账本：${file.name}`,hint:"请输入此账本的密码以解锁本地 JSON"});
      if(password==null){ const e=new Error("已取消输入密码"); e.name="AbortError"; throw e; }
      const unlocked=await unlockLedger(obj,password);
      obj=unlocked.data; nextEncryptionKey=unlocked.key; nextEncryptionMeta=unlocked.meta;
    }
    needsMigrationSave=Boolean(obj.recurringFlows)||Object.values(obj.months||{}).some(month=>(month.flows||[]).some(flow=>Object.hasOwn(flow,"recurringId")));
    nextLedger=migrateLedger(obj);
  }
  // 文件解析、密码验证和结构迁移全部成功后，才切换当前运行状态。
  ledger=nextLedger;
  encryptionKey=nextEncryptionKey;
  encryptionMeta=nextEncryptionMeta;
  fileHandle=handle;
  directoryHandle=directory||null;
  demoMode=false;
  activeMonth=null; balanceEditMode=false; flowEditMode=false;
  registry[ledger.name]=handle;
  await idbSet(ledger.name, handle);      // 句柄持久化,便于刷新后重开
  if(directoryHandle) await idbSet(`dir:${ledger.name}`,directoryHandle);
  localStorage.setItem(LS_ACTIVE, ledger.name);
  if(isNew||needsMigrationSave) await persist();
  renderAll();
}

async function openFromFile(){
  if(!HAS_FS){ $("fallbackJsonInput").click(); return; }
  try{
    const opts={
      id:"family-ledger-open",
      types:[{description:"账本 JSON",accept:{"application/json":[".json"]}}]
    };
    // 有当前账本时从其所在目录开始；否则由浏览器恢复上次导入目录。
    if(fileHandle) opts.startIn=fileHandle;
    const [h] = await window.showOpenFilePicker(opts);
    if(!(await verifyPermission(h,true))){ alert("未授予文件读写权限"); return; }
    await useHandle(h,{isNew:false});
    setStatus("已打开账本: "+ledger.name);
  }catch(e){ if(e.name!=="AbortError") alert("打开失败: "+e.message); }
}

async function importFallbackFile(file){
  try{
    let obj=JSON.parse(await file.text());
    let nextEncryptionKey=null, nextEncryptionMeta=null;
    if(obj.schema==="nimble-ledger-encrypted-v1"){
      const password=await requestPassword({title:`打开加密账本：${file.name}`,hint:"请输入此账本的密码以解锁本地 JSON"});
      if(password==null) return;
      const unlocked=await unlockLedger(obj,password);
      obj=unlocked.data; nextEncryptionKey=unlocked.key; nextEncryptionMeta=unlocked.meta;
    }
    const nextLedger=migrateLedger(obj);
    ledger=nextLedger; encryptionKey=nextEncryptionKey; encryptionMeta=nextEncryptionMeta;
    fileHandle=null; directoryHandle=null; demoMode=false; activeMonth=null; balanceEditMode=false; flowEditMode=false;
    renderAll();
    $("openDialog").hidden=true;
    setStatus(`已导入 ${file.name}；请使用「备份」下载编辑后的 JSON`);
  }catch(e){ alert("导入失败: "+e.message); }
}

async function loadDemoLedger(){
  try{
    let obj;
    const embedded=$("embeddedDemoData")?.textContent?.trim();
    if(embedded){
      obj=JSON.parse(embedded);
    }else {
      const res=await fetch(new URL("./demo-ledger.json",location.href),{cache:"no-store"});
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      obj=await res.json();
    }
    ledger=migrateLedger(obj); fileHandle=null; directoryHandle=null; encryptionKey=null; encryptionMeta=null;
    demoMode=true; activeMonth=Object.keys(obj.months).sort().at(-1)||null; balanceEditMode=false; flowEditMode=false;
    renderAll();
    setStatus("正在体验示例账本；编辑后请下载示例副本或新建自己的账本");
    return true;
  }catch(e){
    console.warn("示例账本加载失败",e);
    return false;
  }
}

// ---------- 账本管理 ----------
async function switchLedger(name){
  if(!name || name===ledger?.name) return;
  const h=registry[name];
  if(!h){ alert("找不到该账本的文件句柄，请重新打开 JSON 文件"); renderLedgerManager(); return; }
  try{
    if(!(await verifyPermission(h,true))){ alert("未授予文件读写权限"); renderLedgerManager(); return; }
    await useHandle(h,{isNew:false});
    setStatus("已切换到: "+name);
    $("ledgerManagerDialog").hidden=true;
  }catch(e){ alert("切换失败: "+e.message); renderLedgerManager(); }
}
function openCreateDialog(){
  $("newName").value="";
  $("newPassword").value=""; $("newPasswordConfirm").value="";
  $("fsUnsupported").hidden = HAS_FS;
  $("createDialog").hidden=false;
}
async function removeLedgerRecord(name){
  if(!registry[name]) return;
  if(!confirm(`删除账本「${name}」的本机记录？\n不会删除磁盘上的 JSON 文件。`)) return;
  const isCurrent=ledger?.name===name;
  delete registry[name]; await idbDel(name);
  if(isCurrent){
    ledger=null; fileHandle=null; directoryHandle=null; demoMode=false; activeMonth=null; balanceEditMode=false; flowEditMode=false;
    encryptionKey=null; encryptionMeta=null;
    localStorage.removeItem(LS_ACTIVE);
  }
  await idbDel(`dir:${name}`);
  renderAll();
  if(isCurrent && /^https?:$/.test(location.protocol) && !Object.keys(registry).length && await loadDemoLedger()) return;
  setStatus(isCurrent?`已关闭并移除账本记录: ${name}`:`已移除账本记录: ${name}`);
}
async function renameCurrentLedger(){
  if(!ledger) return;
  const oldName=ledger.name;
  const name=(prompt("账本名称（不会修改磁盘文件名）:",oldName)||"").trim();
  if(!name||name===oldName) return;
  if(registry[name]){ alert("已有同名账本，请使用其他名称"); return; }
  ledger.name=name;
  try{
    if(fileHandle) await persist();
  }catch(error){
    ledger.name=oldName;
    renderAll();
    alert("重命名失败，原名称已保留："+error.message);
    return;
  }
  delete registry[oldName]; await idbDel(oldName); await idbDel(`dir:${oldName}`);
  if(fileHandle){
    registry[name]=fileHandle; await idbSet(name,fileHandle);
    if(directoryHandle) await idbSet(`dir:${name}`,directoryHandle);
  }
  localStorage.setItem(LS_ACTIVE,name);
  renderAll(); renderLedgerManager();
  setStatus("已重命名账本: "+name);
}
async function setLedgerPassword(){
  if(!ledger) return;
  if(encryptionKey){
    const oldPassword=await requestPassword({title:`验证当前密码：${ledger.name}`,hint:"修改或取消密码保护前，请先输入当前密码"});
    if(oldPassword==null) return;
    try{
      const wrapper=fileHandle ? JSON.parse(await (await fileHandle.getFile()).text()) : await serializeLedger();
      await unlockLedger(wrapper,oldPassword);
    }catch(e){ alert("当前密码不正确"); return; }
  }
  const password=await requestPassword({
    title:`${encryptionKey?"修改密码保护":"设置密码保护"}：${ledger.name}`,
    hint:encryptionKey?"留空并确认将取消密码保护，账本恢复为明文 JSON。":"可留空以保持明文 JSON。",
    confirm:true
  });
  if(password==null) return;
  const previousKey=encryptionKey, previousMeta=encryptionMeta;
  try{
    if(!password){
      if(!encryptionKey){ setStatus("账本保持明文存储"); return; }
      encryptionKey=null; encryptionMeta=null;
      await persist(); renderLedgerManager();
      setStatus("已取消密码保护，账本已恢复为明文 JSON");
      return;
    }
    const protectedData=await protectLedger(ledger,password);
    encryptionKey=protectedData.key; encryptionMeta=protectedData.meta;
    await persist(); renderLedgerManager();
    setStatus("已更新账本密码");
  }catch(e){
    encryptionKey=previousKey; encryptionMeta=previousMeta;
    renderLedgerManager();
    alert("设置密码失败，原密码状态已保留: "+e.message);
  }
}
async function backupCurrentLedger(filename){
  if(!ledger){ alert("请先打开账本"); return false; }
  try{
    const stamp=new Date().toISOString().replace(/[:.]/g,"-");
    const blob=new Blob([JSON.stringify(await serializeLedger(),null,2)],{type:"application/json"});
    const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
    a.download=typeof filename==="string"&&filename?filename:`${ledger.name}_backup_${stamp}.json`; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),0);
    setStatus("已下载备份: "+a.download);
    return true;
  }catch(error){
    alert("备份失败，未执行后续操作："+(error.message||"无法生成备份文件"));
    return false;
  }
}
