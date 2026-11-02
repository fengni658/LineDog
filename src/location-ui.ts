import { invoke } from "@tauri-apps/api/core";
import { errorText } from "./chat-state";
export interface Location {id:string;label:string;latitude:number;longitude:number;origin:string;acquiredAt:number;accuracyMeters?:number}
export function installLocationUI(onChange:(location:Location|null)=>void):void {
  document.body.insertAdjacentHTML("beforeend",`<dialog id="location-dialog" aria-labelledby="location-title"><h2 id="location-title">位置与天气</h2><p>仅点击时获取 Windows 位置，不持续追踪。位置按约 1 公里网格保存并由 Windows 当前用户加密保护。城市名称发给 Open-Meteo / GeoNames 查询；天气查询向 Open-Meteo 发送近似坐标，模型只收到地点名称和天气数据。位置不写入诊断日志。</p><button id="loc-device">获取 Windows 位置</button><p>也可手动查找城市/区县，核对省市后选择。示例：通州；多地同名时不会自动选中。</p><label for="loc-query">城市或区县</label><div class="location-row"><input id="loc-query" placeholder="如：通州"><button id="loc-search">查找</button></div><label for="loc-candidates">地点候选</label><select id="loc-candidates"><option value="">请先查找或定位</option></select><p id="loc-state" role="status"></p><div class="dialog-actions"><button id="loc-clear">清除保存位置</button><button id="loc-close">关闭</button><button id="loc-save" class="primary">保存选中位置</button></div><p>Windows 定位可能受系统开关、权限和设备能力限制；定位失败请手动选择。保存位置不会随移动自动更新。天气：Open-Meteo，地名：GeoNames。</p></dialog>`);
  const el=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
  const dialog=el<HTMLDialogElement>("location-dialog"),select=el<HTMLSelectElement>("loc-candidates"),status=el("loc-state");
  let busy=false;
  const state=(p:Location|null)=>{onChange(p);status.textContent=p?`已保存：${p.label} · ${new Date(p.acquiredAt).toLocaleString()}；可清除或重新定位。`:"尚未保存位置；天气问题可在聊天中提供城市。";};
  const run=async(action:()=>Promise<void>)=>{if(busy)return;busy=true;dialog.querySelectorAll<HTMLButtonElement>("button").forEach(b=>b.disabled=true);try{await action();}catch(e){status.textContent=errorText[typeof e==="string"?e:""]??"位置操作失败，可重试或手动选择。";}finally{busy=false;dialog.querySelectorAll<HTMLButtonElement>("button").forEach(b=>b.disabled=false);}};
  const candidates=(values:Location[])=>{select.replaceChildren(new Option("请选择并核对所属省市",""),...values.map(v=>new Option(`${v.label} · ${v.latitude.toFixed(2)}, ${v.longitude.toFixed(2)}${v.accuracyMeters?` · 系统精度约 ${Math.round(v.accuracyMeters)} 米`:""}`,v.id)));status.textContent=values.length?`取得 ${values.length} 个候选；选择后点击保存。`:"没有匹配地点，请尝试区县名、城市名或英文名。";};
  el("location").onclick=()=>{dialog.showModal();void run(async()=>state(await invoke<Location|null>("location_get")));};
  el("loc-close").onclick=()=>dialog.close();
  el("loc-search").onclick=()=>void run(async()=>{status.textContent="正在查找地点…";candidates(await invoke<Location[]>("location_search",{query:el<HTMLInputElement>("loc-query").value}));});
  el<HTMLInputElement>("loc-query").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.isComposing){e.preventDefault();el("loc-search").click();}});
  el("loc-device").onclick=()=>void run(async()=>{status.textContent="等待 Windows 定位；若系统询问权限，请由你决定是否允许…";candidates([await invoke<Location>("location_device")]);});
  el("loc-save").onclick=()=>void run(async()=>{if(!select.value){status.textContent="请先选择一个候选地点。";return;}state(await invoke<Location>("location_save",{id:select.value}));});
  el("loc-clear").onclick=()=>void run(async()=>{state(await invoke<null>("location_save",{id:""}));select.replaceChildren(new Option("请先查找或定位",""));});
  void invoke<Location|null>("location_get").then(state).catch(()=>{onChange(null);status.textContent=errorText.location_config;});
}
