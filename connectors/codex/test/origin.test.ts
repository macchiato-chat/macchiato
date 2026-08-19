/**
 * #946 會話身份 = 源系統聲明的歸屬。
 *
 * 夾具全部取自本機 1399 個真實 rollout 的 `session_meta` 形態（只脫敏了 cwd/instructions）：
 *   - 用戶根線程：`session_id === id`（本機 124 條新格式 + 106 條只有 thread_source 的）
 *   - 子 agent：`thread_source: "subagent"` + `source.subagent.thread_spawn`，`session_id ≠ id`
 *     （296 條同時帶 parent_thread_id + forked_from_id，就是「同一段歷史被複製 N 份」那批）
 *   - guardian 審批評估：`source.subagent.other = "guardian"`（老一點的版本沒有 session_id）
 *   - 老格式：`session_meta` 只有 cwd/timestamp，什麼都沒聲明（496 條）——**行為必須不變**
 */
import { describe, expect, it } from "vitest";
import { parseOrigin, resolveConversationId, toWireKind, toWireOrigin, type ThreadOrigin } from "../src/codex/origin";

const ROOT = "019efa54-f264-7120-a1b2-0a78c24d4af9";
const CHILD = "019f497d-6f8e-7e72-85b1-961382e83d7f";

const line = (payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: "2026-07-10T00:46:25.191Z", type: "session_meta", payload });
const user = (message: string) =>
  JSON.stringify({ type: "event_msg", payload: { type: "user_message", message } });

/** 真形態：VS Code 開的普通用戶線程（新版 Codex）。 */
const userMeta = {
  session_id: ROOT,
  id: ROOT,
  cwd: "/w",
  originator: "codex_vscode",
  cli_version: "0.142.0",
  source: "vscode",
  thread_source: "user",
  model_provider: "openai",
};

/** 真形態：`thread_spawn` 出來的子 agent（session_id 指回父，forked/parent 都在）。 */
const subagentMeta = {
  session_id: ROOT,
  id: CHILD,
  forked_from_id: ROOT,
  parent_thread_id: ROOT,
  cwd: "/w",
  originator: "codex_vscode",
  source: {
    subagent: {
      thread_spawn: { parent_thread_id: ROOT, depth: 1, agent_path: "/root/backend_security", agent_nickname: "Mill" },
    },
  },
  thread_source: "subagent",
  agent_nickname: "Mill",
  agent_path: "/root/backend_security",
  multi_agent_version: "v2",
};

/** 真形態：guardian 審批評估線程（老版本，連 session_id 都沒有）。 */
const guardianMeta = {
  id: "019e1000-9cb2-7b00-9bdd-220c227b04c1",
  cwd: "/w",
  originator: "codex_vscode",
  cli_version: "0.130.0-alpha.5",
  source: { subagent: { other: "guardian" } },
  thread_source: "subagent",
};

describe("#946 parseOrigin：源聲明優先", () => {
  it("用戶根線程：conversationId = 自己，身份與今天逐字節相同", () => {
    const o = parseOrigin(line(userMeta) + "\n" + user("幫我改 bug"), ROOT);
    expect(o).toMatchObject({ threadId: ROOT, conversationId: ROOT, kind: "user", evidence: "declared" });
  });

  it("子 agent：歸屬到 session_id 指的父線程，帶 label，kind=subagent", () => {
    const o = parseOrigin(line(subagentMeta), CHILD);
    expect(o.threadId).toBe(CHILD);
    expect(o.conversationId).toBe(ROOT); // ← 判據鏈第一站
    expect(o.kind).toBe("subagent");
    expect(o.parentThreadId).toBe(ROOT);
    expect(o.label).toBe("Mill");
    expect(o.evidence).toBe("declared");
  });

  it("guardian：無 session_id 也認得出是派生，只是定不出父（隔離而非歸位）", () => {
    const o = parseOrigin(line(guardianMeta), guardianMeta.id);
    expect(o.kind).toBe("subagent");
    expect(o.conversationId).toBe(guardianMeta.id);
    expect(o.evidence).toBe("declared");
    expect(o.reason).toBe("thread_source=subagent");
  });

  it("判據鏈：只有 parent_thread_id / 只有 forked_from_id 的老格式也定得出父", () => {
    expect(parseOrigin(line({ id: CHILD, cwd: "/w", parent_thread_id: ROOT }), CHILD)).toMatchObject({
      conversationId: ROOT,
      kind: "fork",
      reason: "parent_thread_id",
    });
    expect(
      parseOrigin(line({ id: CHILD, cwd: "/w", thread_source: "user", forked_from_id: ROOT }), CHILD),
    ).toMatchObject({ conversationId: ROOT, kind: "fork", reason: "forked_from_id" });
  });

  it("session_meta.id 缺失 → 回落文件名（最後一站）", () => {
    expect(parseOrigin(line({ cwd: "/w" }), "file-uuid")).toMatchObject({
      threadId: "file-uuid",
      conversationId: "file-uuid",
      kind: "user",
      evidence: "absent",
    });
  });

  it("老格式（什麼都沒聲明）→ evidence=absent、當用戶會話：不倒退、不誤傷", () => {
    const o = parseOrigin(line({ id: ROOT, cwd: "/old", timestamp: "t" }) + "\n" + user("hi"), ROOT);
    expect(o).toMatchObject({ kind: "user", conversationId: ROOT, evidence: "absent" });
  });

  it("正文啟發式降級成兜底：只在聲明缺席時生效，且標 inferred", () => {
    const guardianText = "The following is the Codex agent history whose request action you are assessing.";
    // 老格式沒聲明 → 只能靠正文猜（#918 的行為原樣保留）
    expect(parseOrigin(line({ cwd: "/old" }) + "\n" + user(guardianText))).toMatchObject({
      kind: "internal",
      evidence: "inferred",
      reason: "codex-internal-history",
    });
    // 源系統聲明了 thread_source=user → 不再猜（用戶轉貼這段文本不該被吞掉整條會話）
    expect(parseOrigin(line(userMeta) + "\n" + user(guardianText), ROOT)).toMatchObject({
      kind: "user",
      evidence: "declared",
    });
    // 只有 thread_source（本機 106 條這種）也算聲明——它就是一句「我是用戶線程」
    expect(
      parseOrigin(line({ id: ROOT, cwd: "/w", thread_source: "user" }) + "\n" + user(guardianText), ROOT),
    ).toMatchObject({ kind: "user", evidence: "declared" });
  });
});

describe("#946 resolveConversationId：鏈式 fork 解到根", () => {
  const origin = (threadId: string, conversationId: string): ThreadOrigin => ({
    threadId,
    conversationId,
    kind: conversationId === threadId ? "user" : "fork",
    evidence: "declared",
  });

  it("C→B→A：解到 A（只認直接父會歸到一個 app 裡從不存在的中間線程）", () => {
    const table = new Map([["B", origin("B", "A")], ["A", origin("A", "A")]]);
    expect(resolveConversationId(origin("C", "B"), (id) => table.get(id))).toBe("A");
  });

  it("父 rollout 已被壓縮/刪除 → 就地停在直接父", () => {
    expect(resolveConversationId(origin("C", "B"), () => undefined)).toBe("B");
  });

  it("成環也不轉圈", () => {
    const table = new Map([["B", origin("B", "C")], ["C", origin("C", "B")]]);
    expect(resolveConversationId(origin("A", "B"), (id) => table.get(id))).toBeTruthy();
  });
});

describe("#985 toWireOrigin：獨立 session 據實報 kind，併進父的批次仍是 root", () => {
  const declared = (partial: Partial<ThreadOrigin> & Pick<ThreadOrigin, "threadId" | "kind">): ThreadOrigin => ({
    conversationId: partial.conversationId ?? partial.threadId,
    evidence: partial.evidence ?? "declared",
    ...partial,
  });

  it("詞彙對照：user→root、fork→continuation、subagent/internal→derived", () => {
    expect(toWireKind("user")).toBe("root");
    expect(toWireKind("fork")).toBe("continuation");
    expect(toWireKind("subagent")).toBe("derived");
    expect(toWireKind("internal")).toBe("derived");
  });

  it("獨立根線程 → root，threadId ≡ wireSid", () => {
    expect(toWireOrigin(declared({ threadId: ROOT, kind: "user" }), ROOT)).toEqual({
      threadId: ROOT,
      conversationId: ROOT,
      kind: "root",
      evidence: "declared",
    });
  });

  it("獨立 fork（以自己的 id 上報）→ continuation，帶父", () => {
    const o = declared({
      threadId: CHILD,
      conversationId: ROOT,
      kind: "fork",
      parentThreadId: ROOT,
    });
    expect(toWireOrigin(o, CHILD)).toEqual({
      threadId: CHILD,
      conversationId: ROOT,
      kind: "continuation",
      parentThreadId: ROOT,
      evidence: "declared",
    });
  });

  it("獨立子 agent（以自己的 id 上報）→ derived，帶 label", () => {
    const o = declared({
      threadId: CHILD,
      conversationId: ROOT,
      kind: "subagent",
      parentThreadId: ROOT,
      label: "Mill",
    });
    expect(toWireOrigin(o, CHILD)).toEqual({
      threadId: CHILD,
      conversationId: ROOT,
      kind: "derived",
      parentThreadId: ROOT,
      label: "Mill",
      evidence: "declared",
    });
  });

  it("已經併進父會話（wireSid ≠ threadId）→ 只能報父的 root（協議 threadId ≡ hermesSessionId）", () => {
    const o = declared({
      threadId: CHILD,
      conversationId: ROOT,
      kind: "fork",
      parentThreadId: ROOT,
    });
    expect(toWireOrigin(o, ROOT)).toEqual({
      threadId: ROOT,
      conversationId: ROOT,
      kind: "root",
      evidence: "declared",
    });
  });

  it("evidence=absent → 整個字段不上線", () => {
    expect(toWireOrigin(declared({ threadId: ROOT, kind: "user", evidence: "absent" }), ROOT)).toBeUndefined();
  });
});
