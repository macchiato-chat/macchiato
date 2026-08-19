/**
 * #951 血緣契約夾具（codex）：讓**上游改 transcript 格式**在 CI 裡變紅，而不是在用戶的
 * 會話列表裡變紅。
 *
 * 為什麼要有這一份（#926 的結論）：身份鏈（#946）、單一入口、fail-closed 都只保證「按**當前
 * 已知格式**判得對」，一個都防不住「Codex 下個版本換字段」。歷史上這類漂移全是靠用戶投訴發現
 * 的——#789、2026-07-11、#918，以及這次 #926（用戶截圖裡一堆同名會話）。回歸夾具是唯一能在
 * 上游動手的當天就把它攔下來的東西。
 *
 * 兩層，缺一不可：
 *
 *  1. **靜態語料**（`test/fixtures/lineage/`，隨倉庫走、CI 每次 push 跑）
 *     16 份脫敏 rollout，形態逐條取自本機 1399 個真實 rollout 的 `session_meta` 盤點
 *     （見 `manifest.json` 每條的 `shape`：哪個形態、本機多少條）。**正文、路徑、git 信息全部
 *     重寫，只留結構**。它防的是**我們自己**改壞判據（改一行 `origin.ts` 就有一類線程翻車），
 *     以及老格式行為被無聲改掉。
 *
 *  2. **本機真語料探針**（`describe.runIf`，只有裝了 Codex 的機器 / 狗糧機跑，CI 自動跳過）
 *     對真 `~/.codex/sessions` 算四個聚合指標並卡閾值。它防的是**上游改格式**：靜態語料是
 *     死的，上游改字段名它一輩子綠；只有真語料的 `evidence=absent` 比例會當場飆起來。
 *
 * 四類斷言（issue #951，四家連接器同一套口徑）：
 *   ① 每條派生線程都解析得出 `declared` 的 kind 與歸屬
 *   ② 每條續接線程都接回正確的父
 *   ③ 根線程 **0 誤傷**
 *   ④ `evidence: "absent"` 的比例不超過閾值（超了＝上游不再寫聲明、我們已退回猜）
 *
 * 實測基線（2026-08-14，本機 1399 個真實 rollout）：`session_id ≠ id` ⟺ 派生 **515/515 零例外**；
 * 574 派生 / 825 根；最近 45 天的 618 個 rollout **聲明率 100%**。
 *
 * hermes / openclaw 兩家的同款語料**留到 #948 / #949 落地之後補**（它們的實現正在改，這一刀
 * 刻意不碰）：位置分別是 `services/hermes-connector/test/fixtures/lineage/`（`state.db` 行）與
 * `services/openclaw-connector/test/fixtures/lineage/`（gateway `sessions_list` 快照）。
 */
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Mirror, threadIdFromFile } from "../src/codex/mirror";
import { parseOrigin, type OriginEvidence, type OriginKind } from "../src/codex/origin";
import { resetSessionIndexCache } from "../src/codex/session-index";

const CORPUS = fileURLToPath(new URL("./fixtures/lineage/", import.meta.url));

interface FixtureCase {
  file: string;
  era: "current" | "legacy";
  role: "root" | "derived" | "continuation";
  shape: string;
  expect: {
    threadId: string;
    conversationId: string;
    kind: OriginKind;
    parentThreadId?: string;
    label?: string;
    evidence: OriginEvidence;
    reason?: string;
  };
}

const manifest = JSON.parse(readFileSync(join(CORPUS, "manifest.json"), "utf8")) as {
  thresholds: { maxAbsentRatioOverall: number; maxAbsentRatioCurrentEra: number };
  cases: FixtureCase[];
};
const cases = manifest.cases;
const originOf = (c: FixtureCase) =>
  parseOrigin(readFileSync(join(CORPUS, c.file), "utf8"), threadIdFromFile(c.file) ?? "");

describe("#951 codex 血緣契約：靜態語料", () => {
  it("語料完整性：目錄裡每個 rollout 都在 manifest 裡有期望（丟進新樣本卻不寫期望＝紅）", () => {
    const onDisk = readdirSync(CORPUS).filter((f) => f.endsWith(".jsonl")).sort();
    expect(onDisk).toEqual(cases.map((c) => c.file).sort());
    expect(onDisk.length).toBeGreaterThanOrEqual(12);
    // 三類線程都要有樣本——只剩一類時「全綠」是假的。
    for (const role of ["root", "derived", "continuation"] as const) {
      expect(cases.filter((c) => c.role === role).length, role).toBeGreaterThan(0);
    }
  });

  it("① 派生線程：100% 解析出 declared 的 kind 與歸屬", () => {
    const derived = cases.filter((c) => c.role === "derived");
    for (const c of derived) {
      const o = originOf(c);
      expect(["subagent", "internal"], c.file).toContain(o.kind);
      // 老格式（era=legacy）只能靠正文猜，那是**兜底**、允許 inferred；新格式一律必須 declared。
      if (c.era === "current") expect(o.evidence, c.file).toBe("declared");
      expect(o.conversationId, c.file).toBe(c.expect.conversationId);
    }
    // 新格式的派生線程一條都不許掉到「猜」上。
    const currentDerived = derived.filter((c) => c.era === "current");
    expect(currentDerived.every((c) => originOf(c).evidence === "declared")).toBe(true);
  });

  it("② 續接線程：100% 接回正確的父（歸屬 ≠ 自己）", () => {
    for (const c of cases.filter((c) => c.role === "continuation")) {
      const o = originOf(c);
      expect(o.conversationId, c.file).toBe(c.expect.conversationId);
      expect(o.conversationId, c.file).not.toBe(o.threadId);
      expect(o.kind, c.file).toBe("fork"); // 續接不是要丟的內部線程——丟＝那條會話靜默停更
      expect(o.evidence, c.file).toBe("declared");
    }
  });

  it("③ 根線程：0 誤傷（一條都不許被判成派生）", () => {
    for (const c of cases.filter((c) => c.role === "root")) {
      const o = originOf(c);
      expect(o.kind, c.file).toBe("user");
      expect(o.conversationId, c.file).toBe(o.threadId);
    }
  });

  it("④ evidence=absent 的比例不超過閾值（超了＝上游不再寫聲明、我們已退回猜）", () => {
    const evidence = cases.map((c) => ({ c, e: originOf(c).evidence }));
    const absent = evidence.filter((x) => x.e === "absent");
    expect(absent.length / cases.length).toBeLessThanOrEqual(manifest.thresholds.maxAbsentRatioOverall);
    // 新格式樣本裡出現 absent = 判據鏈斷了（某個字段不再被讀到）。
    const currentAbsent = absent.filter((x) => x.c.era === "current").map((x) => x.c.file);
    expect(currentAbsent.length / cases.length).toBeLessThanOrEqual(
      manifest.thresholds.maxAbsentRatioCurrentEra,
    );
    expect(currentAbsent).toEqual([]);
  });

  it("逐條期望：kind / conversationId / parentThreadId / label / evidence / reason 全對得上", () => {
    for (const c of cases) expect(originOf(c), `${c.file} — ${c.shape}`).toMatchObject(c.expect);
  });
});

// ── 鏡像層：同一份語料喂給真 Mirror，看真的會建出幾條會話 ─────────────────────
describe("#951 codex 血緣契約：整套語料喂給鏡像", () => {
  let root: string;
  const saved: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string) => {
    saved[k] = process.env[k];
    process.env[k] = v;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cx-951-"));
    setEnv("MACCHIATO_CODEX_SESSIONS_DIR", join(root, "sessions"));
    setEnv("MACCHIATO_CODEX_MIRROR", join(root, "mirror.json"));
    setEnv("MACCHIATO_CODEX_SESSION_INDEX", join(root, "session_index.jsonl"));
    const dir = join(root, "sessions", "2026", "08", "14");
    mkdirSync(dir, { recursive: true });
    for (const c of cases) copyFileSync(join(CORPUS, c.file), join(dir, c.file));
    // `seeded: true` = 首掃已經走完（不然存量會被基線到檔末，什麼都不投）。
    writeFileSync(join(root, "mirror.json"), JSON.stringify({ offsets: {}, ords: {}, seeded: true }));
    resetSessionIndexCache();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetSessionIndexCache();
  });

  const newMirror = (sent: Record<string, unknown>[]): any =>
    new Mirror({ agentLinkId: "al", isReady: true, send: (f: Record<string, unknown>) => sent.push(f) } as any);

  const sessionIdsOf = (sent: Record<string, unknown>[]): string[] =>
    sent
      .filter((f: any) => f.t === "mirror_append")
      .flatMap((f: any) => f.sessions.map((s: any) => s.hermesSessionId as string));

  /**
   * durable outbox（#348）一輪只在途一批、要等 `mirror_ack` 才推水位——所以「掃完整套語料」
   * ＝ poll → ack → 再 poll，直到不再有新批。真 server 就是這麼喂的。
   */
  const drainPolls = (mirror: any, sent: Record<string, unknown>[], maxRounds = 64): void => {
    for (let i = 0; i < maxRounds; i++) {
      const before = sent.length;
      mirror.pollOnce();
      const fresh = sent.slice(before).filter((f: any) => f.t === "mirror_append") as any[];
      if (!fresh.length) return;
      for (const f of fresh) mirror.handleAck(f.batchId);
    }
    throw new Error("鏡像批次沒有收斂（超過 maxRounds）");
  };

  it("①③ 只有根線程建會話：派生 0 條、續接 0 條新會話，根線程一條不少", () => {
    const sent: Record<string, unknown>[] = [];
    const mirror = newMirror(sent);
    drainPolls(mirror, sent);

    const roots = cases.filter((c) => c.role === "root").map((c) => c.expect.threadId);
    expect(new Set(sessionIdsOf(sent))).toEqual(new Set(roots));
    // 派生線程整檔跳過（歸屬已知也不重灌歷史），續接線程首見坐到分叉點。
    expect(mirror.counters.mirrorInternalSkipped).toBe(cases.filter((c) => c.role === "derived").length);
    expect(mirror.counters.mirrorForkAdopted).toBe(cases.filter((c) => c.role === "continuation").length);
  });

  it("② 續接之後在終端繼續聊：新消息投進**父會話**，不另建一條", () => {
    const sent: Record<string, unknown>[] = [];
    const mirror = newMirror(sent);
    drainPolls(mirror, sent); // 首見：對齊公共前綴、水位坐到分叉點
    const before = new Set(sessionIdsOf(sent));

    const dir = join(root, "sessions", "2026", "08", "14");
    const continuations = cases.filter((c) => c.role === "continuation");
    for (const c of continuations) {
      const f = join(dir, c.file);
      writeFileSync(
        f,
        readFileSync(f, "utf8")
          + JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: `續接後的新問題 ${c.expect.threadId}` } })
          + "\n",
      );
    }
    const cur = sent.length;
    drainPolls(mirror, sent);

    const appended = sent.slice(cur).filter((f: any) => f.t === "mirror_append") as any[];
    for (const c of continuations) {
      const entry = appended.find((f) =>
        f.sessions.some((s: any) =>
          s.messages.some((m: any) => m.text === `續接後的新問題 ${c.expect.threadId}`)));
      expect(entry, `${c.file} 的新消息沒到達 server`).toBeTruthy();
      const sess = entry.sessions.find((s: any) =>
        s.messages.some((m: any) => m.text === `續接後的新問題 ${c.expect.threadId}`));
      expect(sess.hermesSessionId, c.file).toBe(c.expect.conversationId); // ← 歸位到父，不另建
    }
    // 沒有任何新會話身份冒出來（續接檔自己的 threadId 一個都不許出現）。
    for (const sid of sessionIdsOf(sent.slice(cur))) {
      expect(before.has(sid) || cases.some((c) => c.expect.conversationId === sid), sid).toBe(true);
      expect(continuations.some((c) => c.expect.threadId === sid), sid).toBe(false);
    }
  });
});

/**
 * ── 真語料漂移探針（**顯式 opt-in**，默認不跑）─────────────────────────────────
 *
 * 打開方式（狗糧機 / 夜跑機 / 想手動查一次的人）：
 *   `MACCHIATO_LINEAGE_LIVE_CODEX=~/.codex/sessions pnpm --filter macchiato-codex-connector test`
 *
 * 為什麼不自動探測 `~/.codex`：#303 的 hermetic setup 把 `HOME` 整個重定向進沙箱，正是為了
 * 「單測絕不碰開發者本機數據」。**靠 `existsSync(homedir()+"/.codex")` 判斷的閘門在沙箱下
 * 永遠為假、永遠靜默跳過**——看起來有閘、實際永不響，比沒有更糟。所以這裡只認一個顯式路徑，
 * 由跑的人自己交出來。
 *
 * 探針只讀每個 rollout 的**頭部結構字段**，正文一個字都不進斷言、不進日誌。
 */
const LIVE_ROOT = process.env.MACCHIATO_LINEAGE_LIVE_CODEX?.replace(/^~(?=\/)/, homedir()) ?? "";
const liveEnabled = !!LIVE_ROOT && existsSync(LIVE_ROOT);

/** 真 rollout 可以有幾十 MB：只讀頭部 64KB（`session_meta` 恆在第一行）。 */
function readHead(file: string, bytes = 64 * 1024): string | undefined {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return undefined;
  }
  try {
    const buf = Buffer.allocUnsafe(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, Math.max(n, 0)).toString("utf8");
  } catch {
    return undefined;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

/** 頭部裡的 `session_meta` payload（只取結構字段——正文一個字都不進斷言/日誌）。 */
function sessionMeta(head: string): Record<string, unknown> | undefined {
  for (const line of head.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let o: { type?: string; payload?: Record<string, unknown> };
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    if (o.type === "session_meta") return (o.payload ?? (o as Record<string, unknown>));
  }
  return undefined;
}

/** 只讀檔頭（真 rollout 可以很大），且**只取結構字段**——正文一個字都不進斷言/日誌。 */
function liveRollouts(): { file: string; threadId: string; mtimeMs: number }[] {
  const out: { file: string; threadId: string; mtimeMs: number }[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (name.startsWith("rollout-") && name.endsWith(".jsonl")) {
        const threadId = threadIdFromFile(basename(name));
        if (threadId) out.push({ file: p, threadId, mtimeMs: st.mtimeMs });
      }
    }
  };
  walk(LIVE_ROOT);
  return out;
}

describe.runIf(liveEnabled)("#951 codex 血緣契約：真語料漂移探針（MACCHIATO_LINEAGE_LIVE_CODEX 打開）", () => {
  const RECENT_MS = 45 * 24 * 3600 * 1000;
  const MIN_SAMPLE = 40;

  it("① ②③④ 四類斷言跑在真 rollout 上：聲明率、`session_id≠id ⟺ 派生`、根線程 0 誤傷", () => {
    const all = liveRollouts();
    const now = Date.now();
    let recent = 0;
    let recentDeclared = 0;
    let recentDerived = 0;
    let recentDerivedWithParent = 0;
    const sidNeMisjudged: string[] = [];
    const rootMisjudged: string[] = [];

    for (const r of all) {
      const head = readHead(r.file);
      if (head === undefined) continue;
      const o = parseOrigin(head, r.threadId);
      const isRecent = now - r.mtimeMs < RECENT_MS;
      if (isRecent) {
        recent += 1;
        if (o.evidence !== "absent") recentDeclared += 1;
        if (o.kind !== "user") {
          recentDerived += 1;
          // 「定得出父」才叫歸位；定不出只能隔離（本機基線 544/574，最近 45 天 507/507）。
          if (o.conversationId !== o.threadId) recentDerivedWithParent += 1;
        }
      }
      // 判據不對稱地取自源聲明：`session_id ≠ id` 是 Codex 自己說「我屬於別人」。
      const meta = sessionMeta(head);
      const sid = typeof meta?.session_id === "string" ? meta.session_id : undefined;
      const selfId = typeof meta?.id === "string" ? meta.id : undefined;
      if (!sid || !selfId) continue;
      if (sid !== selfId) {
        if (o.kind === "user" || o.conversationId === o.threadId) sidNeMisjudged.push(r.threadId);
      } else if (o.kind !== "user") {
        rootMisjudged.push(r.threadId);
      }
    }

    // ①② `session_id ≠ id` ⟺ 派生：本機 515/515 零例外，一條例外都算漂移。
    expect(sidNeMisjudged, "session_id≠id 卻被判成根線程（判據鏈斷了 / 上游換了語義）").toEqual([]);
    // ③ 根線程 0 誤傷。
    expect(rootMisjudged, "session_id===id 卻被判成派生（會讓真實用戶會話從列表裡消失）").toEqual([]);
    // ④ 最近 45 天的 rollout 聲明率——上游哪天不寫聲明了，這條當天變紅。
    if (recent >= MIN_SAMPLE) {
      const ratio = recentDeclared / recent;
      expect(
        ratio,
        `最近 ${recent} 個 rollout 只有 ${recentDeclared} 個帶源聲明（比例 ${ratio.toFixed(3)}）：`
          + "Codex 很可能改了 session_meta 的字段名，判據已退回猜正文——去對一遍上游格式，"
          + "並把新形態脫敏後補進 test/fixtures/lineage/，別等生產庫裡冒出一堆同名會話。",
      ).toBeGreaterThanOrEqual(0.9);
    }
    // ① 派生線程「定得出父」的比例：上游改了歸屬字段名（而 thread_source 還在）時，
    //    上面那條聲明率看不出來，這條會塌——派生線程從「歸位」退回「隔離」。
    if (recentDerived >= MIN_SAMPLE) {
      const ratio = recentDerivedWithParent / recentDerived;
      expect(
        ratio,
        `最近 ${recentDerived} 條派生線程只有 ${recentDerivedWithParent} 條定得出父（比例 ${ratio.toFixed(3)}）：`
          + "歸屬判據鏈（session_id → parent_thread_id → forked_from_id）很可能被上游改名了。",
      ).toBeGreaterThanOrEqual(0.85);
    }
  });
});
