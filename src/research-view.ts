import type { Session } from "./chat-state";
import { version as APP_VERSION } from "../package.json";
export const stages:Record<string,string>={weather:"正在获取天气数据",understanding:"理解问题",searching:"正在搜索",reading:"正在阅读",organizing:"正在整理",generating:"生成回答",partial:"部分完成 · 请查看资料缺口",complete:"回答完成"};
export function citationParts(text:string,s:Session):{text:string;source?:string;invalid?:boolean}[]{
 return text.split(/(\[S\d+\])/g).filter(Boolean).map(text=>/^\[S\d+\]$/.test(text)?{text,source:s.sources.find(x=>`[${x.id}]`===text)?.id,invalid:!s.sources.some(x=>`[${x.id}]`===text)}:{text});
}
export function reportMarkdown(s:Session):string {
 const answer=s.messages.filter(m=>m.role==="assistant").at(-1)?.content??"";
 const invalid=citationParts(answer,s).filter(p=>p.invalid).map(p=>p.text);
 return `# LineDog 资料报告\n\n任务开始：${new Date(s.startedAt).toISOString()}\n\n状态：${s.status}${s.stage==="partial"?"（部分完成）":""}\n\n${answer}\n\n${invalid.length?`无效引用：${[...new Set(invalid)].join("、")}\n\n`:""}## 来源\n\n`+s.sources.map(x=>`- [${x.id}] ${x.title.replace(/[\r\n]/g," ")}\n  ${x.url}\n  发布：${x.publishedAt??"未知"}；检索：${new Date(x.retrievedAt).toISOString()}；${x.readState==="data"?"已获取天气数据（模型估算/预报）":x.readState==="read"?"已提取正文":x.readState==="read_failed"?"提取失败":"仅搜索摘要"}${x.truncated?"（正文片段已限长）":""}`).join("\n");
}
export function sourcesReport(s:Session):unknown {return {version:APP_VERSION,startedAt:s.startedAt,finishedAt:s.finishedAt,status:s.status,stage:s.stage,sources:s.sources.map(({excerpt:_,...metadata})=>metadata),usage:s.budget};}
