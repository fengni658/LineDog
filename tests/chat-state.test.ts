import {describe,it,expect,vi} from "vitest";
import {applyChatEvent,beginRequest,freshSession,isBusy,requestMessages,networkAvailability} from "../src/chat-state";
import {routeWindowLabel} from "../src/window-entry";
describe("0.8 chat requests",()=>{
  it("second turn sends latest message and starts an empty reply; new conversation has no test instruction",()=>{
    const s=freshSession();beginRequest(s,"ld-1","请只回复：测试成功");
    applyChatEvent(s,{requestId:"ld-1",kind:"delta",text:"测试成功"});
    applyChatEvent(s,{requestId:"ld-1",kind:"complete"});
    beginRequest(s,"ld-2","你好");
    expect(requestMessages(s).at(-1)).toEqual({role:"user",content:"你好"});
    expect(s.messages.at(-1)?.content).toBe("");
    expect(applyChatEvent(s,{requestId:"ld-1",kind:"delta",text:"测试成功"})).toBe(false);
    applyChatEvent(s,{requestId:"ld-2",kind:"delta",text:"你好！"});
    applyChatEvent(s,{requestId:"ld-2",kind:"complete"});
    expect(s.messages.at(-1)?.content).toBe("你好！");
    const clean=freshSession();beginRequest(clean,"ld-3","17+26？");
    expect(requestMessages(clean)).toEqual([{role:"user",content:"17+26？"}]);
  });
  it("streams and completes without changing user text",()=>{const s=freshSession();beginRequest(s,"ld-1","你好");expect(isBusy(s)).toBe(true);applyChatEvent(s,{requestId:"ld-1",kind:"delta",text:"你"});applyChatEvent(s,{requestId:"ld-1",kind:"delta",text:"好"});expect(s.status).toBe("streaming");applyChatEvent(s,{requestId:"ld-1",kind:"complete"});expect(requestMessages(s)).toEqual([{role:"user",content:"你好"},{role:"assistant",content:"你好"}]);});
  it("retry preserves one user message and excludes incomplete reply",()=>{const s=freshSession();beginRequest(s,"ld-1","hi");applyChatEvent(s,{requestId:"ld-1",kind:"delta",text:"partial"});applyChatEvent(s,{requestId:"ld-1",kind:"failed",code:"timeout"});expect(s.status).toBe("failed");expect(requestMessages(s)).toEqual([{role:"user",content:"hi"}]);beginRequest(s,"ld-2");expect(s.messages.filter(m=>m.role==="user")).toHaveLength(1);expect(applyChatEvent(s,{requestId:"ld-1",kind:"complete"})).toBe(false);});
  it("cancelled request ignores late deltas",()=>{const s=freshSession();beginRequest(s,"ld-1","hi");applyChatEvent(s,{requestId:"ld-1",kind:"cancelled"});expect(s.status).toBe("stopped");expect(applyChatEvent(s,{requestId:"ld-1",kind:"delta",text:"late"})).toBe(false);expect(requestMessages(s)).toHaveLength(1);});
  it("separate model sessions never transfer context",()=>{const a=freshSession(),b=freshSession();beginRequest(a,"ld-1","private to A");applyChatEvent(a,{requestId:"ld-1",kind:"failed",code:"connection"});expect(b.messages).toEqual([]);expect(a.status).toBe("failed");});
  it("does not permit a concurrent request",()=>{const s=freshSession();beginRequest(s,"ld-1","hi");expect(()=>beginRequest(s,"ld-2","duplicate")).toThrow("busy");});
  it("chat bootstrap does not initialize pet or home",async()=>{const called:string[]=[];await routeWindowLabel("chat",{main:async()=>called.push("main"),home:async()=>called.push("home"),chat:async()=>called.push("chat")});expect(called).toEqual(["chat"]);});
});


describe("request lifecycle",()=>{
  it.each(["complete","failed","cancelled"] as const)("records %s at the terminal event and ignores late callbacks",kind=>{
    const clock=vi.spyOn(Date,"now");
    try {
      clock.mockReturnValue(1000);
      const s=freshSession();beginRequest(s,"turn-1","weather","requested-model");
      applyChatEvent(s,{requestId:"turn-1",kind:"delta",text:"partial evidence"});
      applyChatEvent(s,{requestId:"turn-1",kind:"returned_model",model:"returned-model"});
      applyChatEvent(s,{requestId:"turn-1",kind:"tool_start",tool:"get_weather"});
      applyChatEvent(s,{requestId:"turn-1",kind:"tool_result",tool:"get_weather",count:1});
      applyChatEvent(s,{requestId:"turn-1",kind:"budget",weatherCalls:1});
      clock.mockReturnValue(2500);
      expect(applyChatEvent(s,{requestId:"turn-1",kind,code:"timeout"})).toBe(true);
      expect(s.finishedAt).toBe(2500);
      expect(s.finishedAt-s.startedAt).toBe(1500);
      expect(isBusy(s)).toBe(false);
      expect(s.messages.at(-1)?.content).toBe("partial evidence");
      expect(s.messages.at(-1)?.complete).toBe(kind==="complete");
      expect(s.tools).toHaveLength(2);
      expect(s.budget?.weatherCalls).toBe(1);
      expect(s.requestedModel).toBe("requested-model");
      expect(s.returnedModel).toBe("returned-model");
      clock.mockReturnValue(3000);
      for(const late of ["complete","failed","cancelled","delta","tool_result","capability","returned_model","budget","stage"] as const)
        expect(applyChatEvent(s,{requestId:"turn-1",kind:late,text:"late",state:"passed",model:"late-model"})).toBe(false);
      expect(s.finishedAt).toBe(2500);
      expect(s.tools).toHaveLength(2);
      expect(s.returnedModel).toBe("returned-model");
    } finally {clock.mockRestore();}
  });
  it.each(["passed","failed"])("a previous %s capability does not verify the next request",state=>{
    const s=freshSession();beginRequest(s,"turn-1","first","model-a");
    applyChatEvent(s,{requestId:"turn-1",kind:"capability",state});
    applyChatEvent(s,{requestId:"turn-1",kind:"returned_model",model:"server-a"});
    applyChatEvent(s,{requestId:"turn-1",kind:"tool_result",tool:"search_web",count:1});
    applyChatEvent(s,{requestId:"turn-1",kind:"budget",searches:1});
    applyChatEvent(s,{requestId:"turn-1",kind:"failed",code:"connection"});
    beginRequest(s,"turn-2",undefined,"model-b");
    expect(s.capability).toBe("unverified");
    expect(s.returnedModel).toBe("");expect(s.requestedModel).toBe("model-b");
    expect(s.tools).toEqual([]);expect(s.budget).toBeNull();
    expect(s.error).toBe("");expect(s.stage).toBe("understanding");expect(s.finishedAt).toBe(0);
    expect(requestMessages(s)).toEqual([{role:"user",content:"first"}]);
    expect(applyChatEvent(s,{requestId:"turn-1",kind:"capability",state:"passed"})).toBe(false);
    expect(s.capability).toBe("unverified");
  });
  it("a normal second turn also starts with unverified capability",()=>{
    const s=freshSession();beginRequest(s,"turn-1","first");
    applyChatEvent(s,{requestId:"turn-1",kind:"capability",state:"passed"});
    applyChatEvent(s,{requestId:"turn-1",kind:"complete"});
    beginRequest(s,"turn-2","unrelated question");
    expect(s.capability).toBe("unverified");
  });
  it("weather stays available without a paid search key and off disables both tools",()=>{
    for(const mode of ["auto","required"]){
      expect(networkAvailability(mode,false)).toEqual({weather:true,search:false});
      expect(networkAvailability(mode,true)).toEqual({weather:true,search:true});
    }
    for(const hasKey of [true,false])expect(networkAvailability("off",hasKey)).toEqual({weather:false,search:false});
  });
});
