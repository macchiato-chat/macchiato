import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** #145 中斷語義單測:mock spawn,可控 close(code)。 */
const procs: FakeProc[] = [];
class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: string[] = [];
  kill(sig?: string) {
    this.killed.push(sig ?? "SIGTERM");
    return true;
  }
}
const spawnArgs: string[][] = [];
vi.mock("node:child_process", () => ({
  spawn: (_bin: string, args: string[]) => {
    spawnArgs.push(args);
    const p = new FakeProc();
    procs.push(p);
    return p;
  },
}));

// #146:攔 materializeAttachment(免起網絡),其餘原樣。
let mockMaterialize: (ref: unknown) => Promise<string> = async () => {
  throw new Error("not stubbed");
};
vi.mock("../src/codex/attachments", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/codex/attachments")>();
  return { ...orig, materializeAttachment: (ref: unknown) => mockMaterialize(ref) };
});

import { Drive } from "../src/codex/drive";
import {
  e2eControlKeyId,
  e2eControlMac,
  E2EControlVerifier,
  type E2EControlEnvelopeV1,
  type E2EControlKind,
} from "../src/e2e/control";

const CONTROL_KEY = Buffer.from([...Array(32).keys()]);

function signedControl(
  wireSid: string,
  kind: E2EControlKind,
  payload: Record<string, unknown>,
  seq = "1",
): E2EControlEnvelopeV1 {
  const now = Date.now();
  const fields = {
    v: 1 as const,
    sessionId: `public:${wireSid}`,
    hermesSessionId: wireSid,
    deviceId: "codex-exec-drive-test",
    keyId: e2eControlKeyId(CONTROL_KEY),
    msgId: `00000000-0000-4000-8000-${seq.padStart(12, "0")}`,
    seq,
    issuedAtMs: String(now),
    expiresAtMs: String(now + 300_000),
    kind,
  };
  const raw = Buffer.from(JSON.stringify(payload), "utf8");
  return { ...fields, payloadB64: raw.toString("base64"), mac: e2eControlMac(CONTROL_KEY, fields, raw) };
}

function makeDrive(e2e?: any, e2eControl?: E2EControlVerifier, mirror?: any) {
  process.env.MACCHIATO_CODEX_SESSIONS = join(
    mkdtempSync(join(tmpdir(), "cx-dr-")),
    "sessions.json",
  );
  process.env.MACCHIATO_CODEX_TITLE_MODE = "off";
  const sent: any[] = [];
  const linkb: any = {
    agentLinkId: "al1",
    isReady: true,
    handlers: [] as any[],
    onFrame(h: any) {
      this.handlers.push(h);
    },
    send(m: any) {
      sent.push(m);
    },
    async deliver(m: any) {
      for (const h of this.handlers) await h(m);
    },
  };
  const d = new Drive(linkb, mirror, e2e, undefined, e2eControl);
  d.wire();
  return { d, linkb, sent };
}

const tui = (method: string, sessionId: string, params: any = {}) => ({
  t: "tui",
  sessionId,
  frame: { method, params: { session_id: sessionId, ...params } },
});
const completes = (sent: any[]) =>
  sent.filter((f) => f.frame?.params?.type === "message.complete").map((f) => f.frame.params.payload);

const SID = "01CXTESTSID000000000000000";

beforeEach(() => {
  procs.length = 0;
  spawnArgs.length = 0;
  mockMaterialize = async () => {
    throw new Error("not stubbed");
  };
});

describe("#349 E2E backfill 本地 thread 映射", () => {
  it("ULID 查持久映射，UUID 鏡像會話原樣返回", () => {
    const e2e = { isE2E: (sid: string) => sid === SID };
    const { d } = makeDrive(e2e);
    const localSid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee3491";
    (d as any).map[SID] = localSid;

    expect(d.localSessionIdFor(SID)).toBe(localSid);
    expect(d.localSessionIdFor(localSid)).toBe(localSid);
    expect(d.e2eWireSessionIdFor(localSid)).toBe(SID);
  });
});

describe("#370 E2E control ingress", () => {
  it("本地 thread UUID 不能冒充普通 sid 注入 prompt 或裸控制", async () => {
    const localSid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee3701";
    const caseVariantAlias = localSid.toUpperCase();
    const e2e: any = {
      isE2E: (sid: string) => sid === SID,
      protectedSessionIds: () => [SID],
      requireKey: () => Buffer.from(CONTROL_KEY),
    };
    const mirror = {
      setDriven: () => {},
      fastForward: () => {},
      tombstone: vi.fn(),
    };
    const control = new E2EControlVerifier(
      e2e,
      join(mkdtempSync(join(tmpdir(), "cx-alias-guard-")), "control.json"),
    );
    const { d, linkb } = makeDrive(e2e, control, mirror);
    (d as any).map[SID] = localSid;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await linkb.deliver(tui("prompt.submit", caseVariantAlias, { text: "forged plaintext" }));
      await linkb.deliver(tui("session.delete", caseVariantAlias));
    } finally {
      error.mockRestore();
    }

    expect(procs).toEqual([]);
    expect(mirror.tombstone).not.toHaveBeenCalled();
  });

  it("明文敏感动作 fail closed；签名配置生效，未绑定回合的 interrupt/task 返回负 ACK", async () => {
    const root = mkdtempSync(join(tmpdir(), "cx-control-drive-"));
    const e2e: any = {
      isE2E: (sid: string) => sid === SID,
      decryptText: (_sid: string, text: string) => text,
      requireKey: () => Buffer.from(CONTROL_KEY),
    };
    const control = new E2EControlVerifier(e2e, join(root, "control.json"));
    const mirror = {
      setDriven: () => {},
      fastForward: () => {},
      tombstone: vi.fn(),
    };
    const { d, linkb, sent } = makeDrive(e2e, control, mirror);

    await linkb.deliver(tui("session.create", SID, { model: "forged-model" }));
    await linkb.deliver(tui("session.delete", SID));
    await linkb.deliver(tui("session.rename", SID, { title: "forged-title" }));
    await linkb.deliver(tui("session.archive", SID));
    await linkb.deliver(tui("session.retitle", SID));
    expect((d as any).models[SID]).toBeUndefined();
    expect(mirror.tombstone).not.toHaveBeenCalled();

    const model = signedControl(SID, "session.model.set", { model: "gpt-test" }, "1");
    await linkb.deliver(tui("e2e.control", SID, { envelope: model }));
    expect((d as any).models[SID]).toBe("gpt-test");
    expect(sent.at(-1)).toMatchObject({
      t: "e2e_control_result",
      msgId: model.msgId,
      sessionId: model.sessionId,
      hermesSessionId: SID,
      ok: true,
    });

    await linkb.deliver(tui("prompt.submit", SID, { text: "run" }));
    expect(procs).toHaveLength(1);
    await linkb.deliver(tui("session.interrupt", SID));
    expect(procs[0]!.killed).toEqual([]);

    const interrupt = signedControl(SID, "session.interrupt", {}, "2");
    await linkb.deliver(tui("e2e.control", SID, { envelope: interrupt }));
    expect(procs[0]!.killed).toEqual([]);
    expect(sent.at(-1)).toMatchObject({
      msgId: interrupt.msgId,
      ok: false,
      error: "control_rejected",
    });

    await linkb.deliver(tui("e2e.control", SID, { envelope: interrupt }));
    expect(sent.at(-1)).toMatchObject({
      msgId: interrupt.msgId,
      ok: false,
      error: "control_rejected",
    });

    const stop = signedControl(SID, "task.stop", { taskId: "task-1" }, "3");
    await linkb.deliver(tui("e2e.control", SID, { envelope: stop }));
    expect(sent.at(-1)).toMatchObject({
      msgId: stop.msgId,
      ok: false,
      error: "control_rejected",
    });

    const canary = "CANARY-DECRYPTED-ARG-/Users/private/repo";
    procs[0]!.kill = () => {
      throw new Error(canary);
    };
    const failedInterrupt = signedControl(SID, "session.interrupt", {}, "4");
    await linkb.deliver(tui("e2e.control", SID, { envelope: failedInterrupt }));
    expect(sent.at(-1)).toMatchObject({
      msgId: failedInterrupt.msgId,
      ok: false,
      error: "control_rejected",
    });
    expect(JSON.stringify(sent.at(-1))).not.toContain(canary);
  });

  it("仅签封 session.e2e.disable 可持久化 intent 并提交 disable backfill", async () => {
    const root = mkdtempSync(join(tmpdir(), "cx-control-disable-"));
    const e2e = {
      isE2E: (sid: string) => sid === SID,
      requireKey: () => Buffer.from(CONTROL_KEY),
      markServerE2E: vi.fn(),
      beginDisable: vi.fn(),
    } as any;
    const mirror = {
      backfillE2E: vi.fn(async () => {}),
      setDriven: () => {},
      fastForward: () => {},
      tombstone: () => {},
    };
    const { d, linkb, sent } = makeDrive(
      e2e,
      new E2EControlVerifier(e2e, join(root, "control.json")),
      mirror,
    );

    await linkb.deliver(tui("session.e2e.disable", SID));
    expect(e2e.beginDisable).not.toHaveBeenCalled();
    expect(mirror.backfillE2E).not.toHaveBeenCalled();

    const disable = signedControl(SID, "session.e2e.disable", {}, "1");
    await linkb.deliver(tui("e2e.control", SID, { envelope: disable }));
    expect(e2e.markServerE2E).toHaveBeenCalledWith(SID, "disable");
    expect(e2e.beginDisable).toHaveBeenCalledWith(SID, expect.objectContaining({
      kind: "session.e2e.disable",
      hermesSessionId: SID,
    }));
    expect(mirror.backfillE2E).toHaveBeenCalledWith(SID, undefined, "disable");
    expect(sent.at(-1)).toMatchObject({ msgId: disable.msgId, ok: true });
  });

  it("签封 config 持久化失败会回滚内存并 NACK", async () => {
    const root = mkdtempSync(join(tmpdir(), "cx-control-config-fail-"));
    const e2e = {
      isE2E: (sid: string) => sid === SID,
      requireKey: () => Buffer.from(CONTROL_KEY),
    } as any;
    const { d, linkb, sent } = makeDrive(
      e2e,
      new E2EControlVerifier(e2e, join(root, "control.json")),
    );
    (d as any).models[SID] = "before";
    (d as any).saveMap = () => false;
    const model = signedControl(SID, "session.model.set", { model: "after" }, "1");
    await linkb.deliver(tui("e2e.control", SID, { envelope: model }));
    expect((d as any).models[SID]).toBe("before");
    expect(sent.at(-1)).toMatchObject({
      msgId: model.msgId,
      ok: false,
      error: "side_effect_failed",
    });
  });
});

describe("#145 中斷語義", () => {
  it("session.interrupt → kill + 清空排隊;close(null) 定性 interrupted(不冒充 complete)", async () => {
    const { linkb, sent } = makeDrive();
    await linkb.deliver(tui("prompt.submit", SID, { text: "q1" }));
    expect(procs).toHaveLength(1);
    await linkb.deliver(tui("prompt.submit", SID, { text: "q2(排隊)" })); // 回合中 → 進隊
    await linkb.deliver(tui("session.interrupt", SID));
    expect(procs[0]!.killed).toEqual(["SIGTERM"]);
    procs[0]!.emit("close", null); // SIGTERM → code null
    await new Promise((r) => setTimeout(r, 10));
    const cs = completes(sent);
    expect(cs).toHaveLength(1);
    expect(cs[0].status).toBe("interrupted"); // 修復前是 "complete"
    expect(procs).toHaveLength(1); // 隊列已清:不再自動起 q2 的新回合(修復前會)
  });

  it("外部信號殺(無顯式中斷,close null)→ 同樣 interrupted;正常 close(0) → complete", async () => {
    const { linkb, sent } = makeDrive();
    await linkb.deliver(tui("prompt.submit", SID, { text: "q" }));
    procs[0]!.emit("close", null); // 例如 earlyoom kill
    await new Promise((r) => setTimeout(r, 10));
    expect(completes(sent)[0].status).toBe("interrupted");
    // 新回合正常結束
    await linkb.deliver(tui("prompt.submit", SID, { text: "q2" }));
    procs[1]!.stdout.emit("data", Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "答" } }) + "\n"));
    procs[1]!.emit("close", 0);
    await new Promise((r) => setTimeout(r, 10));
    expect(completes(sent)[1].status).toBe("complete");
  });
});

describe("#146 入站附件(落盤 + 路徑注入)", () => {
  it("圖片/檔案附件 → materialize 落盤,路徑注進 prompt;audio → stt_unavailable 回執", async () => {
    mockMaterialize = async (ref: any) => `/tmp/att/${ref.name}`;
    const { linkb, sent } = makeDrive();
    await linkb.deliver(
      tui("prompt.submit", SID, {
        text: "看看這張圖",
        attachments: [
          { id: "a1", kind: "image", name: "shot.png", mime: "image/png", url: "https://x/a1" },
          { id: "a2", kind: "audio", name: "v.m4a", mime: "audio/mp4", url: "https://x/a2" },
        ],
      }),
    );
    expect(spawnArgs).toHaveLength(1);
    const prompt = spawnArgs[0]![spawnArgs[0]!.length - 1]!;
    expect(prompt).toContain("看看這張圖");
    expect(prompt).toContain("/tmp/att/shot.png"); // 路徑注入,codex 用讀檔工具訪問
    const vt = sent.find((f: any) => f.t === "voice_transcript");
    expect(vt?.error).toBe("stt_unavailable"); // audio 走雲端 STT 回退鏈
  });

  it("下載失敗 → review.summary 警示(不再靜默丟);純附件無文字也能起回合", async () => {
    let n = 0;
    mockMaterialize = async (ref: any) => {
      n++;
      if (n === 1) throw new Error("HTTP 403");
      return `/tmp/att/${ref.name}`;
    };
    const { linkb, sent } = makeDrive();
    await linkb.deliver(
      tui("prompt.submit", SID, {
        text: "",
        attachments: [
          { id: "b1", kind: "document", name: "bad.pdf", mime: "application/pdf", url: "https://x/b1" },
          { id: "b2", kind: "document", name: "ok.pdf", mime: "application/pdf", url: "https://x/b2" },
        ],
      }),
    );
    const warn = sent.find((f: any) => JSON.stringify(f).includes("下載失敗"));
    expect(warn).toBeTruthy();
    expect(spawnArgs).toHaveLength(1); // 成功的那個仍起回合
    expect(spawnArgs[0]![spawnArgs[0]!.length - 1]).toContain("/tmp/att/ok.pdf");
  });
});

describe("#153 工具保真 + reasoning 透出", () => {
  const feed = (p: FakeProc, ev: any) => p.stdout.emit("data", Buffer.from(JSON.stringify(ev) + "\n"));
  const events = (sent: any[]) => sent.filter((f) => f.frame?.params?.type).map((f) => f.frame.params);

  it("command_execution → args.command + aggregated_output;exit≠0 標 error;reasoning 完成項 → reasoning.delta", async () => {
    const { linkb, sent } = makeDrive();
    await linkb.deliver(tui("prompt.submit", SID, { text: "跑個命令" }));
    const p = procs[0]!;
    feed(p, { type: "item.completed", item: { id: "r1", type: "reasoning", text: "先想想" } });
    feed(p, { type: "item.started", item: { id: "c1", type: "command_execution", command: "/bin/bash -lc 'ls'", status: "in_progress" } });
    feed(p, { type: "item.completed", item: { id: "c1", type: "command_execution", command: "/bin/bash -lc 'ls'", aggregated_output: "file1\n", exit_code: 1, status: "completed" } });
    feed(p, { type: "item.completed", item: { id: "m1", type: "agent_message", text: "跑完了" } });
    p.emit("close", 0);
    await new Promise((r) => setTimeout(r, 10));
    const evs = events(sent);
    const reasoning = evs.find((e) => e.type === "reasoning.delta");
    expect(reasoning?.payload.text).toBe("先想想");
    const tc = evs.find((e) => e.type === "tool.complete");
    expect(tc?.payload.name).toBe("command");
    expect(tc?.payload.args).toEqual({ command: "/bin/bash -lc 'ls'" }); // 修復前恆 {}
    expect(tc?.payload.result_text).toBe("file1\n");
    expect(tc?.payload.error).toBe("exit 1");
  });

  it("file_change / 未知類型:args 帶實料不再為空", async () => {
    const { toolCardFor } = await import("../src/codex/drive");
    const fc = toolCardFor({ id: "f1", type: "file_change", changes: [{ path: "a.ts", kind: "edit" }], status: "completed" });
    expect(fc.args).toEqual({ changes: [{ path: "a.ts", kind: "edit" }] });
    const unk = toolCardFor({ id: "x", type: "future_thing", detail: "y".repeat(600) });
    expect(unk.name).toBe("future_thing");
    expect(String(unk.args.detail)).toHaveLength(501); // 截斷 500+省略號
  });
});

describe("#156 覆蓋缺口:排隊續投 + E2E send", () => {
  it("回合中追加 prompt → 排隊;回合結束自動續投(新 proc,帶排隊文本)", async () => {
    const { linkb } = makeDrive();
    await linkb.deliver(tui("prompt.submit", SID, { text: "第一條" }));
    expect(procs).toHaveLength(1);
    await linkb.deliver(tui("prompt.submit", SID, { text: "第二條(排隊)" }));
    expect(procs).toHaveLength(1); // 回合中:不起新 proc
    procs[0]!.stdout.emit("data", Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "答一" } }) + "\n"));
    procs[0]!.emit("close", 0);
    await new Promise((r) => setTimeout(r, 10));
    expect(procs).toHaveLength(2); // 續投起新 proc
    expect(spawnArgs[1]![spawnArgs[1]!.length - 1]).toBe("第二條(排隊)");
  });

  it("E2E 會話:回合結束把 user+reply 加密成 mirror_append(不走明文 tui)", async () => {
    const { linkb, sent } = makeDrive();
    // 最小可逆「加密」樁:isE2E=true、encrypt/decrypt 直傳
    const d2sent: any[] = [];
    const e2e: any = {
      isE2E: () => true,
      decryptText: (_s: string, t: string) => t,
      encryptContent: (_s: string, o: any) => "enc:" + JSON.stringify(o),
    };
    const { Drive } = await import("../src/codex/drive");
    process.env.MACCHIATO_CODEX_SESSIONS = join(mkdtempSync(join(tmpdir(), "cx-e2e-")), "s.json");
    const lb: any = { agentLinkId: "al", isReady: true, handlers: [], onFrame(h: any) { this.handlers.push(h); }, send: (m: any) => d2sent.push(m), async deliver(m: any) { for (const h of this.handlers) await h(m); } };
    const d = new Drive(lb, undefined, e2e);
    d.wire();
    await lb.deliver(tui("prompt.submit", SID, { text: "秘密問題" }));
    const p = procs[procs.length - 1]!;
    p.stdout.emit("data", Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "秘密回答" } }) + "\n"));
    p.emit("close", 0);
    await new Promise((r) => setTimeout(r, 10));
    // 明文 tui 事件不許有
    expect(d2sent.filter((f) => f.t === "tui" && JSON.stringify(f).includes("秘密"))).toHaveLength(0);
    const mf = d2sent.find((f) => f.t === "mirror_append");
    expect(mf.sessions[0].e2e).toBe(true);
    const roles = mf.sessions[0].messages.map((m: any) => m.role);
    expect(roles).toEqual(["user", "agent"]);
    expect(mf.sessions[0].messages[1].enc).toContain("秘密回答");
  });
});

describe("#230 codex 權限 → sandbox", () => {
  const sandboxOf = (args: string[]) => args[args.indexOf("-s") + 1];

  it("session.create.permissionMode 三檔映射到 exec -s(plan→read-only)", async () => {
    const { linkb } = makeDrive();
    await linkb.deliver(tui("session.create", SID, { permissionMode: "plan" }));
    await linkb.deliver(tui("prompt.submit", SID, { text: "hi" }));
    expect(sandboxOf(spawnArgs[0]!)).toBe("read-only");
  });

  it("bypass → danger-full-access(本地開放後)", async () => {
    process.env.MACCHIATO_CODEX_ALLOW_BYPASS = "1"; // #255 顯式開放
    const { linkb } = makeDrive();
    await linkb.deliver(tui("session.create", SID, { permissionMode: "bypass" }));
    await linkb.deliver(tui("prompt.submit", SID, { text: "hi" }));
    expect(sandboxOf(spawnArgs[0]!)).toBe("danger-full-access");
    delete process.env.MACCHIATO_CODEX_ALLOW_BYPASS;
  });

  it("#255 bypass 未本地開放 → 降級 workspace-write(不盲執行)", async () => {
    delete process.env.MACCHIATO_CODEX_ALLOW_BYPASS;
    delete process.env.MACCHIATO_CODEX_SANDBOX;
    const { linkb } = makeDrive();
    await linkb.deliver(tui("session.create", SID, { permissionMode: "bypass" }));
    await linkb.deliver(tui("prompt.submit", SID, { text: "hi" }));
    expect(sandboxOf(spawnArgs[0]!)).toBe("workspace-write"); // 降級,非 danger-full-access
  });

  it("未設 permissionMode(或非三檔值)→ 回退進程級默認 workspace-write", async () => {
    delete process.env.MACCHIATO_CODEX_SANDBOX; // 排除環境干擾
    const { linkb } = makeDrive();
    await linkb.deliver(tui("session.create", SID, { permissionMode: "ask" })); // 非 codex 三檔 → 回退
    await linkb.deliver(tui("prompt.submit", SID, { text: "hi" }));
    expect(sandboxOf(spawnArgs[0]!)).toBe("workspace-write");
  });

  it("清空 permissionMode(空串)→ 回退默認", async () => {
    delete process.env.MACCHIATO_CODEX_SANDBOX;
    const { linkb } = makeDrive();
    await linkb.deliver(tui("session.create", SID, { permissionMode: "bypass" }));
    await linkb.deliver(tui("session.create", SID, { permissionMode: "" })); // 清空
    await linkb.deliver(tui("prompt.submit", SID, { text: "hi" }));
    expect(sandboxOf(spawnArgs[0]!)).toBe("workspace-write");
  });
});
