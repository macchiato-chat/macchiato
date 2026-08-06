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
import { randomUUID } from "node:crypto";
import { closeSync, constants, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { healthFilePath, installIdPath, stateDir } from "./identity";

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
}

/** 調用方每個 tick 提供的活體信號。 */
export interface HeartbeatInput {
  version: string;
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
  };
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
