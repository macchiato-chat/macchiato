import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mirror } from "../src/cc/mirror";

let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const SID = "6966afc5-2dca-477d-a987-848421d25124";

function userLine(text: string): string {
  return (
    JSON.stringify({
      type: "user",
      uuid: uuid(),
      sessionId: SID,
      timestamp: "2026-07-05T10:00:00.000Z",
      message: { role: "user", content: text },
    }) + "\n"
  );
}

function assistantLine(text: string): string {
  return (
    JSON.stringify({
      type: "assistant",
      uuid: uuid(),
      sessionId: SID,
      timestamp: "2026-07-05T10:00:01.000Z",
      message: { id: `a-${n}`, role: "assistant", content: [{ type: "text", text }] },
    }) + "\n"
  );
}

/** #318 顯式指定 message.id 的 assistant 行(復現「同一條晚落盤殘片」用)。 */
function assistantLineWithId(text: string, msgId: string): string {
  return (
    JSON.stringify({
      type: "assistant",
      uuid: uuid(),
      sessionId: SID,
      timestamp: "2026-07-05T10:00:02.000Z",
      message: { id: msgId, role: "assistant", content: [{ type: "text", text }] },
    }) + "\n"
  );
}

interface Sent {
  frames: Record<string, unknown>[];
}

function fakeLinkb(): { linkb: any; sent: Sent } {
  const sent: Sent = { frames: [] };
  return {
    linkb: {
      agentLinkId: "AL1",
      isReady: true,
      send: (m: Record<string, unknown>) => sent.frames.push(m),
      onFrame: () => () => {},
    },
    sent,
  };
}

/** 只看鏡像內容幀(#56 起 poll 還會發 mirror_activity,別讓幀序斷言被打亂)。 */
const appends = (sent: Sent) => sent.frames.filter((f: any) => f.t === "mirror_append");

describe("Mirror", () => {
  let file: string;

  /** 每測一套隔離環境:projectsDir()=$CLAUDE_CONFIG_DIR/projects、獨立水位線 state。 */
  function setupEnv(): void {
    const cfg = mkdtempSync(join(tmpdir(), "cc-cfg-"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    process.env.MACCHIATO_CC_MIRROR = join(cfg, "mirror-state.json");
    mkdirSync(join(cfg, "projects", "-home-x"), { recursive: true });
    file = join(cfg, "projects", "-home-x", `${SID}.jsonl`);
    // #154 預置已 seeded 的狀態:本套件測的是「首掃之後」的常態語義(新會話 from-zero 全量);
    // 首掃基線本身見「#154 首掃基線」測試。
    writeFileSync(process.env.MACCHIATO_CC_MIRROR!, JSON.stringify({ offsets: {}, titles: {}, seeded: true }));
  }

  beforeEach(() => {
    n = 0;
  });

  it("seeded 後新發現的會話從 0 全量鏡像;之後增量(帶 srcId)", () => {
    setupEnv();
    writeFileSync(file, userLine("old history") + userLine("second"));
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll();
    // 全量:歷史消息都發出來(不再只發標題)
    const all = appends(sent).flatMap((f: any) => f.sessions[0].messages);
    expect(all.map((x: any) => x.text)).toEqual(["old history", "second"]);
    expect(all[0].srcId).toMatch(/^0{8}-/);
    expect((appends(sent)[0] as any).sessions[0].source).toBe("claude-code");
    // 增量:新消息
    appendFileSync(file, userLine("new message"));
    (m as any).doPoll();
    const last = (appends(sent).at(-1) as any).sessions[0];
    expect(last.messages.map((x: any) => x.text)).toEqual(["new message"]);
  });

  it("#347 身份映射不可信時未知 local UUID 不發明文且不推水位", () => {
    setupEnv();
    writeFileSync(file, userLine("绝不能明文发送"));
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb, undefined, () => undefined, () => false);
    (m as any).doPoll();
    expect(appends(sent)).toEqual([]);
    expect((m as any).state.offsets[SID]).toBe(0);
  });

  it("#318 markLivePosted 吞回合末晚落盤殘片:同 message.id 不重複投", () => {
    setupEnv();
    // 已存在會話(有真人消息+標題)——復現 bug:live 已投遞的最後一塊 text 晚落盤逃過 fastForward。
    writeFileSync(file, userLine("問題") + assistantLine("完整回答正文"));
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll(); // 首次全量鏡像
    const firstMsgId = `a-${n}`; // assistantLine 用的 message.id(此刻 n 指向那條 assistant)
    // 回合末:Drive 登記 live 已投遞這條 message.id
    m.markLivePosted(SID, [firstMsgId]);
    // 殘片:同一條 assistant(同 message.id)在 fastForward 後才落盤——用同 id 追加
    appendFileSync(file, assistantLineWithId("完整回答正文", firstMsgId));
    const before = appends(sent).length;
    (m as any).doPoll();
    // 應被吞掉:無新 mirror_append(或不含這條 text)
    const afterFrames = appends(sent).slice(before).flatMap((f: any) => f.sessions[0].messages);
    expect(afterFrames.map((x: any) => x.text)).not.toContain("完整回答正文");
    // 一次性:同 id 二次殘片已不在集合,但也不該再有內容(水位線已推過)
    (m as any).doPoll();
    expect(appends(sent).slice(before).flatMap((f: any) => f.sessions[0]?.messages ?? [])).toHaveLength(0);
  });

  it("#318 markLivePosted 不誤傷:不同 message.id 的終端側新消息照常鏡像", () => {
    setupEnv();
    writeFileSync(file, userLine("問題") + assistantLine("回答"));
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll();
    m.markLivePosted(SID, ["a-999"]); // 登記一個不相干的 id
    // 終端側真新消息(不同 id)→ 應照常鏡像
    appendFileSync(file, userLine("終端追問") + assistantLine("終端回答"));
    const before = appends(sent).length;
    (m as any).doPoll();
    const texts = appends(sent).slice(before).flatMap((f: any) => f.sessions[0].messages.map((x: any) => x.text));
    expect(texts).toContain("終端追問");
    expect(texts).toContain("終端回答");
  });

  it("#551 driven 回合末重讀整回合:主線 msgId 超過 64 組也全被吞(舊 64 上限會放行開頭幾組複讀)", () => {
    setupEnv();
    // 2026-07-29 生產實錄的最小復現:16 分鐘 7-subagent 長回合,#348 後 fastForward 不快進,
    // 回合末鏡像從回合開頭重讀;livePosted 罩不住全部主線 msgId 時,開頭幾組以新行落庫複讀。
    const WIRE = "01TESTWIREULID0000000000AA";
    let body = userLine("開場問題");
    const ids: string[] = [];
    for (let i = 1; i <= 70; i++) {
      ids.push(`msg_${i}`);
      body += assistantLineWithId(`第${i}組`, `msg_${i}`);
    }
    writeFileSync(file, body);
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb, undefined, (local) => (local === SID ? WIRE : undefined));
    m.markDrivenUuid(SID);
    m.setDriven(SID);
    (m as any).doPoll(); // 回合中:driven 讓路,不投
    expect(appends(sent)).toEqual([]);
    // 回合末(finishTurn 順序):登記 live 覆蓋的全部主線 msgId → 解除 driven → 鏡像重讀
    m.markLivePosted(SID, ids);
    m.unsetDriven(SID);
    (m as any).doPoll();
    const texts = appends(sent).flatMap((f: any) => f.sessions[0].messages.map((x: any) => x.text));
    expect(texts).toEqual(["開場問題"]); // user 行由 #393 srcId 撞索引去重;assistant 一組都不得重投
  });

  it("#551 dropLivePosted 非一次性:同 msgId 兩批重讀都被吞(批重試/字節摺分不放行第二次)", () => {
    setupEnv();
    const { linkb } = fakeLinkb();
    const m = new Mirror(linkb);
    m.markLivePosted(SID, ["msg_x"]);
    const batch = [{ role: "agent", text: "殘片", msgId: "msg_x" }];
    expect((m as any).dropLivePosted(SID, batch)).toEqual([]);
    expect((m as any).dropLivePosted(SID, batch)).toEqual([]); // 一次性 delete 的舊實現在這裡放行
  });

  it("#393 srcIdSnapshot 折出尾段消息帶 srcId(=行 uuid)+ msgId,與鏡像發的 srcId 收斂同鍵", () => {
    setupEnv();
    writeFileSync(file, userLine("問題") + assistantLineWithId("回答", "msg_abc"));
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    // 鏡像正常投遞,拿到它發給 server 的 srcId(= dedup_key)。
    (m as any).doPoll();
    const mirrored = appends(sent).flatMap((f: any) => f.sessions[0].messages);
    const mirrorUser = mirrored.find((x: any) => x.role === "user");
    const mirrorAgent = mirrored.find((x: any) => x.role === "agent");
    // 只讀快照:同一批消息、同一 srcId → live 回填鍵 == 鏡像鍵 → server (session,dedup_key) 唯一索引去重。
    const snap = m.srcIdSnapshot(SID);
    const snapUser = snap.find((x) => x.role === "user");
    const snapAgent = snap.find((x) => x.role === "agent");
    expect(snapUser?.srcId).toBe(mirrorUser.srcId);
    expect(snapAgent?.srcId).toBe(mirrorAgent.srcId);
    expect(snapAgent?.msgId).toBe("msg_abc"); // Drive 據 seenMsgIds(=API message.id)匹配本回合 agent 組
  });

  it("#655 單回合寫超 1MB:fromByte=回合起點把開場 user 行拉回窗內(固定尾窗會漏 → 雙投根因)", () => {
    setupEnv();
    // 2026-08-01 生產實測形態:開場 user 行在檔頭,其後 >1MB 的 sidechain 洪流(subagent 狂寫),
    // 尾部才是主鏈 assistant 收尾。sidechain 行 fold 會跳過,但佔字節——正是把 user 行擠出
    // 固定 1MB 尾窗的元兇。
    const opening = userLine("開場問題");
    const pad =
      JSON.stringify({
        type: "assistant",
        isSidechain: true,
        uuid: uuid(),
        sessionId: SID,
        message: { id: "sub", role: "assistant", content: [{ type: "text", text: "y".repeat(4096) }] },
      }) + "\n";
    const flood = pad.repeat(Math.ceil((1200 * 1024) / pad.length));
    writeFileSync(file, opening + flood + assistantLineWithId("尾部回答", "msg_tail"));
    const { linkb } = fakeLinkb();
    const m = new Mirror(linkb);
    // 舊語義(無 fromByte,固定尾窗):user 行在窗外 → srcId 回填必落空
    expect(m.srcIdSnapshot(SID).find((x) => x.role === "user")).toBeUndefined();
    // 新語義:fromByte=回合起點(新會話=0)→ user 行回到窗內;agent 尾組照常可取
    const snap = m.srcIdSnapshot(SID, undefined, 0);
    expect(snap.find((x) => x.role === "user")?.text).toBe("開場問題");
    expect(snap.find((x) => x.role === "agent")?.msgId).toBe("msg_tail");
  });

  it("#658 待配 user 文本扣留:池命中不發不推水位;回填完成(池排空)後放行整批", () => {
    setupEnv();
    writeFileSync(file, userLine("待配的那句"));
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    let pend = ["待配的那句"];
    m.pendingUserTexts = () => pend;
    (m as any).doPoll();
    expect(appends(sent)).toHaveLength(0); // 扣留:不發
    pend = []; // srcId 回填完成 → 池排空
    (m as any).doPoll();
    const texts = appends(sent).flatMap((f: any) => f.sessions[0].messages).map((x: any) => x.text);
    expect(texts).toEqual(["待配的那句"]); // 放行,水位此前未被推走
  });

  it("#658 扣留有界(5 輪):池項始終配不上 → 放行交 server 兜底,不永久卡鏡像", () => {
    setupEnv();
    writeFileSync(file, userLine("永遠配不上的句子"));
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    m.pendingUserTexts = () => ["永遠配不上的句子"];
    for (let i = 0; i < 5; i++) (m as any).doPoll();
    expect(appends(sent)).toHaveLength(0); // 前 5 輪扣留
    (m as any).doPoll();
    expect(appends(sent)).toHaveLength(1); // 第 6 輪強制放行
  });

  it("#655 回合小:fromByte 晚於 size−1MB 時仍維持 1MB 尾窗(上回合晚落盤行的重試配對語義不變)", () => {
    setupEnv();
    // 上回合的 user 行已在檔內;本回合起點=檔末。窗口下沿取 min(fromByte, size−1MB)=0 →
    // 上回合內容仍在窗內,池內舊項下回合收尾重試(#601)照舊能配上。
    writeFileSync(file, userLine("上回合的話") + assistantLineWithId("上回合回答", "msg_prev"));
    const from = statSync(file).size;
    const { linkb } = fakeLinkb();
    const m = new Mirror(linkb);
    const snap = m.srcIdSnapshot(SID, undefined, from);
    expect(snap.find((x) => x.role === "user")?.text).toBe("上回合的話");
    expect(snap.find((x) => x.role === "agent")?.msgId).toBe("msg_prev");
  });

  it("大會話分批發:每帧單會話 ≤ BATCH_MAX 條", () => {
    setupEnv();
    process.env.MACCHIATO_CC_BATCH_MAX = "10";
    let body = "";
    for (let i = 0; i < 25; i++) body += userLine(`m${i}`);
    writeFileSync(file, body);
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll();
    delete process.env.MACCHIATO_CC_BATCH_MAX;
    // 25 條 / 10 每批 → 3 帧,每帧單會話
    expect(appends(sent).length).toBe(3);
    for (const f of appends(sent)) expect((f as any).sessions).toHaveLength(1);
    const total = appends(sent).flatMap((f: any) => f.sessions[0].messages);
    expect(total).toHaveLength(25);
    expect(total.map((x: any) => x.text)).toEqual(Array.from({ length: 25 }, (_, i) => `m${i}`));
  });

  it("mirror_nack 回退水位線 → 重發同批", () => {
    setupEnv();
    writeFileSync(file, "");
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll(); // baseline(空文件無標題,無批)
    appendFileSync(file, userLine("msg1"));
    (m as any).doPoll();
    const batchId = (appends(sent).at(-1) as any).batchId;
    m.handleNack(batchId);
    (m as any).doPoll();
    const last = (appends(sent).at(-1) as any).sessions[0];
    expect(last.messages[0].text).toBe("msg1"); // 重發
  });

  it("#348 断线后 durable outbox 原 batchId 重放；ACK 前 offset/title 均不提交", () => {
    setupEnv();
    writeFileSync(file, userLine("durable"));
    const first = fakeLinkb();
    const m1 = new Mirror(first.linkb);
    (m1 as any).doPoll();
    const original = appends(first.sent)[0] as any;
    expect((m1 as any).state.offsets[SID]).toBe(0);
    expect((m1 as any).state.titles[SID]).toBeUndefined();

    const second = fakeLinkb();
    const m2 = new Mirror(second.linkb);
    (m2 as any).doPoll();
    const replay = appends(second.sent)[0] as any;
    expect(replay.batchId).toBe(original.batchId);
    expect(replay.sessions).toEqual(original.sessions);
    expect((m2 as any).state.offsets[SID]).toBe(0);
    m2.handleAck(replay.batchId);
    expect((m2 as any).state.offsets[SID]).toBeGreaterThan(0);
    expect((m2 as any).state.titles[SID]).toBe("durable");
  });

  it("#348 同会话乱序 ACK 不越过前序 NACK 的水位线", () => {
    setupEnv();
    process.env.MACCHIATO_CC_BATCH_MAX = "1";
    writeFileSync(file, userLine("first") + userLine("second"));
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll();
    delete process.env.MACCHIATO_CC_BATCH_MAX;

    const batches = appends(sent) as any[];
    expect(batches).toHaveLength(2);
    expect((m as any).state.offsets[SID]).toBe(0);

    m.handleAck(batches[1].batchId);
    expect((m as any).state.offsets[SID]).toBe(0);
    expect((m as any).state.pendingMirrors).toHaveLength(2);

    m.handleNack(batches[0].batchId);
    expect((m as any).state.offsets[SID]).toBe(0);

    m.handleAck(batches[0].batchId);
    expect((m as any).state.pendingMirrors).toHaveLength(0);
    expect((m as any).state.offsets[SID]).toBeGreaterThan(0);
    expect((m as any).state.titles[SID]).toBe("first");
  });

  it("#266 mirror_nack 也回退 titles:重發時「無真人消息不建會話」守衛照常生效", () => {
    setupEnv();
    writeFileSync(file, "");
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll();
    appendFileSync(file, userLine("問題")); // 首批含 user + 派生標題 → titles[sid] 被 set
    (m as any).doPoll();
    const sid = (appends(sent).at(-1) as any).sessions[0].hermesSessionId;
    expect((m as any).state.titles[sid]).toBeUndefined(); // ACK 前 title 仍只是候選
    expect((m as any).state.pendingMirrors.at(-1).title).toBeTruthy();
    const batchId = (appends(sent).at(-1) as any).batchId;
    m.handleNack(batchId);
    expect((m as any).state.titles[sid]).toBeUndefined(); // nack 保留 outbox，不提前提交 title
  });

  it("driven 會話只快進不投遞", () => {
    setupEnv();
    writeFileSync(file, "");
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll();
    m.setDriven(SID);
    appendFileSync(file, userLine("driven content"));
    (m as any).doPoll();
    // 無新批(僅 baseline 可能發過 0 條)
    const batches = appends(sent).filter((f: any) => f.sessions?.[0]?.messages?.length > 0);
    expect(batches).toHaveLength(0);
  });

  it("#200 driven 回合未 ACK 的 transcript/殘片都不生成影子會話", () => {
    setupEnv();
    writeFileSync(file, "");
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll(); // baseline 空文件
    // 驅動回合:live 路徑在 ULID 下投遞 user+assistant,鏡像側只快進
    m.setDriven(SID);
    appendFileSync(file, userLine("為什麼重啟") + assistantLine("因為觸發了硬體看門狗"));
    (m as any).doPoll(); // driven → 快進水位線,不投
    // 回合末:fastForward 越過本回合 + 解除 driven
    m.fastForward(SID);
    m.unsetDriven(SID);
    // 競態:最終 assistant 塊在 fastForward 之後才落盤(殘片,無 user 行)
    appendFileSync(file, assistantLine("(補齊的收尾)"));
    (m as any).doPoll();
    // 不得憑空建一個只有 agent 消息的影子會話
    const ghost = appends(sent).filter((f: any) => f.sessions?.[0]?.messages?.length > 0);
    expect(ghost).toHaveLength(0);
    // 即使随后出现 user，曾 driven 的 UUID 也不能另建影子；恢复由 wire 会话显式重发驱动。
    appendFileSync(file, userLine("那怎麼修"));
    (m as any).doPoll();
    const resumed = appends(sent).filter((f: any) =>
      f.sessions?.[0]?.messages?.some((x: any) => x.text === "那怎麼修"),
    );
    expect(resumed).toHaveLength(0);
  });

  it("#200 driven 回合標題/殘片/user 都不繞過影子會話守衛", () => {
    setupEnv();
    writeFileSync(file, "");
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll(); // baseline 空
    m.setDriven(SID);
    appendFileSync(file, userLine("為什麼重啟") + assistantLine("因為看門狗"));
    (m as any).doPoll(); // driven → 快進,不投
    m.fastForward(SID);
    m.unsetDriven(SID);
    // 回合末:CC 把生成的標題寫回 transcript(custom-title 行,零消息)——舊守衛(要 messages.length)
    // 會讓它繞過、走 newTitle 分支憑空建會話(2026-07-13 實測復發的洞)。
    appendFileSync(file, JSON.stringify({ type: "custom-title", customTitle: "P4改為拍手", sessionId: SID }) + "\n");
    (m as any).doPoll();
    expect(appends(sent)).toHaveLength(0); // 連 title-only 批都不能建會話
    // 再落一塊 assistant 殘片,同樣不建
    appendFileSync(file, assistantLine("(補齊收尾)"));
    (m as any).doPoll();
    expect(appends(sent)).toHaveLength(0);
    // 后续 user 也留在原 driven UUID，不创建独立明文会话。
    appendFileSync(file, userLine("那怎麼修"));
    (m as any).doPoll();
    expect(appends(sent)).toHaveLength(0);
  });

  it("第二道守衛:driven 過且無 wire 映射 → 即便有 user 續問也不單獨建鏡像會話;兜底計數恆 0", () => {
    setupEnv();
    writeFileSync(file, "");
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    m.markDrivenUuid(SID); // 標記:此 CLI uuid 被 Macchiato 驅動過
    (m as any).doPoll();
    // 終端裡真人續問(有 user)——無 wire 反向映射時仍永不單獨建(防影子)
    writeFileSync(file, userLine("終端續問") + assistantLine("回覆"));
    (m as any).doPoll();
    expect(appends(sent)).toHaveLength(0);
    expect(m.counters.mirrorGhostBlocked).toBe(0); // 主守衛悄悄攔在 emit 前,絆線不觸發
  });

  it("#395 有 wire 映射時,driven CLI 的終端續聊掛回原 wire 會話(不另建影子)", () => {
    setupEnv();
    writeFileSync(file, "");
    const wireSid = "01ULIDWIRESESSION0000000001";
    const { linkb, sent } = fakeLinkb();
    // 明文 ULID 映射——與 E2E 路徑同形,但 target 不加密
    const m = new Mirror(linkb, undefined, (local) => (local === SID ? wireSid : undefined));
    m.markDrivenUuid(SID);
    (m as any).doPoll(); // 空檔 baseline
    // 用戶在終端 `claude --resume <uuid>` 續問
    writeFileSync(file, userLine("終端續聊內容") + assistantLine("終端側回覆"));
    (m as any).doPoll();
    const batches = appends(sent);
    expect(batches.length).toBeGreaterThanOrEqual(1);
    const batch = batches[0] as any;
    expect(batch.sessions[0].hermesSessionId).toBe(wireSid); // 掛回原 Macchiato 會話
    expect(batch.sessions[0].hermesSessionId).not.toBe(SID); // 絕不另建 CLI-uuid 影子
    const texts = batch.sessions[0].messages.map((x: any) => x.text);
    expect(texts).toEqual(["終端續聊內容", "終端側回覆"]);
    expect(m.counters.mirrorGhostBlocked).toBe(0);
  });

  it("#395 在途 driven 仍讓路;解除後有映射的續聊才回流", () => {
    setupEnv();
    writeFileSync(file, "");
    const wireSid = "01ULIDWIRESESSION0000000002";
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb, undefined, (local) => (local === SID ? wireSid : undefined));
    (m as any).doPoll();
    m.setDriven(SID); // 回合在途
    appendFileSync(file, userLine("app 在途") + assistantLine("live 獨佔"));
    (m as any).doPoll();
    expect(appends(sent)).toHaveLength(0); // drivenSids 讓路,零投遞
    m.unsetDriven(SID);
    // 終端後續新回合
    appendFileSync(file, userLine("終端後續") + assistantLine("終端回"));
    (m as any).doPoll();
    const all = appends(sent).flatMap((f: any) => f.sessions[0].messages.map((x: any) => x.text));
    // 解除後整段 transcript 可掛回 wire(歷史 live 靠 server srcId 去重;此單測無 server)
    expect(all).toContain("終端後續");
    expect(all).toContain("終端回");
    expect(appends(sent).every((f: any) => f.sessions[0].hermesSessionId === wireSid)).toBe(true);
  });

  it("#395 MIRROR=off × 明文 wire 映射:不得當 E2E 定向投遞(守 #308)", () => {
    // 回歸:wireSessionIdFor 對明文 ULID 也回真後,isE2ESession 若只看 !!callback 會把明文
    // 誤當 E2E → off 下 unsetDriven 仍 watch + poll,終端續聊進 app。
    setupEnv();
    writeFileSync(file, userLine("app 回合") + assistantLine("live 正文"));
    const wireSid = "01ULIDPLAINTEXTOFF00000001"; // 明文 ULID,非 E2E
    process.env.MACCHIATO_MIRROR = "off";
    try {
      const { linkb, sent } = fakeLinkb();
      // 無 e2e store;callback 對明文有映射(與生產 index 接 wireSessionIdFor 同形)
      const m = new Mirror(linkb, undefined, (local) => (local === SID ? wireSid : undefined)) as any;
      m.markDrivenUuid(SID);
      m.setDriven(SID);
      expect(m.drivenE2EWatch.has(SID)).toBe(false); // 明文不得進 E2E watch
      vi.useFakeTimers();
      m.start();
      m.unsetDriven(SID);
      // 終端續聊落盤
      appendFileSync(file, userLine("終端 off 不該進") + assistantLine("也不該"));
      vi.advanceTimersByTime(30_000);
      vi.useRealTimers();
      expect(appends(sent)).toHaveLength(0); // 一幀不得進 app
      expect(m.drivenE2EWatch.has(SID)).toBe(false);
      expect(m.state.offsets[SID]).toBeUndefined();
    } finally {
      delete process.env.MACCHIATO_MIRROR;
      vi.useRealTimers();
    }
  });

  it("連接器啟動後新建的會話 → 從 0 全量鏡像(claude -p 短會話不丟)", async () => {
    setupEnv();
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll(); // 啟動時 projects 尚無此會話
    await new Promise((r) => setTimeout(r, 5)); // 確保 birthtime > startedAt
    writeFileSync(file, userLine("fresh q") + userLine("follow"));
    (m as any).doPoll();
    const batch = (appends(sent).at(-1) as any)?.sessions?.[0];
    expect(batch?.messages).toHaveLength(2); // 全文都在,沒被 baseline 吃掉
    expect(batch.messages[0].text).toBe("fresh q");
    expect(batch.title).toBe("fresh q"); // 無 custom-title 時用首條 user 當標題
  });

  it("內部 fork 檔(subagent/後台任務,無真人消息)→ 跳過;後來出現 user → 全量恢復鏡像", () => {
    setupEnv();
    // fork 檔:只有 assistant 消息(後台任務的 bash 調用),無任何 user 行
    const agentLine =
      JSON.stringify({
        type: "assistant",
        uuid: uuid(),
        sessionId: SID,
        timestamp: "2026-07-11T02:27:00.000Z",
        message: { id: "a1", role: "assistant", content: [{ type: "text", text: "task output" }] },
      }) + "\n";
    writeFileSync(file, agentLine);
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll();
    (m as any).doPoll(); // 第二輪:檔沒長,不重讀也不發
    expect(appends(sent).filter((f: any) => f.sessions?.[0]?.messages?.length > 0)).toHaveLength(0);
    // 用戶真在該會話說話 → 全量鏡像(含此前的 agent 消息)
    appendFileSync(file, userLine("real human"));
    (m as any).doPoll();
    const batch = (appends(sent).at(-1) as any)?.sessions?.[0];
    expect(batch?.messages?.map((x: any) => x.text)).toEqual(["task output", "real human"]);
  });

  it("#161 墓碑:app 刪過的會話,鏡像永不再撈(即使有新內容);transcript 不動", () => {
    setupEnv();
    writeFileSync(file, userLine("正常內容"));
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll();
    expect(appends(sent).length).toBeGreaterThan(0); // 先正常鏡像
    const before = appends(sent).length;
    m.tombstone(SID);
    appendFileSync(file, userLine("刪除後的新內容"));
    (m as any).doPoll();
    expect(appends(sent).length).toBe(before); // 墓碑後不再撈
    // 持久:新 Mirror 實例(同狀態文件)照樣跳過
    const { linkb: lb2, sent: s2 } = fakeLinkb();
    const m2 = new Mirror(lb2);
    (m2 as any).doPoll();
    expect(appends(s2)).toHaveLength(0);
  });

  it("標題變更(custom-title 流過)→ 補發純標題批", () => {
    setupEnv();
    writeFileSync(file, userLine("q"));
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll(); // baseline
    appendFileSync(file, JSON.stringify({ type: "custom-title", customTitle: "Renamed", sessionId: SID }) + "\n");
    (m as any).doPoll();
    const last = (appends(sent).at(-1) as any).sessions[0];
    expect(last.title).toBe("Renamed");
  });
});

// ---- #56 二期:鏡像側工作態(mirror_activity) ----

function inflightToolLine(): string {
  return (
    JSON.stringify({
      type: "assistant",
      uuid: uuid(),
      sessionId: SID,
      timestamp: new Date().toISOString(),
      message: {
        id: "m-inflight",
        role: "assistant",
        content: [{ type: "tool_use", id: "t-if", name: "Bash", input: { command: "sleep 999" } }],
        stop_reason: "tool_use",
      },
    }) + "\n"
  );
}

describe("E2E backfill 編不出合法幀時必須回終態(不能拋出後靜默掛死)", () => {
  it("單條超幀預算 → 發 found:false 而非 throw；lastError 留給 health", async () => {
    const cfg = mkdtempSync(join(tmpdir(), "cc-bf-"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    process.env.MACCHIATO_CC_MIRROR = join(cfg, "mirror-state.json");
    process.env.MACCHIATO_MIRROR_FRAME_BYTES = "4096"; // 縮小預算,單條就超
    mkdirSync(join(cfg, "projects", "-home-x"), { recursive: true });
    const f = join(cfg, "projects", "-home-x", `${SID}.jsonl`);
    writeFileSync(f, userLine("x".repeat(20_000)));
    writeFileSync(process.env.MACCHIATO_CC_MIRROR!, JSON.stringify({ offsets: {}, titles: {}, seeded: true }));
    // MAX_WIRE_BYTES 是模塊常量,改 env 後要重新導入模塊。
    vi.resetModules();
    const { Mirror: Fresh } = await import("../src/cc/mirror");
    try {
      const wireSid = "01K0CCBACKFILLBUDGET0000001";
      const { linkb, sent } = fakeLinkb();
      const e2e: any = {
        isE2E: () => true,
        encryptText: (_s: string, t: string) => t,
        encryptContent: (_s: string, c: any) => `E:${c.text}`,
        disableReceiptForBackfill: () => undefined,
      };
      const m: any = new Fresh(linkb, e2e);
      // 修前:這裡 throw,唯一調用點是 void ....catch(console.error) → 一幀不發、
      // server pendingOp 永遠掛著、barrier 永不解、該會話所有 prompt 靜默丟棄。
      await expect(m.backfillE2E(wireSid, SID, "enable")).resolves.toBeUndefined();
      const frames = sent.frames.filter((x: any) => x.t === "e2e_backfill");
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ hermesSessionId: wireSid, mode: "enable", found: false });
      expect(m.lastError).toContain("frame budget");
    } finally {
      delete process.env.MACCHIATO_MIRROR_FRAME_BYTES;
      vi.resetModules();
    }
  });
});

describe("durable outbox 的終態 NACK（凍結批不得永遠重發）", () => {
  function world(): { m: any; sent: Sent; file: string } {
    const cfg = mkdtempSync(join(tmpdir(), "cc-nack-"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    process.env.MACCHIATO_CC_MIRROR = join(cfg, "mirror-state.json");
    mkdirSync(join(cfg, "projects", "-home-x"), { recursive: true });
    const f = join(cfg, "projects", "-home-x", `${SID}.jsonl`);
    writeFileSync(process.env.MACCHIATO_CC_MIRROR!, JSON.stringify({ offsets: {}, titles: {}, seeded: true }));
    const { linkb, sent } = fakeLinkb();
    return { m: new Mirror(linkb) as any, sent, file: f };
  }

  it("e2e_direction:丟棄該會話全部凍結批、水位回退重讀——不再每 15s 重傳舊方向明文", () => {
    const { m, sent, file } = world();
    writeFileSync(file, userLine("開 E2E 前的明文") + assistantLine("明文回覆"));
    m.doPoll();
    const first = appends(sent)[0] as any;
    expect(first.sessions[0].messages[0].text).toBe("開 E2E 前的明文");
    expect(m.state.pendingMirrors).toHaveLength(1);

    // 會話事後轉 E2E → 凍結的明文批被 server 方向校驗永遠拒絕。
    m.handleNack(first.batchId, "e2e direction mismatch", "e2e_direction");
    expect(m.state.pendingMirrors).toHaveLength(0); // 丟批,不再重發舊方向明文
    expect(m.state.offsets[SID] ?? 0).toBe(0); // 水位停在最後一次 ACK → 下輪重讀重編
    expect(m.counters.mirrorDirectionRewinds).toBe(1);

    // 下輪 poll 按當前方向重新編碼同一段(這裡仍是明文,關鍵是「內容沒丟且批是新造的」)。
    const before = appends(sent).length;
    m.doPoll();
    const again = appends(sent).slice(before) as any[];
    expect(again).toHaveLength(1);
    expect(again[0].batchId).not.toBe(first.batchId);
    expect(again[0].sessions[0].messages.map((x: any) => x.text)).toEqual([
      "開 E2E 前的明文",
      "明文回覆",
    ]);
  });

  it("malformed:丟批並跳過該段,水位前進,lastError 留給 health", () => {
    const { m, sent, file } = world();
    writeFileSync(file, userLine("畸形批"));
    m.doPoll();
    const first = appends(sent)[0] as any;
    m.handleNack(first.batchId, "sessions too large", "malformed");
    expect(m.state.pendingMirrors).toHaveLength(0);
    expect(m.state.offsets[SID]).toBeGreaterThan(0); // 跳過,否則該會話永不再前進
    expect(m.counters.mirrorDropped).toBe(1);
    expect(m.lastError).toBe("sessions too large");
  });

  it("#348 lastError 不被下一輪 poll 抹掉:仍有卡住的待確認批就一直報錯", async () => {
    const { m, sent, file } = world();
    writeFileSync(file, userLine("等 ACK 的批"));
    await m.poll();
    const first = appends(sent)[0] as any;
    m.handleNack(first.batchId, "mirror transaction failed");
    expect(m.lastError).toBe("mirror transaction failed");
    // 修前:doPoll() 正常返回即無條件清空 lastError → health.ts(唯一用戶可見出口)什麼也不說,
    // #348 要求的「明確報錯」落成「靜默凍結」:水位不動、UI 無提示。
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60_000);
    await m.poll();
    vi.useRealTimers();
    expect(m.lastError).toBe("mirror transaction failed");
    // ACK 到了 → 恢復正常,錯誤才清。
    m.handleAck(first.batchId);
    await m.poll();
    expect(m.lastError).toBeNull();
  });

  it("狀態檔 0600(裡面裝完整正文,同倉 K_S 也是 0600);.bak 同權限", () => {
    const { m, file } = world();
    writeFileSync(file, userLine("完整正文會落進狀態檔"));
    m.doPoll();
    m.doPoll(); // 第二次寫觸發 .bak
    const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8);
    expect(mode(process.env.MACCHIATO_CC_MIRROR!)).toBe("600");
    if (existsSync(`${process.env.MACCHIATO_CC_MIRROR!}.bak`)) {
      expect(mode(`${process.env.MACCHIATO_CC_MIRROR!}.bak`)).toBe("600");
    }
  });

  it("無 code(舊 server)仍是保留重發語義", () => {
    const { m, sent, file } = world();
    writeFileSync(file, userLine("暫時失敗"));
    m.doPoll();
    const first = appends(sent)[0] as any;
    m.handleNack(first.batchId, "mirror transaction failed");
    expect(m.state.pendingMirrors).toHaveLength(1);
    expect(m.state.offsets[SID] ?? 0).toBe(0);
  });
});

describe("Mirror #56 mirror_activity", () => {
  let file = "";
  function setup(): { linkb: any; sent: Sent; m: Mirror } {
    const cfg = mkdtempSync(join(tmpdir(), "cc-act-"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    process.env.MACCHIATO_CC_MIRROR = join(cfg, "mirror-state.json");
    mkdirSync(join(cfg, "projects", "-home-x"), { recursive: true });
    file = join(cfg, "projects", "-home-x", `${SID}.jsonl`);
    // #154 預置 seeded:activity 測的是「已建會話」的工作態;首掃基線的會話 server 側不存在,
    // 對其不發 busy 是新語義下的正確行為(守衛本就攔「未建會話」)。
    writeFileSync(process.env.MACCHIATO_CC_MIRROR!, JSON.stringify({ offsets: {}, titles: {}, seeded: true }));
    writeFileSync(file, userLine("hi"));
    const { linkb, sent } = fakeLinkb();
    return { linkb, sent, m: new Mirror(linkb) };
  }
  const acts = (sent: Sent) =>
    sent.frames.filter((f: any) => f.t === "mirror_activity").flatMap((f: any) => f.sessions as any[]);

  it("增長 → busy;連續 2 輪安靜 → idle(防抖);首見不算增長", () => {
    const { sent, m } = setup();
    (m as any).doPoll(); // 首見:全量鏡像但 prevSize 未知 → 不亮
    expect(acts(sent)).toEqual([]);
    appendFileSync(file, userLine("user speaks"));
    (m as any).doPoll(); // 增長 → busy
    expect(acts(sent)).toEqual([{ hermesSessionId: SID, busy: true }]);
    for (const pending of [...((m as any).state.pendingMirrors ?? [])]) {
      m.handleAck(pending.batchId);
    }
    (m as any).doPoll(); // 安靜第 1 輪:防抖,不動
    expect(acts(sent)).toHaveLength(1);
    (m as any).doPoll(); // 安靜第 2 輪 → idle
    expect(acts(sent)).toEqual([
      { hermesSessionId: SID, busy: true },
      { hermesSessionId: SID, busy: false },
    ]);
  });

  it("尾部工具未結算(in-flight)且 90s 內有增長 → 每輪重申 busy", () => {
    const { sent, m } = setup();
    (m as any).doPoll();
    appendFileSync(file, inflightToolLine());
    (m as any).doPoll(); // 增長 → busy
    (m as any).doPoll(); // 無增長但 in-flight 且 90s 內 → 重申 busy
    expect(acts(sent)).toEqual([
      { hermesSessionId: SID, busy: true },
      { hermesSessionId: SID, busy: true },
    ]);
  });
});

describe("#6/#9 狀態文件兜底與裁剪", () => {
  it("#6 主文件損壞 → 從 .bak 恢復;#9 prune 消失超期才裁", () => {
    const d = mkdtempSync(join(tmpdir(), "cc-state-"));
    process.env.MACCHIATO_CC_MIRROR = join(d, "mirror.json");
    const linkb: any = { agentLinkId: "AL", isReady: true, send: () => {}, onFrame: () => () => {} };
    const m1: any = new Mirror(linkb);
    m1.state = { offsets: { a: 9 }, titles: { a: "t" }, missingAt: {} };
    m1.save();
    m1.state = { offsets: { a: 12 }, titles: { a: "t" }, missingAt: {} };
    m1.save(); // 上一版落 .bak
    writeFileSync(join(d, "mirror.json"), "{corrupted");
    const m2: any = new Mirror(linkb);
    expect(m2.state.offsets.a).toBe(9); // #6:.bak 恢復,不重置

    // #9:prune
    m2.state = {
      offsets: { live: 1, gone_old: 2, gone_new: 3 },
      titles: { live: "L", gone_old: "G" },
      missingAt: { gone_old: Date.now() - 8 * 24 * 3600 * 1000 },
    };
    m2.prune(new Set(["live"]), Date.now());
    expect(Object.keys(m2.state.offsets).sort()).toEqual(["gone_new", "live"]);
    expect(m2.state.titles.gone_old).toBeUndefined(); // titles 同步清
    m2.prune(new Set(["live", "gone_new"]), Date.now()); // 回歸即清 missingAt
    expect(m2.state.missingAt.gone_new).toBeUndefined();
  });
});

describe("#154 首掃基線(fresh install)", () => {
  it("無狀態文件的首掃:既有 transcript 基線到末、不自動灌;首掃後新增內容照常鏡像;新會話 from-zero", () => {
    const cfg = mkdtempSync(join(tmpdir(), "cc-cfg-"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    process.env.MACCHIATO_CC_MIRROR = join(cfg, "mirror-state.json");
    mkdirSync(join(cfg, "projects", "-home-x"), { recursive: true });
    const oldFile = join(cfg, "projects", "-home-x", `${SID}.jsonl`);
    writeFileSync(oldFile, userLine("多年舊歷史") + assistantLine("舊回覆"));
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll(); // 首掃
    expect(appends(sent)).toHaveLength(0); // 不請自來的歷史灌入沒有了(改走導入提示)
    // 首掃後該會話繼續長 → 增量照鏡(從基線起)
    appendFileSync(oldFile, userLine("新消息"));
    (m as any).doPoll();
    const inc = appends(sent).flatMap((f: any) => f.sessions[0].messages);
    expect(inc.map((x: any) => x.text)).toEqual(["新消息"]);
    // 首掃後新建的會話 → from-zero 全量(終端新會話實時可見不變)
    const sid2 = "7777afc5-2dca-477d-a987-848421d25124";
    writeFileSync(join(cfg, "projects", "-home-x", `${sid2}.jsonl`), userLine("新會話首條").replace(new RegExp(SID, "g"), sid2));
    (m as any).doPoll();
    const all2 = appends(sent).flatMap((f: any) => f.sessions).filter((x: any) => x.hermesSessionId === sid2);
    expect(all2[0]!.messages.map((x: any) => x.text)).toEqual(["新會話首條"]);
    // 重啟(新 Mirror 載同一狀態)→ seeded 持久,不會把舊歷史又基線一遍後漏鏡
    const m2 = new Mirror(linkb);
    expect(((m2 as any).state as any).seeded).toBe(true);
  });
});

describe("#308 MACCHIATO_MIRROR=off(鏡像開關)", () => {
  it("off:start 不輪詢(終端側不進 app);fastForward/tombstone 等 driven 衛生照常", () => {
    const cfg = mkdtempSync(join(tmpdir(), "cc-cfg-"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    process.env.MACCHIATO_CC_MIRROR = join(cfg, "mirror-state.json");
    mkdirSync(join(cfg, "projects", "-home-x"), { recursive: true });
    const f = join(cfg, "projects", "-home-x", `${SID}.jsonl`);
    writeFileSync(f, userLine("終端側活動"));
    writeFileSync(process.env.MACCHIATO_CC_MIRROR!, JSON.stringify({ offsets: {}, titles: {}, seeded: true }));
    process.env.MACCHIATO_MIRROR = "off";
    try {
      const { linkb, sent } = fakeLinkb();
      const m = new Mirror(linkb);
      expect(m.disabled).toBe(true);
      vi.useFakeTimers();
      m.start(); // 不該裝 interval、不該 poll
      vi.advanceTimersByTime(60_000);
      vi.useRealTimers();
      expect(appends(sent)).toHaveLength(0); // 終端側 transcript 一幀未發
      // #200：即使 mirror=off，fastForward 也不得把未 ACK 的副作用回合越過。
      m.fastForward(SID);
      expect(((m as any).state as any).offsets[SID]).toBeUndefined();
      m.tombstone(SID);
      expect(((m as any).state as any).tombstones).toContain(SID);
    } finally {
      delete process.env.MACCHIATO_MIRROR;
    }
  });

  it("off:unsetDriven 不得全量掃 transcript(終端會話照樣不進 app)", () => {
    const cfg = mkdtempSync(join(tmpdir(), "cc-cfg-"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    process.env.MACCHIATO_CC_MIRROR = join(cfg, "mirror-state.json");
    mkdirSync(join(cfg, "projects", "-home-x"), { recursive: true });
    const f = join(cfg, "projects", "-home-x", `${SID}.jsonl`);
    writeFileSync(f, userLine("純終端會話,用戶要求不進 app"));
    writeFileSync(process.env.MACCHIATO_CC_MIRROR!, JSON.stringify({ offsets: {}, titles: {}, seeded: true }));
    process.env.MACCHIATO_MIRROR = "off";
    try {
      const { linkb, sent } = fakeLinkb();
      const m = new Mirror(linkb) as any; // 非 E2E
      m.setDriven("some-other-sid");
      m.unsetDriven("some-other-sid"); // 修前:這裡無條件全量 poll → 終端會話被鏡像進 app
      expect(appends(sent)).toHaveLength(0);
      expect(m.state.offsets[SID]).toBeUndefined();
    } finally {
      delete process.env.MACCHIATO_MIRROR;
    }
  });

  it("off:E2E driven 回合仍可靠投遞——定向輪詢兜住晚落盤的尾巴", () => {
    const cfg = mkdtempSync(join(tmpdir(), "cc-cfg-"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    process.env.MACCHIATO_CC_MIRROR = join(cfg, "mirror-state.json");
    mkdirSync(join(cfg, "projects", "-home-x"), { recursive: true });
    const f = join(cfg, "projects", "-home-x", `${SID}.jsonl`);
    const other = join(cfg, "projects", "-home-x", `00000000-0000-4000-8000-0000000000ff.jsonl`);
    writeFileSync(other, userLine("終端會話,off 下絕不投"));
    writeFileSync(f, userLine("E2E driven 問題"));
    writeFileSync(process.env.MACCHIATO_CC_MIRROR!, JSON.stringify({ offsets: {}, titles: {}, seeded: false }));
    process.env.MACCHIATO_MIRROR = "off";
    try {
      const wireSid = "01K0CCMIRROROFFWIRE00000001";
      const { linkb, sent } = fakeLinkb();
      const e2e: any = {
        isE2E: (sid: string) => sid === wireSid,
        encryptText: (_sid: string, t: string) => `T:${t}`,
        encryptContent: (_sid: string, c: any) => `E:${c.text}`,
      };
      const m = new Mirror(linkb, e2e, (localSid: string) =>
        localSid === SID ? wireSid : undefined,
      ) as any;
      m.setDriven(SID);
      vi.useFakeTimers();
      m.start(); // off:只裝定向輪詢
      m.unsetDriven(SID);
      m.handleAck((appends(sent).at(-1) as any).batchId);
      // 回合末尾巴晚落盤:第一次定向 poll 之後才寫進 transcript。
      appendFileSync(f, assistantLine("晚落盤的最後一塊"));
      vi.advanceTimersByTime(30_000);
      vi.useRealTimers();

      const byBatch = new Map<string, any>();
      for (const frame of appends(sent) as any[]) byBatch.set(frame.batchId, frame);
      const msgs = [...byBatch.values()].flatMap((x: any) => x.sessions[0].messages);
      expect(msgs.map((x: any) => x.enc)).toEqual(["E:E2E driven 問題", "E:晚落盤的最後一塊"]);
      expect(appends(sent).every((x: any) => x.sessions[0].hermesSessionId === wireSid)).toBe(true);
      // 終端會話一幀未發、水位未動;seeded 也不得被定向輪詢置真。
      expect(m.state.offsets["00000000-0000-4000-8000-0000000000ff"]).toBeUndefined();
      expect(m.state.seeded).not.toBe(true);
    } finally {
      delete process.env.MACCHIATO_MIRROR;
    }
  });

  it("#350 E2E 回合末尾巴在亞秒內追平,不必等滿一個 5s 輪詢周期", () => {
    // 取消 fire-and-forget 直發後,E2E 回覆只剩 transcript 一條路;而 SDK result 常早於 CLI
    // 寫完尾巴 → unsetDriven 那次即時 poll 讀不到最後一塊,舊行為要等下一個 POLL_MS(5s)tick,
    // 用戶側就是「回覆延遲 0–5s、且常被拆成兩段」。回合末的短間隔定向 poll 把它壓到亞秒級。
    const cfg = mkdtempSync(join(tmpdir(), "cc-cfg-"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    process.env.MACCHIATO_CC_MIRROR = join(cfg, "mirror-state.json");
    mkdirSync(join(cfg, "projects", "-home-x"), { recursive: true });
    const f = join(cfg, "projects", "-home-x", `${SID}.jsonl`);
    writeFileSync(f, userLine("E2E 問題"));
    writeFileSync(
      process.env.MACCHIATO_CC_MIRROR!,
      JSON.stringify({ offsets: {}, titles: {}, seeded: true }),
    );
    const wireSid = "01K0CCTAILPOLLWIRE000000001";
    const { linkb, sent } = fakeLinkb();
    const e2e: any = {
      isE2E: (sid: string) => sid === wireSid,
      encryptText: (_sid: string, t: string) => `T:${t}`,
      encryptContent: (_sid: string, c: any) => `E:${c.text}`,
    };
    const m = new Mirror(linkb, e2e, (localSid: string) =>
      localSid === SID ? wireSid : undefined,
    ) as any;
    m.setDriven(SID);
    vi.useFakeTimers();
    try {
      m.start();
      m.unsetDriven(SID); // 即時 poll:此刻尾巴還沒落盤
      m.handleAck((appends(sent).at(-1) as any).batchId);
      appendFileSync(f, assistantLine("回合末晚落盤的回覆"));
      // 只推進 1s——遠不到一個 POLL_MS(5s)。修前這裡一幀都不會有。
      vi.advanceTimersByTime(1_000);
      const tail = appends(sent).at(-1) as any;
      expect(tail.sessions[0].messages.map((x: any) => x.enc)).toEqual([
        "E:回合末晚落盤的回覆",
      ]);
      expect(tail.sessions[0].hermesSessionId).toBe(wireSid);
      // 排程有界:停掉鏡像後不再有殘留定時器繼續打。
      m.stop();
      const before = appends(sent).length;
      vi.advanceTimersByTime(60_000);
      expect(appends(sent)).toHaveLength(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("默認(env 未設)不停用;off/0/false/no 均停用", () => {
    const cfg = mkdtempSync(join(tmpdir(), "cc-cfg-"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    process.env.MACCHIATO_CC_MIRROR = join(cfg, "mirror-state.json");
    try {
      delete process.env.MACCHIATO_MIRROR;
      expect(new Mirror(fakeLinkb().linkb).disabled).toBe(false);
      for (const v of ["off", "OFF", "0", "false", "no"]) {
        process.env.MACCHIATO_MIRROR = v;
        expect(new Mirror(fakeLinkb().linkb).disabled).toBe(true);
      }
      process.env.MACCHIATO_MIRROR = "on";
      expect(new Mirror(fakeLinkb().linkb).disabled).toBe(false);
    } finally {
      delete process.env.MACCHIATO_MIRROR;
    }
  });
});


describe("#489 F-12 salvageCrash 崩潰補撈", () => {
  it("只補 agent、掛 wire sid、進 durable outbox；無 agent 則 false", () => {
    const cfg = mkdtempSync(join(tmpdir(), "cc-f12-"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    process.env.MACCHIATO_CC_MIRROR = join(cfg, "mirror-state.json");
    mkdirSync(join(cfg, "projects", "-home-x"), { recursive: true });
    const file = join(cfg, "projects", "-home-x", `${SID}.jsonl`);
    writeFileSync(
      process.env.MACCHIATO_CC_MIRROR!,
      JSON.stringify({ offsets: { [SID]: 0 }, titles: { [SID]: "t" }, seeded: true }),
    );
    // user + agent 已落盤
    writeFileSync(file, userLine("please do x") + assistantLine("done with x"));
    const { linkb, sent } = fakeLinkb();
    const wireSid = "01WIREULIDF12SALVAGE0000001";
    const m = new Mirror(linkb, undefined, () => wireSid);
    const ok = m.salvageCrash(SID, wireSid);
    expect(ok).toBe(true);
    const apps = appends(sent);
    expect(apps).toHaveLength(1);
    const sess = (apps[0] as any).sessions[0];
    expect(sess.hermesSessionId).toBe(wireSid);
    expect(sess.messages).toHaveLength(1);
    expect(sess.messages[0].role).toBe("agent");
    expect(sess.messages[0].text).toBe("done with x");
    expect(sess.messages[0].srcId).toBeTruthy();
    // durable pending
    expect((m as any).state.pendingMirrors).toHaveLength(1);
  });

  it("無 agent 內容 → false（回退請重發）", () => {
    const cfg = mkdtempSync(join(tmpdir(), "cc-f12b-"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    process.env.MACCHIATO_CC_MIRROR = join(cfg, "mirror-state.json");
    mkdirSync(join(cfg, "projects", "-home-x"), { recursive: true });
    const file = join(cfg, "projects", "-home-x", `${SID}.jsonl`);
    writeFileSync(
      process.env.MACCHIATO_CC_MIRROR!,
      JSON.stringify({ offsets: { [SID]: 0 }, titles: { [SID]: "t" }, seeded: true }),
    );
    writeFileSync(file, userLine("only user so far"));
    const { linkb } = fakeLinkb();
    const m = new Mirror(linkb);
    expect(m.salvageCrash(SID)).toBe(false);
  });

  it("已有 pending 批 → false 不另開 salvage", () => {
    const cfg = mkdtempSync(join(tmpdir(), "cc-f12c-"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    process.env.MACCHIATO_CC_MIRROR = join(cfg, "mirror-state.json");
    mkdirSync(join(cfg, "projects", "-home-x"), { recursive: true });
    const file = join(cfg, "projects", "-home-x", `${SID}.jsonl`);
    writeFileSync(
      process.env.MACCHIATO_CC_MIRROR!,
      JSON.stringify({
        offsets: { [SID]: 0 },
        titles: { [SID]: "t" },
        seeded: true,
        pendingMirrors: [{ batchId: "b1", frame: {}, sid: SID, endOffset: 10 }],
      }),
    );
    writeFileSync(file, userLine("u") + assistantLine("a"));
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    expect(m.salvageCrash(SID)).toBe(false);
    expect(appends(sent)).toHaveLength(0);
  });
});
