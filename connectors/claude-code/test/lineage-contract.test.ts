/**
 * #951 血緣契約夾具（claude-code）：讓**上游改 transcript 格式**在 CI 裡變紅，而不是在用戶的
 * 會話列表裡變紅。
 *
 * 為什麼要有這一份（#926 的結論）：顯式歸屬（#947）、單一入口、fail-closed 都只保證「按**當前
 * 已知格式**判得對」，一個都防不住「Claude Code 下個版本換字段」。歷史上這類漂移全是靠用戶投訴
 * 發現的——2026-07-11（後台任務冒出同名會話）、#918、以及 #926（生產庫 11 條會話 / 1600 條重複
 * 消息）。回歸夾具是唯一能在上游動手的當天就攔下來的東西。
 *
 * 兩層，缺一不可：
 *
 *  1. **靜態語料**（`test/fixtures/lineage/`，隨倉庫走、CI 每次 push 跑）
 *     10 份脫敏 transcript，行形態逐條取自本機 552 個真實 transcript 的盤點（見 `manifest.json`
 *     每條的 `shape`）。**正文、路徑、git 信息全部重寫，只留結構**。它防的是**我們自己**改壞
 *     判據，以及老格式行為被無聲改掉。
 *
 *  2. **真語料漂移探針**（顯式 `MACCHIATO_LINEAGE_LIVE_CC=<真 projects 目錄>` 才跑）
 *     靜態語料是死的，上游改字段名它一輩子綠；只有真語料的聲明率會當場塌下來。
 *
 * 四類斷言（issue #951，四家連接器同一套口徑）：
 *   ① 每條派生線程（子 agent）都解析得出 `declared` 的 kind 與歸屬
 *   ② 每條續接線程（終端 `--resume` / rewind）都接回正確的父
 *   ③ 根線程（主會話）**0 誤傷**
 *   ④ `evidence: "absent"` 的比例不超過閾值（超了＝上游不再寫聲明、我們已退回猜文件名）
 *
 * 實測基線（2026-08-14，本機 552 個真實 transcript）：237 個子 agent 檔 `sessionId` 指父
 * **237/237**、11 條指紋續接、315 個主會話 **0 誤傷**、聲明率 0.994。
 *
 * hermes / openclaw 兩家的同款語料**留到 #948 / #949 落地之後補**（它們的實現正在改，這一刀
 * 刻意不碰）：位置分別是 `services/hermes-connector/test/fixtures/lineage/`（`state.db` 行）與
 * `services/openclaw-connector/test/fixtures/lineage/`（gateway `sessions_list` 快照）。
 */
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Mirror, discoverSessions } from "../src/cc/mirror";
import { readTranscriptOrigin, resetLineageMemo, type OriginEvidence, type OriginKind } from "../src/cc/lineage";

const CORPUS = fileURLToPath(new URL("./fixtures/lineage/", import.meta.url));

interface FixtureCase {
  file: string;
  sid: string;
  era: "current" | "legacy";
  role: "root" | "derived" | "continuation";
  shape: string;
  expect: {
    kind: OriginKind;
    evidence: OriginEvidence;
    declaredParent?: string;
    agentId?: string;
    /** 續接：歸屬到哪條會話（`Mirror.identitySid` 的期望值）；根線程 = null。 */
    parent?: string | null;
  };
}

const manifest = JSON.parse(readFileSync(join(CORPUS, "manifest.json"), "utf8")) as {
  thresholds: { maxAbsentRatioOverall: number; maxAbsentRatioCurrentEra: number };
  cases: FixtureCase[];
};
const cases = manifest.cases;

/** 把語料整棵複製進沙箱，並**按 manifest 順序寫 mtime**——git 不保留 mtime，而血緣解析
 *  按 mtime 升序登記（父檔必須先於它的續接檔被登記）。 */
function plantCorpus(): { projects: string; cfg: string } {
  const cfg = mkdtempSync(join(tmpdir(), "cc-951-"));
  cpSync(join(CORPUS, "projects"), join(cfg, "projects"), { recursive: true });
  const base = Date.UTC(2026, 7, 14, 10, 0, 0) / 1000;
  cases.forEach((c, i) => {
    const p = join(cfg, c.file);
    utimesSync(p, base + i, base + i);
  });
  process.env.CLAUDE_CONFIG_DIR = cfg;
  process.env.MACCHIATO_CC_MIRROR = join(cfg, "mirror-state.json");
  writeFileSync(process.env.MACCHIATO_CC_MIRROR, JSON.stringify({ offsets: {}, titles: {}, seeded: true }));
  resetLineageMemo();
  return { projects: join(cfg, "projects"), cfg };
}

function fakeLinkb(): { linkb: any; frames: Record<string, any>[] } {
  const frames: Record<string, any>[] = [];
  return {
    linkb: {
      agentLinkId: "AL1",
      isReady: true,
      send: (m: Record<string, unknown>) => frames.push(m as Record<string, any>),
      onFrame: () => () => {},
    },
    frames,
  };
}

const appends = (frames: Record<string, any>[]): Record<string, any>[] =>
  frames.filter((f) => f.t === "mirror_append");

let sandbox: { projects: string; cfg: string };
const savedEnv = { cfg: process.env.CLAUDE_CONFIG_DIR, mirror: process.env.MACCHIATO_CC_MIRROR };

beforeEach(() => {
  sandbox = plantCorpus();
});

afterEach(() => {
  rmSync(sandbox.cfg, { recursive: true, force: true });
  if (savedEnv.cfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedEnv.cfg;
  if (savedEnv.mirror === undefined) delete process.env.MACCHIATO_CC_MIRROR;
  else process.env.MACCHIATO_CC_MIRROR = savedEnv.mirror;
  resetLineageMemo();
});

const originOf = (c: FixtureCase) => readTranscriptOrigin(join(sandbox.cfg, c.file), c.sid);

describe("#951 claude-code 血緣契約：靜態語料", () => {
  it("語料完整性：目錄裡每個 transcript 都在 manifest 裡有期望（丟進新樣本卻不寫期望＝紅）", () => {
    const onDisk: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (e.endsWith(".jsonl")) onDisk.push(relative(CORPUS, p));
      }
    };
    walk(join(CORPUS, "projects"));
    expect(onDisk.sort()).toEqual(cases.map((c) => c.file).sort());
    for (const role of ["root", "derived", "continuation"] as const) {
      expect(cases.filter((c) => c.role === role).length, role).toBeGreaterThan(0);
    }
  });

  it("① 子 agent：100% 解析出 declared 的 kind 與歸屬（新舊佈局、以及「檔名被改掉」的形態）", () => {
    const derived = cases.filter((c) => c.role === "derived");
    for (const c of derived) {
      const o = originOf(c);
      expect(o.kind, c.file).toBe("subagent");
      if (c.era === "current") {
        // 行內聲明才算「解析得出歸屬」——退回文件名兜底就是漂移信號。
        expect(o.evidence, `${c.file}（退回文件名兜底 = CC 改了行內字段）`).toBe("declared");
        expect(o.declaredParent, c.file).toBe(c.expect.declaredParent);
      }
    }
    // 子 agent 一條都不許進發現列表（進了 = 用戶列表裡多出一條同名會話）。
    const found = new Set(discoverSessions(sandbox.projects).map((s) => s.sid));
    for (const c of derived) expect(found.has(c.sid), c.file).toBe(false);
  });

  it("② 續接：100% 接回正確的父（--resume 全量副本 + rewind 截斷副本）", () => {
    const { linkb } = fakeLinkb();
    const m = new Mirror(linkb) as any;
    m.resolveNewOrigins(discoverSessions(sandbox.projects));
    for (const c of cases.filter((c) => c.role === "continuation")) {
      expect(m.identitySid(c.sid), `${c.file} — ${c.shape}`).toBe(c.expect.parent);
    }
  });

  it("③ 主會話：0 誤傷（一條都不許被判成子 agent 或被改投到別的會話）", () => {
    const roots = cases.filter((c) => c.role === "root");
    for (const c of roots) expect(originOf(c).kind, c.file).toBe("user");
    const found = new Set(discoverSessions(sandbox.projects).map((s) => s.sid));
    for (const c of roots) expect(found.has(c.sid), `${c.file} 沒被發現 = 這條會話在 app 裡消失`).toBe(true);

    const { linkb } = fakeLinkb();
    const m = new Mirror(linkb) as any;
    m.resolveNewOrigins(discoverSessions(sandbox.projects));
    for (const c of roots) expect(m.identitySid(c.sid), c.file).toBe(c.sid);
  });

  it("④ evidence=absent 的比例不超過閾值（超了＝上游不再寫聲明、我們已退回猜）", () => {
    const absent = cases.filter((c) => originOf(c).evidence === "absent");
    expect(absent.length / cases.length).toBeLessThanOrEqual(manifest.thresholds.maxAbsentRatioOverall);
    const currentAbsent = absent.filter((c) => c.era === "current").map((c) => c.file);
    expect(currentAbsent.length / cases.length).toBeLessThanOrEqual(
      manifest.thresholds.maxAbsentRatioCurrentEra,
    );
    expect(currentAbsent).toEqual([]);
  });

  it("逐條期望：kind / evidence / declaredParent / agentId 全對得上", () => {
    for (const c of cases) {
      const { parent: _parent, ...origin } = c.expect;
      expect(originOf(c), `${c.file} — ${c.shape}`).toMatchObject(origin);
    }
  });
});

describe("#951 claude-code 血緣契約：整套語料喂給鏡像", () => {
  it("①②③ 只有主會話建會話：子 agent 0 條、續接併進父會話、主會話一條不少", () => {
    const { linkb, frames } = fakeLinkb();
    const m = new Mirror(linkb) as any;
    m.doPoll();

    const sids = new Set(appends(frames).flatMap((f) => f.sessions.map((s: any) => s.hermesSessionId as string)));
    const roots = cases.filter((c) => c.role === "root").map((c) => c.sid);
    // 續接檔的正文投進父會話的身份 → 出現的身份只可能是主會話。
    expect([...sids].sort()).toEqual([...roots].sort());
    for (const c of cases.filter((c) => c.role !== "root")) {
      expect(sids.has(c.sid), `${c.file} 冒出了自己的會話身份（＝用戶列表裡多一行）`).toBe(false);
    }

    // 續接檔複製來的歷史不重灌：父會話裡同一段正文的 srcId 只有一份（server 端唯一索引吃掉）。
    const firstLine = appends(frames)
      .flatMap((f) => f.sessions.flatMap((s: any) => s.messages))
      .filter((msg: any) => msg.text === "脫敏語料：主會話 A 的第一句");
    expect(new Set(firstLine.map((msg: any) => msg.srcId)).size).toBe(1);
  });

  it("續接之後在終端繼續聊：新消息落進父會話，不另建一條", () => {
    const { linkb, frames } = fakeLinkb();
    const m = new Mirror(linkb) as any;
    m.doPoll();

    const cont = cases.find((c) => c.role === "continuation")!;
    const p = join(sandbox.cfg, cont.file);
    writeFileSync(
      p,
      readFileSync(p, "utf8")
        + JSON.stringify({
          parentUuid: null, isSidechain: false, cwd: "/w/proj", entrypoint: "cli", gitBranch: "main",
          userType: "external", version: "2.1.212", type: "user",
          message: { role: "user", content: "續接之後的又一個問題" },
          sessionId: cont.sid, uuid: "00009510-2222-4000-8000-000000000099", timestamp: "2026-08-14T11:00:00.000Z",
        })
        + "\n",
    );
    const cur = frames.length;
    m.doPoll();

    const fresh = appends(frames.slice(cur));
    const landed = fresh.find((f) =>
      f.sessions.some((s: any) => s.messages.some((msg: any) => msg.text === "續接之後的又一個問題")));
    expect(landed, "續接後的新消息沒到達 server").toBeTruthy();
    const sess = landed!.sessions.find((s: any) =>
      s.messages.some((msg: any) => msg.text === "續接之後的又一個問題"));
    expect(sess.hermesSessionId).toBe(cont.expect.parent);
  });
});

/**
 * ── 真語料漂移探針（**顯式 opt-in**，默認不跑）─────────────────────────────────
 *
 * 打開方式：
 *   `MACCHIATO_LINEAGE_LIVE_CC=~/.claude/projects pnpm --filter @macchiato/claude-code-connector test`
 *
 * 為什麼不自動探測 `~/.claude`：#303 的 hermetic setup 把 `HOME` 整個重定向進沙箱，正是為了
 * 「單測絕不碰開發者本機數據」。**靠 `existsSync(projectsDir())` 判斷的閘門在沙箱下永遠為假、
 * 永遠靜默跳過**——看起來有閘、實際永不響，比沒有更糟。所以這裡只認一個顯式路徑。
 *
 * 探針只讀每個 transcript 的**頭部結構字段**，正文一個字都不進斷言、不進日誌。
 */
const LIVE_ROOT = process.env.MACCHIATO_LINEAGE_LIVE_CC?.replace(/^~(?=\/)/, homedir()) ?? "";
const liveEnabled = !!LIVE_ROOT && existsSync(LIVE_ROOT);

describe.runIf(liveEnabled)("#951 claude-code 血緣契約：真語料漂移探針（MACCHIATO_LINEAGE_LIVE_CC 打開）", () => {
  const MIN_SAMPLE = 40;

  it("①③④ 跑在真 transcript 上：子 agent 檔全 declared、主會話 0 誤傷、聲明率不塌", () => {
    resetLineageMemo();
    let subagents = 0;
    let subagentsDeclared = 0;
    let mains = 0;
    let mainsDeclared = 0;
    const misjudged: string[] = [];

    for (const d of readdirSync(LIVE_ROOT)) {
      const dir = join(LIVE_ROOT, d);
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const e of entries) {
        const p = join(dir, e);
        let isDir = false;
        try {
          isDir = statSync(p).isDirectory();
        } catch {
          continue;
        }
        // 新佈局：<project>/<父會話 id>/subagents/agent-*.jsonl
        if (isDir) {
          const sub = join(p, "subagents");
          if (!existsSync(sub)) continue;
          for (const a of readdirSync(sub)) {
            if (!a.endsWith(".jsonl")) continue;
            const o = readTranscriptOrigin(join(sub, a), basename(a, ".jsonl"));
            subagents += 1;
            if (o.kind === "subagent" && o.evidence === "declared") subagentsDeclared += 1;
            else misjudged.push(`subagent:${basename(a)}`);
          }
          continue;
        }
        if (!e.endsWith(".jsonl") || e.startsWith("agent-")) continue;
        const o = readTranscriptOrigin(p, basename(e, ".jsonl"));
        mains += 1;
        if (o.kind === "subagent") misjudged.push(`main:${basename(e)}`); // ③ 0 誤傷
        if (o.evidence !== "absent") mainsDeclared += 1;
      }
    }

    expect(misjudged, "子 agent 判不出來 / 主會話被判成子 agent —— CC 很可能改了行內聲明字段").toEqual([]);
    expect(mains).toBeGreaterThan(0);
    if (subagents >= 10) expect(subagentsDeclared / subagents).toBeGreaterThanOrEqual(0.95);
    if (mains >= MIN_SAMPLE) {
      const ratio = mainsDeclared / mains;
      expect(
        ratio,
        `${mains} 個主會話裡只有 ${mainsDeclared} 個有對話指紋（比例 ${ratio.toFixed(3)}）：`
          + "CC 很可能不再寫 uuid / leafUuid，續接判定已無鉤子——去對一遍上游格式，"
          + "並把新形態脫敏後補進 test/fixtures/lineage/。",
      ).toBeGreaterThanOrEqual(0.9);
    }
  });
});
