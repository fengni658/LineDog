export type ChatStatus = "idle" | "waiting" | "streaming" | "complete" | "failed" | "stopped";
export interface Message { role: "user" | "assistant"; content: string; complete: boolean }
export interface SourceRecord { id:string; title:string; url:string; domain:string; retrievedAt:number; publishedAt:string|null; snippet:string; readState:"snippet"|"read"|"read_failed"|"data"; truncated:boolean; excerpt?:string; weatherData?:{current?:{time?:number};timezone?:string} }
export interface ChatEvent { requestId: string; kind: "delta" | "complete" | "failed" | "cancelled" | "stage" | "tool_start" | "tool_result" | "sources" | "budget" | "returned_model" | "reset_answer" | "capability"; text?: string; code?: string; stage?:string; model?:string; state?:string; sources?:SourceRecord[]; tool?:string; query?:string; sourceId?:string; count?:number; elapsedMs?:number; searches?:number; reads?:number; models?:number; maxSearches?:number; maxReads?:number; maxModels?:number; weatherCalls?:number; maxWeatherCalls?:number; credits?:number|null }
export interface Session { id:string; messages: Message[]; status: ChatStatus; requestId: string; error: string; stage:string; sources:SourceRecord[]; tools:ChatEvent[]; requestedModel:string; returnedModel:string; capability:string; budget:ChatEvent|null; startedAt:number; finishedAt:number }
export const freshSession = (): Session => ({ id:`ld-${Date.now()}-${Math.floor(Math.random()*1000000)}`, messages: [], status: "idle", requestId: "", error: "", stage:"", sources:[],tools:[],requestedModel:"",returnedModel:"",capability:"unverified",budget:null,startedAt:0,finishedAt:0 });
export const isBusy = (s: Session): boolean => s.status === "waiting" || s.status === "streaming";
export function requestMessages(s: Session): { role: string; content: string }[] {
  return s.messages.filter(m => m.complete).map(({ role, content }) => ({ role, content }));
}
export function beginRequest(s: Session, id: string, text?: string, requestedModel = ""): void {
  if (isBusy(s)) throw new Error("busy");
  if (text !== undefined) { s.messages.push({ role: "user", content: text, complete: true }); }
  else { const last = s.messages.at(-1); if (last?.role === "assistant" && !last.complete) s.messages.pop(); }
  s.requestId = id; s.status = "waiting"; s.error = "";
  s.stage="understanding";s.tools=[];s.budget=null;s.requestedModel=requestedModel;s.returnedModel="";s.capability="unverified";s.startedAt=Date.now();s.finishedAt=0;
  s.messages.push({ role: "assistant", content: "", complete: false });
}
export function applyChatEvent(s: Session, e: ChatEvent): boolean {
  if (e.requestId !== s.requestId || !isBusy(s)) return false;
  const reply = s.messages.at(-1);
  if (!reply || reply.role !== "assistant") return false;
  if(e.kind==="reset_answer") reply.content="";
  if(e.kind==="stage") s.stage=e.stage??"";
  if(e.kind==="sources") s.sources=e.sources??[];
  if(e.kind==="returned_model") s.returnedModel=e.model??"";
  if(e.kind==="capability") s.capability=e.state??"unverified";
  if(e.kind==="budget") s.budget=e;
  if(e.kind==="tool_start"||e.kind==="tool_result") s.tools.push(e);
  if (e.kind === "delta") { reply.content += e.text ?? ""; s.status = "streaming"; }
  if (e.kind === "complete") { reply.complete = true; s.status = "complete";s.finishedAt=Date.now(); }
  if (e.kind === "failed") { s.status = "failed"; s.error = e.code ?? "unknown"; s.finishedAt=Date.now(); }
  if (e.kind === "cancelled") { s.status = "stopped"; s.finishedAt=Date.now(); }
  return true;
}
export function networkAvailability(mode: string, hasSearchKey: boolean): { weather: boolean; search: boolean } {
  const enabled = mode !== "off";
  return { weather: enabled, search: enabled && hasSearchKey };
}
export const errorText: Record<string,string> = {
  location_missing:"尚未设置位置。请点击右上角‘位置’获取 Windows 位置或选择城市，也可以直接告诉我城市/区县。",
  location_query:"请填写 2–100 个字符的城市或区县名称。",location_not_found:"没有找到匹配地区，请补充省市或在位置设置中选择。",location_ambiguous:"有多个同名地点，请补充省市或在位置设置中明确选择。",
  location_denied:"Windows 未允许定位。请手动选择城市；如果需要系统定位，请由你在 Windows 设置中检查位置权限。",location_unavailable:"Windows 无法取得位置或已超时。可以手动查找城市/区县，不会用网络出口地址冒充你的位置。",location_config:"保存的位置无法读取，请重新选择并保存。",
  weather_connection:"无法连接天气数据服务，请检查网络后主动重试。",weather_timeout:"天气数据请求超时，未自动重试。",weather_limit:"天气服务请求受限，请稍后主动重试。",weather_server:"天气服务暂时不可用。",weather_response:"天气服务未返回有效数据，不能报告当前天气。",weather_stale:"天气数据时间已过期或与本机时间不符，未将它当作当前天气。",
  search_key:"尚未配置 Tavily 密钥。请在设置中的联网搜索区域填写，再执行必须联网任务。",
  search_empty:"本轮没有取得可用的网络资料，不能声称已经核实。请调整问题或稍后主动重试。",
  search_authentication:"Tavily 认证失败，请检查搜索密钥。",search_limit:"Tavily 请求受限或额度不足；不会自动重试，请检查服务账户。",
  search_timeout:"联网搜索超时，未自动重试。",search_connection:"无法连接搜索服务。",search_server:"搜索服务暂时不可用。",
  extract_failed:"网页正文提取失败，可能需要登录、验证码或不支持该页面。",tool_budget:"已达到工具执行预算。已有资料保留，可缩小问题范围后重新发起。",
  unsafe_url:"网页地址不属于允许读取的公开 HTTP(S) 页面。",unknown_source:"未找到登记的来源。",tool_arguments:"模型返回的工具参数无效。",unknown_tool:"模型请求了未注册工具。",
  upstream_tls: "代理连接模型上游时 TLS 握手失败。可手动选择其他模型重试；若持续失败，需要检查代理的上游网络。",
  connection: "无法连接模型服务，请检查 CLIProxyAPI 是否运行或网络是否可用。",
  authentication: "认证失败或尚未配置密钥，请检查模型设置。",
  model_missing: "服务未找到此模型，请检查模型 ID。", rate_limit: "服务请求受限，请稍后重试。",
  server: "模型服务暂时不可用，请重试或手动切换模型。", timeout: "等待模型回复超时，请重试或手动切换模型。",
  response: "回复格式异常或传输中断，已有部分回复已保留。", config: "模型配置无法使用，请检查设置；已有文件不会被自动覆盖。",
  storage: "无法读写本地文件，请检查保存位置与访问权限。", context: "对话过长，请开始新对话后重新发送。",
  unknown: "操作失败，请重试或导出诊断日志。",
};
