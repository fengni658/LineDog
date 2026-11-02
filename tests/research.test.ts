import {describe,it,expect} from "vitest";
import {applyChatEvent,beginRequest,freshSession} from "../src/chat-state";
import {citationParts,reportMarkdown,sourcesReport} from "../src/research-view";
import {readFileSync} from "node:fs";
import {version} from "../package.json";
describe("research UI evidence",()=>{
 it("exports the same app version as all build identities",()=>{
  const lock=JSON.parse(readFileSync("package-lock.json","utf8"));
  const tauri=JSON.parse(readFileSync("src-tauri/tauri.conf.json","utf8"));
  const cargo=readFileSync("src-tauri/Cargo.toml","utf8");
  const cargoLock=readFileSync("src-tauri/Cargo.lock","utf8");
  expect(sourcesReport(freshSession())).toMatchObject({version});
  expect(lock.version).toBe(version); expect(lock.packages[""].version).toBe(version);
  expect(tauri.version).toBe(version);
  expect(cargo.match(/\[package\][\s\S]*?\nversion = "([^"]+)"/)?.[1]).toBe(version);
  expect(cargoLock.match(/\[\[package\]\]\r?\nname = "linedog"\r?\nversion = "([^"]+)"/)?.[1]).toBe(version);
 });
 it("weather evidence keeps its distinct data label and stopped tasks reject late weather results",()=>{const s=freshSession();beginRequest(s,"ld-1","天气");s.sources=[{id:"S1",title:"Open-Meteo",url:"https://api.open-meteo.com/v1/forecast",domain:"api.open-meteo.com",retrievedAt:1,publishedAt:null,snippet:"模型估算",readState:"data",truncated:false}];expect(reportMarkdown(s)).toContain("已获取天气数据（模型估算/预报）");applyChatEvent(s,{requestId:"ld-1",kind:"cancelled"});expect(applyChatEvent(s,{requestId:"ld-1",kind:"tool_result",tool:"get_weather",count:1})).toBe(false);});
 it("ignores stale sources, stages and tool callbacks after stop",()=>{const s=freshSession();beginRequest(s,"ld-1","news");applyChatEvent(s,{requestId:"ld-1",kind:"cancelled"});for(const kind of ["sources","stage","tool_result"] as const)expect(applyChatEvent(s,{requestId:"ld-1",kind})).toBe(false);expect(s.sources).toEqual([]);});
 it("tool transitions replace interim narration and keep one user question",()=>{const s=freshSession();beginRequest(s,"ld-1","news");applyChatEvent(s,{requestId:"ld-1",kind:"delta",text:"准备搜索"});applyChatEvent(s,{requestId:"ld-1",kind:"reset_answer"});applyChatEvent(s,{requestId:"ld-1",kind:"stage",stage:"reading"});expect(s.messages.at(-1)?.content).toBe("");expect(s.messages).toHaveLength(2);expect(s.stage).toBe("reading");});
 it("invalid citations are identified, exported JSON excludes page body",()=>{const s=freshSession();beginRequest(s,"ld-1","news");s.sources=[{id:"S1",title:"source",url:"https://example.com/",domain:"example.com",retrievedAt:1,publishedAt:null,snippet:"summary",readState:"read",truncated:true,excerpt:"secret-page-content"}];applyChatEvent(s,{requestId:"ld-1",kind:"delta",text:"事实 [S1] 未知 [S99]"});applyChatEvent(s,{requestId:"ld-1",kind:"complete"});expect(citationParts(s.messages.at(-1)!.content,s).some(p=>p.invalid&&p.text==="[S99]")).toBe(true);expect(reportMarkdown(s)).toContain("无效引用：[S99]");expect(JSON.stringify(sourcesReport(s))).not.toContain("secret-page-content");expect(reportMarkdown(s)).toContain("发布：未知");});
 it("new model sessions do not inherit evidence or verified capabilities",()=>{const a=freshSession(),b=freshSession();a.capability="passed";expect(b.sources).toEqual([]);expect(b.capability).toBe("unverified");});
});
