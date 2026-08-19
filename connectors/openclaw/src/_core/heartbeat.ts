/**
 * #669 本地心跳快照 `$MACCHIATO_STATE_DIR/health-<kind>.json` —— 四家連接器統一寫，進程外
 * supervisor 讀。**按 kind 分家**的理由見 identity.healthFilePath（同機多家共用一份會互相覆蓋，
 * 於是「CC 的 supervisor 讀到 Codex 的斷連狀態並重裝 CC」）；Hermes 另外保留歷史的 `health.json`。
 *
 * 為什麼要有它（#669 / #210，Brian 親身踩過）：
 *   `macchiato-supervise`（#528）只認一種病——**崩潰循環**。連接器「進程活著、但連不上 server」時
 *   supervisor 完全看不見：子進程穩定存活 ≥60s 就清失敗計數，然後一直 wait。而連不上 = 收不到
 *   `self_update` = 自己爬不出來，死循環。
 *
 *   supervisor **絕不能 import 連接器樹**（那正是會壞的東西），所以唯一乾淨的接口是**文件**。
 *
 * 落盤內容 = 該連接器的 `connector_health` 上報體 ⊕ 本模塊的運維字段。
 *   · 上報體部分**原樣保留**，向後兼容既有消費者（Hermes 早就在寫這個文件，人也在本機 inspect 它）；
 *   · 運維字段是新增的並集，老讀者看不見它們也不會壞。
 *   · **只擴文件，不擴 wire**：`connector_health` 幀的形狀一個字節都沒動（server 側零改動）。
 *
 * 🚨 絕不寫入憑據 / token / 用戶會話內容：文件會落盤、會被人看到、會被貼進 issue。只放運維字段。
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { healthFilePath, installIdPath, stateDir, supervisorStateFilePath } from "./identity";

/** supervisor 面的運維字段（四家統一；Hermes 側鏡像同一組 key）。 */
export interface HeartbeatFields {
  /** 最後寫入時間（epoch **秒**，對齊 Hermes 既有的 `ts`）——supervisor 據此判新鮮度。 */
  ts: number;
  /** 當前連接器版本（= 上報體的 `connectorVersion`，給不認識那個名字的 supervisor 用）。 */
  version: string;
  /** **是否成功連上 server**（Link B ready）——supervisor「活著但連不上」判據的核心。 */
  linkConnected: boolean;
  /** 最近一次連上的時刻（epoch 秒）；從未連上過 → null。 */
  lastConnectedAt: number | null;
  /** 有進行中的回合（為後續「閒時更新」預留；本階段只負責寫出來）。 */
  busy: boolean;
  /** 有待用戶審批的工具調用（同上）。 */
  pendingApproval: boolean;
  /** 本機安裝的穩定標識（為後續分批放量的哈希種子預留）。生成後持久化，不隨進程變。 */
  installId: string;
  /**
   * #977 寫這份心跳的**進程 pid**。同機第二個實例據此讓位：光看 `ts` 新鮮度不夠——
   * 用戶 Ctrl-C 後立刻重跑，上一份心跳還新鮮著，會把自己冤殺成「已有實例在跑」。
   * 反過來只看 pid 也不行（pid 會被復用），兩個一起看才立得住。
   */
  pid: number;
  /**
   * #991 這份心跳服務的 agent link **指紋**（未配對 → null）。讓位判據要它：**只認 kind 是不夠的**。
   *
   * #977 要防的是「同一條 agent link 有兩條 Link B」——server 的 `registry.add` 只留最後一條、
   * 把前一條 4001 superseded 踢掉，被踢的退避幾秒又連回來，本機自己跟自己打。那個「同一條」
   * 才是衝突的來源。只看 kind 會把**根本不衝突**的組合一起誤殺：一台機器上兩個帳號各一個
   * 連接器、一個連 staging 一個連生產、以及所有測試骨架（2026-08-17 狗糧實測四步紅）。
   * 誤殺的代價是「起不來且不知道為什麼」，而那行提示還寫着 nothing for you to do。
   */
  agentLinkFp: string | null;
}

/**
 * #991 agent link 的**指紋**（sha256 前 16 hex）。存指紋不存原值：讓位只需要「相不相等」，
 * 而這個文件是會被貼進 issue 的診斷產物——見同文件「不新增任何憑據類鍵」那條不變式。
 */
export function agentLinkFingerprint(agentLinkId: string | null | undefined): string | null {
  if (typeof agentLinkId !== "string" || !agentLinkId) return null;
  return createHash("sha256").update(agentLinkId).digest("hex").slice(0, 16);
}

/** 調用方每個 tick 提供的活體信號。 */
export interface HeartbeatInput {
  version: string;
  /** #991 本連接器服務的 agent link（未配對 → null/undefined）。見 `HeartbeatFields.agentLinkId`。 */
  agentLinkId?: string | null;
  linkConnected: boolean;
  /** 最近一次 Link B ready 的時刻（epoch **毫秒**，Date.now() 口徑）；從未連上 → null/undefined。 */
  lastConnectedAtMs?: number | null;
  busy?: boolean;
  pendingApproval?: boolean;
}

const toS = (ms: number | null | undefined): number | null =>
  typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;

/**
 * 讀取（必要時生成）本機安裝標識。
 *
 * 併發安全：用 `O_CREAT|O_EXCL` 搶佔式創建——同機四家連接器同時啟動時只有一個贏，輸的那個
 * 回頭讀贏家寫的值。**絕不用 write-then-rename**：那會讓後到的進程覆蓋掉先到的 id，
 * 於是「穩定標識」每次重啟都在兩個值之間跳，分批放量的分桶跟著抖。
 */
export function readOrCreateInstallId(path: string = installIdPath()): string {
  const valid = (s: string): boolean => /^[0-9a-zA-Z._-]{8,128}$/.test(s);
  const read = (): string | null => {
    try {
      const s = readFileSync(path, "utf8").trim();
      return valid(s) ? s : null;
    } catch {
      return null;
    }
  };
  const existing = read();
  if (existing) return existing;
  const fresh = randomUUID();
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      writeSync(fd, `${fresh}\n`);
    } finally {
      closeSync(fd);
    }
    return fresh;
  } catch {
    // 已存在（別人搶先）或盤寫不了：能讀到就用讀到的，否則退回本進程臨時值。
    // fail-open——心跳寫不出去絕不能把連接器搞崩，最壞退回「supervisor 看不到心跳」= 今天的行為。
    return read() ?? fresh;
  }
}

/** 組裝運維字段（純函數，便於單測）。 */
export function buildHeartbeat(input: HeartbeatInput, nowMs: number = Date.now(), idPath?: string): HeartbeatFields {
  return {
    ts: Math.floor(nowMs / 1000),
    version: input.version,
    linkConnected: !!input.linkConnected,
    lastConnectedAt: toS(input.lastConnectedAtMs),
    busy: !!input.busy,
    pendingApproval: !!input.pendingApproval,
    installId: readOrCreateInstallId(idPath),
    pid: process.pid,
    agentLinkFp: agentLinkFingerprint(input.agentLinkId),
  };
}

/** 別的實例的心跳裡我們唯一關心的兩格（#977 讓位判據）。 */
export interface HeartbeatLiveness {
  /** 最後寫入時間（epoch 秒）。 */
  ts: number;
  /** 寫它的進程 pid；老連接器沒寫這格 → null（那就別讓位，寧可放行也不冤殺）。 */
  pid: number | null;
  /** #991 它服務的 agent link 指紋；老連接器沒寫這格 → null（同樣別讓位）。 */
  agentLinkFp: string | null;
}

/**
 * #977 讀本機同 kind 心跳的活體兩格。**永不拋**：文件不在 / 壞了 / 沒權限 → null，
 * 調用方按「沒有別的實例」處理。
 */
export function readHeartbeatLiveness(
  kind: string,
  path: string = healthFilePath(kind),
): HeartbeatLiveness | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  const ts = rec.ts;
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return null;
  const pid = typeof rec.pid === "number" && Number.isInteger(rec.pid) && rec.pid > 1 ? rec.pid : null;
  const agentLinkFp = typeof rec.agentLinkFp === "string" && rec.agentLinkFp ? rec.agentLinkFp : null;
  return { ts: Math.floor(ts), pid, agentLinkFp };
}

/**
 * 原子寫 `health.json` = 上報體 ⊕ 運維字段。
 *
 * **永不拋**：心跳是觀測面，寫不出去（盤滿 / 只讀 / 權限）只該讓 supervisor 判「未知」，
 * 絕不能反過來把健康的連接器搞崩。
 */
export function writeHeartbeat(
  snapshot: Record<string, unknown>,
  input: HeartbeatInput,
  path: string = healthFilePath(),
): HeartbeatFields | null {
  let fields: HeartbeatFields;
  try {
    fields = buildHeartbeat(input);
  } catch {
    return null;
  }
  const tmp = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, `${JSON.stringify({ ...snapshot, ...fields }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    return fields;
  } catch (err) {
    console.error(`[health file write failed] ${err instanceof Error ? err.message : String(err)}`);
    try {
      unlinkSync(tmp); // 對齊 safe-fs / Hermes：寫失敗也別在狀態目錄裡積 .tmp 殘骸
    } catch {
      /* 沒殘骸就沒事 */
    }
    return null;
  }
}

/**
 * #940 supervisor 上一次自動更新決策（讀 `supervise-<kind>.state`）。
 *
 * 為什麼要把它搬上 wire：放量策略是簽名的控制面，但**沒有回程**——`rolloutPercent` 開到 100 之後，
 * 沒有任何一端能回答「送到了幾台、沒送到的卡在哪」。決策器的 12 個理由碼此前只落在那台機器的
 * 日誌裡（`macchiato-supervise.sh` 的 `log`），於是實際情況是：4 台連接器在 1.5.69 上釘了 11 天，
 * 而我們這邊看起來一切正常。有了這幾個字段，「誰沒升、卡在哪道閘」是一條 SQL。
 *
 * **永不拋**：檔案不存在（沒被 supervisor 托管 / 舊 supervisor 還沒寫過）→ `undefined`，
 * 上報側據此報 `supervised: false`——那本身就是一個要能查出來的答案（`install.sh` 在找不到
 * supervise 二進制時會靜默退化成直跑，server 側此前完全看不出區別）。
 */
export function readSupervisorUpdateState(
  kind: string,
  path: string = supervisorStateFilePath(kind),
): { reason?: string; target?: string; at?: number; aliveAt?: number } | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const out: { reason?: string; target?: string; at?: number; aliveAt?: number } = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    // 值域與 supervisor 側的 sanitize_* 同一套；讀端再收一次，別讓一個壞掉的狀態檔把
    // 奇怪字串經由 health 幀送進 server 的庫裡。
    if (key === "LAST_UPDATE_REASON" && /^[a-z][a-z0-9-]{0,39}$/.test(value)) out.reason = value;
    else if (key === "LAST_UPDATE_TARGET" && /^\d+\.\d+\.\d+$/.test(value)) out.target = value;
    else if (key === "LAST_UPDATE_AT" && /^\d{1,12}$/.test(value)) out.at = Number(value);
    else if (key === "SUPERVISE_ALIVE_AT" && /^\d{1,12}$/.test(value)) out.aliveAt = Number(value);
  }
  return out;
}

/**
 * 「印章多久沒蓋就算沒人管了」。supervisor 每小時蓋一次（`ALIVE_STAMP_S`），這裡取 6 小時：
 * 寬到足以吃下休眠、關機一夜、時鐘微調，又遠短於「這台已經被降級成直跑好幾天了」。
 */
const SUPERVISOR_ALIVE_WINDOW_S = 6 * 3600;

/**
 * #940 `connector_health.update` 的上報體。`supervised:false` 不是「沒消息」——它明確回答
 * 「這台機器上根本沒有 supervisor 在管這個連接器」，那是自動更新永不發生的頭號原因，
 * 而此前 server 側和被托管的機器長得一模一樣。
 */
export function supervisorUpdateReport(
  kind: string,
  nowS: number = Math.floor(Date.now() / 1000),
): { supervised?: boolean; reason?: string; target?: string; at?: number } {
  const state = readSupervisorUpdateState(kind);
  // 檔案不在 = 這台從沒被 supervisor 管過（或整個狀態根被清了）→ 明確的 false。
  if (!state) return { supervised: false };
  const { aliveAt, ...decision } = state;
  // 老 supervisor 不蓋印章 → 誠實地說「不知道」（省略字段），而不是猜一個 true。
  // 猜 true 正是本 issue 要修的那種錯：一個看起來健康、實際沒人管的行。
  if (aliveAt === undefined) return decision;
  // 印章過期 = 曾經有人管、現在沒有了（典型成因：install.sh 找不到 supervise 二進制，
  // 靜默降級成直跑，而舊狀態檔還躺在原地）。這時 `reason` 已經是陳年舊事，一併丟掉，
  // 否則庫裡會出現「沒人管它，但上週忙着」這種自相矛盾、且會誤導排查的行。
  if (nowS - aliveAt > SUPERVISOR_ALIVE_WINDOW_S) return { supervised: false };
  return { supervised: true, ...decision };
}

/** 便於排障：`node -e "console.log(require(...).heartbeatPaths())"`。 */
export function heartbeatPaths(): { stateDir: string; healthFile: string; installId: string } {
  return { stateDir: stateDir(), healthFile: healthFilePath(), installId: installIdPath() };
}

/** 默認心跳間隔（env 可調）。要**明顯小於** supervisor 的過期閾值，否則正常機器也會被判「過期」。 */
export const HEARTBEAT_INTERVAL_MS = Number(process.env.MACCHIATO_HEARTBEAT_MS) || 30_000;

/**
 * 心跳寫入器：**獨立於 Link B 的定時器**。
 *
 * ⚠️ 這一點是本模塊的關鍵設計，不是可有可無的講究：三家 index.ts 都 `await linkb.start()`
 * ——那個 promise 只在**首次 ready** 時 resolve。若把心跳掛在 `HealthLoop`（它在 start() 之後才
 * 啟動）上，「連不上 server」的機器就永遠寫不出心跳，而那恰好是 #669 唯一要觀測的故障。
 * 故本寫入器必須在 `linkb.start()` **之前**啟動、自帶時鐘。
 *
 * `HealthLoop` 每 tick 把最新 `connector_health` 上報體餵進來（`setSnapshot`），
 * 文件內容 = 上報體 ⊕ 運維字段；還沒餵過就只有運維字段（supervisor 只讀後者）。
 */
export class HeartbeatWriter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private snapshot: Record<string, unknown> = {};

  private readonly path: string;

  constructor(
    /** 本連接器 kind——心跳文件按 kind 分家（`health-<kind>.json`，見 identity.healthFilePath）。 */
    kind: string,
    /** 每次寫入時現讀活體信號（別在構造時快照——那會永遠報啟動瞬間的狀態）。 */
    private readonly read: () => HeartbeatInput,
    path?: string,
  ) {
    this.path = path ?? healthFilePath(kind);
  }

  /** HealthLoop 每 tick 餵最新上報體（同一份對象即可，寫入時才序列化）。 */
  setSnapshot(snapshot: Record<string, unknown>): void {
    this.snapshot = snapshot;
  }

  writeNow(): HeartbeatFields | null {
    let input: HeartbeatInput;
    try {
      input = this.read();
    } catch {
      return null; // fail-open：讀活體信號都能炸的話，寧可沒心跳也不能拖垮連接器
    }
    return writeHeartbeat(this.snapshot, input, this.path);
  }

  start(intervalMs: number = HEARTBEAT_INTERVAL_MS): void {
    this.writeNow(); // 立刻落一次：進程剛起來就該有「我活着、還沒連上」的證據
    this.timer = setInterval(() => this.writeNow(), intervalMs);
    this.timer.unref?.(); // 心跳不該把進程留在事件循環裡
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
