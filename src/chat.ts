import { installLocationUI, type Location } from "./location-ui";
import { version as APP_VERSION } from "../package.json";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { applyChatEvent, beginRequest, errorText, freshSession, isBusy, requestMessages, networkAvailability, type ChatEvent, type Session } from "./chat-state";
import { installErrorDiagnostics, recordDiagnostic } from "./diagnostics";
import "./chat.css";
import { stages, citationParts, reportMarkdown, sourcesReport } from "./research-view";

interface Profile { id:string; name:string; model:string; baseUrl:string; timeoutSeconds:number; hasKey:boolean; keyError:boolean; reasoningEffort?:string }
interface Config { profiles:Profile[]; defaultId:string; imported:boolean }
installErrorDiagnostics();
const app = document.querySelector<HTMLElement>("#app")!;
app.setAttribute("aria-label", "线条小狗聊天");
app.innerHTML = `
  <header><div><span class="eyebrow">LINEDOG · ${APP_VERSION}</span><h1>陪你聊，也帮你查</h1></div><div class="header-actions"><button id="location">位置</button><button id="new">新对话</button><button id="settings" title="模型设置">设置</button></div></header>
  <details id="options"><summary id="options-summary">模型与联网选项</summary>
  <div class="model-row"><label for="model">API 连接</label><select id="model"></select></div>
  <div class="model-row"><label for="model-type">模型类型</label><select id="model-type"></select><button id="refresh-models">刷新</button></div>
  <div class="model-row"><label for="effort">思考强度</label><select id="effort"></select></div>
  <div class="model-row"><label for="network">联网</label><select id="network"><option value="off">关闭</option><option value="auto" selected>自动判断</option><option value="required">必须联网</option></select><label for="depth">深度</label><select id="depth"><option value="daily">日常问答</option><option value="research">专题调研</option></select></div>
  </details>
  <p id="network-state" class="capability-note" role="status"></p>
  <p id="notice" role="status">正在读取模型配置…</p>
  <details id="evidence"><summary>执行记录与来源 <span id="source-count"></span></summary><p id="capability"></p><p id="budget"></p><div id="tool-history"></div><div id="sources"></div><div class="dialog-actions"><button id="preview">报告预览</button><button id="export-md">导出 Markdown</button><button id="export-sources">导出来源 JSON</button></div></details>
  <section id="messages" aria-label="聊天记录" tabindex="0"></section>
  <p id="status" role="status" aria-live="polite">准备就绪</p>
  <form id="composer"><label class="sr-only" for="input">消息</label><textarea id="input" rows="3" maxlength="30000" placeholder="说点什么… Enter 发送，Shift+Enter 换行"></textarea><div class="compose-actions"><small>仅本次运行保留 · 不写入诊断日志</small><button type="button" id="stop" hidden>停止</button><button id="send" type="submit" class="primary">发送</button></div></form>
  <footer><button id="export">导出诊断日志</button><span id="log-status">诊断记录就绪</span></footer>
  <dialog id="failure" aria-labelledby="failure-title"><h2 id="failure-title">请求未完成</h2><p id="failure-text"></p><p class="muted">不会自动重试或切换模型。</p><div class="dialog-actions"><button id="dismiss">取消</button><button id="switch">切换模型</button><button id="retry" class="primary">重试</button></div></dialog>
  <dialog id="config-dialog" aria-labelledby="config-title"><h2 id="config-title">模型设置</h2><form id="config-form"><label>已有连接<select id="profile"></select></label><button id="add" type="button">添加兼容 API</button><label>名称<input id="name" maxlength="120" required></label><label>Base URL<input id="base" type="url" required placeholder="https://api.example.com/v1"></label><label>模型 ID<input id="model-id" maxlength="200" required></label><label>API Key<input id="key" type="password" autocomplete="new-password" placeholder="留空保留已保存密钥"></label><small id="key-state"></small><label>总超时（秒）<input id="timeout" type="number" min="30" max="600" value="180" required></label><small>整轮请求共用此预算，包含模型、搜索和天气；日常与专题均适用。连接、首字或断流超时可能提前结束。</small><label class="checkbox"><input id="default" type="checkbox">设为默认模型</label><p id="config-status" role="status"></p><div class="dialog-actions"><button id="close-config" type="button">关闭</button><button id="check" type="button">测试已保存连接</button><button class="primary" type="submit">保存</button></div></form></dialog>
`;
app.insertAdjacentHTML("beforeend",`<dialog id="report-dialog"><h2>报告预览</h2><pre id="report-preview"></pre><button id="close-report">关闭</button></dialog>`);
document.getElementById("config-dialog")!.insertAdjacentHTML("beforeend",`<section class="search-settings"><h2>联网搜索 · Tavily</h2><p>搜索查询和所阅读 URL 会发送给 Tavily；不会直接发送整段聊天历史。使用 basic，账户余额未知，不自动购买或重试。</p><label for="search-key">Tavily API Key</label><input id="search-key" type="password" autocomplete="new-password" placeholder="填写后受 Windows 当前用户保护"><p id="search-state"></p><div class="dialog-actions"><button id="save-search">保存搜索密钥</button><button id="test-search">测试搜索（可能消耗额度）</button></div></section>`);
const $ = <T extends HTMLElement>(id:string):T => document.getElementById(id) as T;
const select = $<HTMLSelectElement>("model");
const modelType = $<HTMLSelectElement>("model-type");
const effort = $<HTMLSelectElement>("effort");
const network=$<HTMLSelectElement>("network"),depth=$<HTMLSelectElement>("depth");
let searchReady=false;
let currentLocation:Location|null=null;
let catalogGeneration = 0;
const selections = new Map<string,{model:string;effort:string}>();
const choice = () => selections.get(selected) ?? {model:config.profiles.find(p=>p.id===selected)?.model??"",effort:""};
const sessionKey = () => JSON.stringify([selected,choice().model]);
const input = $<HTMLTextAreaElement>("input");
const failure = $<HTMLDialogElement>("failure");
const settings = $<HTMLDialogElement>("config-dialog");
const sessions = new Map<string,Session>();
let config:Config = {profiles:[],defaultId:"ld-0",imported:false};
let selected = "ld-0";
let editing = "";
let exporting = false;
let initialized = false;
const session = ():Session => { let s=sessions.get(sessionKey()); if (!s) {s=freshSession();sessions.set(sessionKey(),s);} return s; };
const errorMessage=(e:unknown):string=>errorText[typeof e==="string"?e:"unknown"]??errorText.unknown;

function options(target:HTMLSelectElement,value:string):void { target.replaceChildren();for(const p of config.profiles){const option=document.createElement("option");option.value=p.id;option.textContent=p.name+(p.id===config.defaultId?" · 默认":"");target.append(option);}target.value=value; }
function render():void {
  const s=session(),busy=isBusy(s);select.disabled=busy;modelType.disabled=busy;effort.disabled=busy;$("refresh-models").toggleAttribute("disabled",busy);$("settings").toggleAttribute("disabled",busy);$("new").toggleAttribute("disabled",busy);
  network.disabled=busy;depth.disabled=busy;$("location").toggleAttribute("disabled",busy);
  const available=networkAvailability(network.value,searchReady);
  $("network-state").textContent=available.weather?`天气接口已启用 · ${currentLocation?.label??"未保存位置，可点击右上角“位置”或直接告诉我城市/区县。"}；${available.search?"网页搜索密钥已配置，实际可用性以执行结果为准。":"网页搜索未配置；天气查询不需要搜索密钥。"}`:"联网已关闭：不查询天气或网页。";
  $("options-summary").textContent=`${choice().model||"选择模型"} · ${{off:"联网关闭",auto:"自动联网",required:"必须联网"}[network.value]} · ${choice().effort||"服务默认"}`;
  $("capability").textContent=`请求模型：${s.requestedModel||choice().model}；服务返回模型：${s.returnedModel||"未返回"}。工具调用：${s.capability==="passed"?"实测通过（调用执行及结果回传）":s.capability==="failed"?"失败":"未验证"}。这些是协议记录，不是独立身份认证。思考强度：${choice().effort||"服务默认"}${choice().effort?"（请求值，生效未确认）":""}。`;
  $("source-count").textContent=s.sources.length?`· ${s.sources.length} 条来源`:"";
  $("budget").textContent=s.budget?`天气 ${s.budget.weatherCalls??0}/2 · 搜索 ${s.budget.searches}/${s.budget.maxSearches} · 阅读 ${s.budget.reads}/${s.budget.maxReads} · 模型 ${s.budget.models}/${s.budget.maxModels} · Tavily 已返回用量 ${s.budget.credits??"未知"}`:searchReady?"搜索密钥已配置；只有实际获取资料后才能核实信息。":"尚未配置搜索密钥：通用搜索需要配置；天气使用独立接口。";
  $("tool-history").replaceChildren(...s.tools.map(t=>{const p=document.createElement("p");p.textContent=t.kind==="tool_start"?`${t.tool}：${t.query??t.sourceId??""}`:`${t.tool}：${t.code?(errorText[t.code]??t.code):`完成，${t.count??0} 条结果`} · ${t.elapsedMs??0} ms`;return p;}));
  $("sources").replaceChildren(...s.sources.map(x=>{const card=document.createElement("article");card.id=`source-${x.id}`;card.className="source-card";const a=document.createElement("a");a.textContent=`[${x.id}] ${x.title}`;a.href=x.url;a.target="_blank";a.rel="noopener noreferrer";const p=document.createElement("p");p.textContent=`${x.domain} · 发布：${x.publishedAt??"未知"} · ${x.readState==="data"?"已获取天气数据（估算/预报）":x.readState==="read"?"已提取正文":x.readState==="read_failed"?"提取失败":"仅搜索摘要"}${x.truncated?" · 片段限长":""}`;if(x.weatherData?.current?.time)p.textContent+=` · 数据时刻：${new Date(x.weatherData.current.time*1000).toISOString()}（UTC）`;card.append(a,p);return card;}));
  for(const id of ["preview","export-md","export-sources"])$(id).toggleAttribute("disabled",busy||!s.messages.some(m=>m.role==="assistant"&&m.content));
  $("send").toggleAttribute("disabled",busy||config.profiles.length===0);$("stop").hidden=!busy;
  const statuses={idle:"准备就绪",waiting:"等待模型回复…",streaming:"正在回复…",complete:"回复完成",failed:"请求失败 · 可重试或切换模型",stopped:"已停止 · 部分回复未完成"};
  $("status").textContent=(busy||s.status==="complete")&&s.stage?stages[s.stage]??statuses[s.status]:statuses[s.status];
  if(s.stage==="partial"){const error=s.tools.find(t=>t.code)?.code; if(error) $("status").textContent=`部分完成 · ${errorText[error]??error}`;}
  const list=$("messages");const nearBottom=list.scrollHeight-list.scrollTop-list.clientHeight<80;list.replaceChildren();
  if(s.messages.length===0){const empty=document.createElement("div");empty.className="empty";empty.innerHTML="<span class='dog-mark' aria-hidden='true'>♡</span><h2>今天过得怎么样？</h2><p>发送一条消息，开始这次对话。<br>模型只会看到你在这里发送的内容。</p>";list.append(empty);}
  for(const message of s.messages){if(!message.content && message.role==="assistant")continue;const article=document.createElement("article");article.className=`message ${message.role}`;const label=document.createElement("small");label.textContent=message.role==="user"?"你":`${choice().model||"模型"}${!message.complete?" · 未完成":""}`;const text=document.createElement("div");if(message.role==="user")text.textContent=message.content;else for(const part of citationParts(message.content,s)){if(part.source){const a=document.createElement("button");a.className="citation";a.textContent=part.text;a.onclick=()=>{$<HTMLDetailsElement>("evidence").open=true;$(`source-${part.source}`).scrollIntoView({block:"nearest"});};text.append(a);}else{const span=document.createElement("span");span.textContent=part.text+(part.invalid?"（无效引用）":"");if(part.invalid)span.className="invalid-citation";text.append(span);}}article.append(label,text);list.append(article);}
  if(nearBottom || busy)list.scrollTop=list.scrollHeight;
}
async function loadConfig():Promise<void>{
  config=await invoke<Config>("model_configs");if(!initialized || !config.profiles.some(p=>p.id===selected))selected=config.defaultId;
  initialized=true;
  options(select,selected);syncChoices();void refreshModels();$("notice").textContent=config.imported?"已复用 CLIProxyAPI · 回复由当前模型提供":"请先在设置中补全 Codex 连接；不会自动切换模型。";render();
}
async function start(text?:string):Promise<void>{
  const s=session();if(isBusy(s))return;
  const previous=requestMessages(s);const length=previous.reduce((n,m)=>n+new TextEncoder().encode(m.content).length,0)+new TextEncoder().encode(text??"").length;
  if(length>100000 || previous.length+(text!==undefined?1:0)>100){$("notice").textContent=errorText.context;return;}
  const id=`ld-${Date.now()}-${Math.floor(Math.random()*1000000)}`;
  const profileId=selected,requested={...choice()},networkMode=network.value,requestDepth=depth.value;
  beginRequest(s,id,text,requested.model);if(text!==undefined)input.value="";render();
  const channel=new Channel<ChatEvent>();channel.onmessage=e=>{if(applyChatEvent(s,e)){render();if(e.kind==="failed")showFailure(s);}};
  try{await invoke("chat_start",{profileId,model:requested.model,reasoningEffort:requested.effort,requestId:id,sessionId:s.id,networkMode,depth:requestDepth,localClock:`${new Date().toLocaleString("sv-SE")} ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,messages:requestMessages(s),onEvent:channel});}
  catch(e){const code=typeof e==="string"?e:"unknown";recordDiagnostic("request_failed",{request_id:id,config_id:profileId,code});if(applyChatEvent(s,{requestId:id,kind:"failed",code})){render();showFailure(s);}}
}
function showFailure(s:Session):void {$("failure-text").textContent=errorText[s.error]??errorText.unknown;if(!failure.open)failure.showModal();}
$("composer").addEventListener("submit",e=>{e.preventDefault();const text=input.value.trim();if(!text || isBusy(session()))return;void start(text);});
input.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();$<HTMLFormElement>("composer").requestSubmit();}});
$("stop").onclick=()=>{void invoke("chat_cancel").catch(e=>{$("notice").textContent=errorMessage(e);});};
$("retry").onclick=()=>{failure.close();void start();};
$("dismiss").onclick=()=>failure.close();
$("switch").onclick=()=>{failure.close();$<HTMLDetailsElement>("options").open=true;modelType.focus();$("notice").textContent="请选择其他模型；原对话不会发送给新模型。可选择 5.6 系列，也可在设置中添加其他 API。";};
select.onchange=()=>{if(isBusy(session()))return;selected=select.value;syncChoices();void refreshModels();recordDiagnostic("model_switch",{config_id:selected});$("notice").textContent="已切换到该模型的独立会话。";render();};
$("new").onclick=()=>{if(!isBusy(session())){void invoke("research_forget",{sessionId:session().id}).catch(()=>{});sessions.set(sessionKey(),freshSession());render();input.focus();}};

function syncChoices():void {
  const c=choice();selections.set(selected,c);
  modelType.replaceChildren(new Option(c.model,c.model));
  effort.replaceChildren(...[["","服务默认"],["low","low · 请求值，未确认"],["medium","medium · 请求值，未确认"],["high","high · 请求值，未确认"]].map(([value,label])=>new Option(label,value)));
  effort.value=c.effort;if(effort.selectedIndex<0){effort.add(new Option(`${c.effort} · 旧请求值，未确认`,c.effort));effort.value=c.effort;}
}
async function refreshModels():Promise<void>{
  const generation=++catalogGeneration,id=selected;
  try{const models=await invoke<string[]>("model_catalog",{profileId:id});if(generation!==catalogGeneration||id!==selected)return;
    const current=choice().model;modelType.replaceChildren(...[...new Set([current,...models.filter(m=>!m.startsWith("gpt-image-")&&m!=="codex-auto-review")])].map(m=>new Option(m,m)));modelType.value=current;
    $("notice").textContent="已读取服务模型列表；列表可见不代表当前一定能回复。思考强度由服务支持情况决定。";
  }catch(e){if(generation===catalogGeneration)$("notice").textContent=`模型列表读取失败：${errorMessage(e)} 可刷新重试或在设置中填写模型 ID。`;}
}
modelType.onchange=()=>{if(isBusy(session()))return;const model=modelType.value;selections.set(selected,{model,effort:""});syncChoices();void refreshModels();recordDiagnostic("model_switch",{config_id:selected});$("notice").textContent="已切换模型，原模型会话独立保留。";render();};
effort.onchange=()=>{if(!isBusy(session())){selections.set(selected,{...choice(),effort:effort.value});$("notice").textContent="思考强度为请求值，生效未确认；仅在本次运行保留。";render();}};
network.onchange=()=>render();depth.onchange=()=>render();
$("refresh-models").onclick=()=>void refreshModels();

function fillProfile(id:string):void {
  editing=id;const p=config.profiles.find(p=>p.id===id);
  $<HTMLInputElement>("name").value=p?.name??"";$<HTMLInputElement>("base").value=p?.baseUrl??"";
  $<HTMLInputElement>("model-id").value=p?.model??"";$<HTMLInputElement>("key").value="";
  $<HTMLInputElement>("timeout").value=String(p?.timeoutSeconds??180);$<HTMLInputElement>("default").checked=id===config.defaultId;
  $("key-state").textContent=p?.keyError?"保存的密钥无法解密，请重新填写。":p?.hasKey?"密钥已受保护保存，不能读回。":"尚未配置密钥。";$("config-status").textContent="";
}
function openSettings():void {if(isBusy(session()))return;options($<HTMLSelectElement>("profile"),selected);fillProfile(selected);if(!settings.open)settings.showModal();}
$("settings").onclick=openSettings;
$("close-config").onclick=()=>{settings.close();$<HTMLInputElement>("key").value="";};
settings.addEventListener("close",()=>{$<HTMLInputElement>("key").value="";$<HTMLInputElement>("search-key").value="";});
$<HTMLSelectElement>("profile").onchange=()=>fillProfile($<HTMLSelectElement>("profile").value);
$("add").onclick=()=>{fillProfile("");$<HTMLSelectElement>("profile").value="";$<HTMLInputElement>("name").focus();};
$("config-form").addEventListener("submit",e=>{e.preventDefault();void saveProfile();});
async function saveProfile():Promise<void>{
  const form=$<HTMLFormElement>("config-form");const buttons=form.querySelectorAll<HTMLButtonElement>("button");buttons.forEach(b=>b.disabled=true);
  try{
    const result=await invoke<{id:string}>("model_save",{profile:{id:editing,name:$<HTMLInputElement>("name").value,baseUrl:$<HTMLInputElement>("base").value,model:$<HTMLInputElement>("model-id").value,reasoningEffort:config.profiles.find(p=>p.id===editing)?.reasoningEffort??"",apiKey:$<HTMLInputElement>("key").value,timeoutSeconds:Number($<HTMLInputElement>("timeout").value)},makeDefault:$<HTMLInputElement>("default").checked});
    // A changed endpoint must not inherit an earlier endpoint's in-memory conversation.
    for(const key of sessions.keys()){if(JSON.parse(key)[0]===result.id){await invoke("research_forget",{sessionId:sessions.get(key)!.id});sessions.delete(key);}}selections.delete(result.id);await loadConfig();options($<HTMLSelectElement>("profile"),result.id);fillProfile(result.id);$("config-status").textContent="已保存。可测试已保存连接。";
  }catch(e){$("config-status").textContent=errorMessage(e);}finally{$<HTMLInputElement>("key").value="";buttons.forEach(b=>b.disabled=false);}
}
$("check").onclick=()=>{void(async()=>{if(!editing){$("config-status").textContent="请先保存连接。";return;}$("check").toggleAttribute("disabled",true);$("config-status").textContent="正在检查已保存配置的模型列表…";try{const found=await invoke<boolean>("model_check",{profileId:editing});$("config-status").textContent=found?"已连接，模型在列表中；实际回复请发送消息验证。":"服务可连接，但未找到此模型 ID。";}catch(e){$("config-status").textContent=errorMessage(e);}finally{$("check").removeAttribute("disabled");}})();};
async function exportLogs():Promise<void>{if(exporting)return;exporting=true;$("export").toggleAttribute("disabled",true);try{const saved=await invoke<boolean>("diagnostic_export");$("notice").textContent=saved?"诊断日志已保存，可将该 JSON 文件提交给 Codex。":"已取消导出。";}catch(e){$("notice").textContent=`${errorMessage(e)} 可再次点击导出重试。`;}finally{exporting=false;$("export").removeAttribute("disabled");}}
$("export").onclick=()=>void exportLogs();
async function page(name:string):Promise<void>{if(name==="settings")openSettings();if(name==="diagnostics")await exportLogs();}
void listen<string>("chat-page",e=>void page(e.payload));
void loadConfig().then(()=>page(new URLSearchParams(location.search).get("page")??"chat")).catch(e=>{$("notice").textContent=errorMessage(e);render();});
async function logStatus():Promise<void>{try{const ok=await invoke<boolean>("diagnostic_status");$("log-status").textContent=ok?"不含聊天正文或密钥":"诊断记录不可用 · 文件写入失败";}catch{$("log-status").textContent="诊断状态不可用";}}
void logStatus();setInterval(()=>void logStatus(),10000);
render();
async function loadSearch():Promise<void>{try{const v=await invoke<{hasKey:boolean;keyError:boolean}>("search_config");searchReady=v.hasKey&&!v.keyError;$("search-state").textContent=v.keyError?"保存的密钥无法解密，请重新填写。":v.hasKey?"已受保护保存，密钥不可读回。":"尚未配置。填写后保存。";render();}catch(e){searchReady=false;$("search-state").textContent=errorMessage(e);render();}}
$("save-search").onclick=()=>{void(async()=>{try{await invoke("search_save",{apiKey:$<HTMLInputElement>("search-key").value});await loadSearch();}catch(e){$("search-state").textContent=errorMessage(e);}finally{$<HTMLInputElement>("search-key").value="";}})();};
$("test-search").onclick=()=>{void(async()=>{$("test-search").toggleAttribute("disabled",true);$("search-state").textContent="正在真实搜索…";try{const v=await invoke<{count:number;usage:number|null}>("search_test");$("search-state").textContent=`服务返回 ${v.count} 条结果；本次返回用量：${v.usage??"未知"}。这不等于模型工具调用已验证。`;}catch(e){$("search-state").textContent=errorMessage(e);}finally{$("test-search").removeAttribute("disabled");}})();};
$("preview").onclick=()=>{$("report-preview").textContent=reportMarkdown(session());$<HTMLDialogElement>("report-dialog").showModal();};
$("close-report").onclick=()=>$<HTMLDialogElement>("report-dialog").close();
async function exportReport(format:"md"|"json"):Promise<void>{if(exporting)return;exporting=true;try{const saved=await invoke<boolean>("report_export",{format,report:format==="md"?reportMarkdown(session()):sourcesReport(session())});$("notice").textContent=saved?"报告已保存。":"已取消保存。";}catch(e){$("notice").textContent=`${errorMessage(e)} 可再次点击导出重试。`;}finally{exporting=false;}}
$("export-md").onclick=()=>void exportReport("md");$("export-sources").onclick=()=>void exportReport("json");
void loadSearch();

installLocationUI(location=>{currentLocation=location;render();});
