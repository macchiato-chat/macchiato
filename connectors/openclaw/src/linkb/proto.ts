/**
 * GENERATED FILE — do not edit by hand.
 *
 * Extracted from the Macchiato protocol package by `scripts/release/gen-public-proto.mjs`
 * and regenerated on every `sync-public` run, so it can never drift from the wire types
 * the connectors are compiled against (#914).
 */

/** Link B protocol version — must match the Macchiato server (rejected as "proto mismatch" otherwise). */
export const LINK_B_PROTO = 5;

/** Connector release version (mirrors packages/protocol CONNECTOR_VERSION; sync-public 再生,永不漂移). */
export const CONNECTOR_VERSION = "1.5.81";

/**
 * #950（父 #926）執行線程的**血緣**。open enum：線路格式上寬容（未知值原樣保留、不解析失敗），
 * 可見性判定上收緊（server 側對未知值 fail-closed）——判據對齊 ACP v2 的 enum RFD。
 *
 * - `root`：頂層用戶對話 → 進列表。
 * - `continuation`：同一段對話的延續（hermes 上下文壓縮換 id、CC 跨檔 `leafUuid`、codex fork）
 *   → **並入 `conversationId` 那一行**，列表裡仍是一行。續接比重複更傷：用戶會以為歷史丟了。
 * - `derived`：子 agent / 內部評估 / 審批線程 → 歸屬父會話、不平鋪進列表。
 * - 其它字符串：上游發明了新東西 → server 隔離 + 告警，**不建進用戶列表**。
 */
export type ThreadOriginKind = "root" | "continuation" | "derived" | (string & {});

/**
 * 血緣的**證據等級**，決定「信誰」與告警口徑：
 * - `declared`：源系統自己聲明的結構化字段（codex `session_meta.session_id`、CC 行內 `sessionId`、
 *   hermes `parent_session_id`、openclaw `sessions_list.kind`）。
 * - `inferred`：連接器從標題/文件名/時序猜出來的（舊啟發式降級後的去處，必須可觀測）。
 * - `absent`：那個版本的源系統壓根沒有這個概念 → **維持現行行為，絕不倒退**。
 *
 * `absent` 與「未知 kind」的區分是整個設計的安全閥：**未知 kind ≠ 沒有 kind**。前者收緊、
 * 後者維持；分不開就會誤傷真實用戶會話。
 */
export type ThreadOriginEvidence = "declared" | "inferred" | "absent";

/**
 * #950 隨 `ImportSession` 攜帶的血緣元數據。**是元數據不是正文，所以 E2E 會話一樣能帶**
 * （server 看不見密文，但看得見歸屬——這正是 E2E 下唯一還能做判定的憑據）。
 *
 * 三個字段分工不能混：
 * - `conversationId` 決定**歸屬**（落到哪一行）
 * - `kind` 決定**可見性**（進不進列表）
 * - `evidence` 決定**信誰**與告警口徑
 *
 * 連接器只上報事實，**不再自己決定丟棄**——判定收在 server 的 `resolveConversation` 一處，
 * 一次 deploy 對所有存量連接器版本立即生效（生產上有機器釘在舊版三週升不上來）。
 * 整個字段可選：不帶 = `evidence: "absent"` = 老行為。
 */
export interface ThreadOrigin {
  /** 這條執行線程自己的源系統 id（= `ImportSession.hermesSessionId` 所指的那條線程）。 */
  threadId: string;
  /** 屬於哪段對話（源系統聲明；無聲明時 = `threadId`）。 */
  conversationId: string;
  kind: ThreadOriginKind;
  /** 直接父線程（有多層時 `conversationId` 是根、這個是上一層）。 */
  parentThreadId?: string;
  /** 子 agent 名 / 路徑等人話標籤，父會話卡片上顯示（#952）。 */
  label?: string;
  /** 嵌套深度；v1 只記錄不渲染。 */
  depth?: number;
  evidence: ThreadOriginEvidence;
}

/**
 * 連接器 → server（健康上報）：定期上報自身狀態，讓 server 看出「在線但降級」
 * （gateway 死、兼容自檢破、鏡像卡住）。附加消息、不 bump B。
 *
 * ## 形狀 = core + optional bag（#492 / F-03）
 *
 * **core**（server 真消費判 degraded；四家都發）：
 * - `gatewayAlive` / `compatOk` / `mirrorLastPollAgeS`（缺/null → `?? 0`，不視為 stuck）
 *
 * **optional bag**（server 按能力選用；舊端可缺、缺省安全——**絕不**要求舊連接器補齊）：
 * - 派生/路由：`connectorVersion`（updateAvailable）、`installedVersion`（#768 pendingRestart）、`kind`、`authOk`、`stt`
 * - 觀測/日誌：`ts` / `uptimeS` / `linkB` / `hermesVersion` / `compat` / `lastError` / `counters`
 * - 連接器專屬擴展（`cliVersion` / `engine` / `appServerReady`…）允許出現在 wire 上；
 *   類型不枚舉，server 不解析。
 *
 * 歷史：曾把 Hermes 全量字段標 required，但 TS 三家（cc/codex/openclaw）從不發
 * `ts`/`uptimeS`/`linkB`/`hermesVersion`/`compat`——類型說謊。F-03 改為與現實一致。
 */
export interface ConnectorHealthState {
  /* ---- core：server healthFromState / handler degraded 真消費 ---- */
  gatewayAlive: boolean;
  /** 兼容自檢是否通過（CLI/gateway API / transcript 冒煙等，各連接器各自定義）。 */
  compatOk: boolean;
  /**
   * 鏡像循環上次輪詢距今秒數（卡住會變大）。>60 → server 判 `mirrorStuck` / degraded。
   * `null`/缺 = 尚無輪詢數據或未上報 → `?? 0`（不視為 stuck）。
   */
  mirrorLastPollAgeS?: number | null;

  /* ---- optional bag：缺省安全；舊連接器可不發 ---- */
  /** epoch 秒（Hermes 發；TS 三家不發）。 */
  ts?: number;
  /** 進程 uptime 秒（Hermes 發；TS 三家不發）。 */
  uptimeS?: number;
  /** Link B 連線態字串（Hermes：connected | handshaking | …；TS 三家不發）。 */
  linkB?: string;
  /** agent runtime 版本字串（Hermes 的 hermes 版本；TS 三家用 cliVersion 擴展或省略）。 */
  hermesVersion?: string | null;
  /** 分項自檢：每項 `true` 或 `"FAIL: …"`（Hermes 發；TS 三家併入 lastError）。 */
  compat?: Record<string, true | string>;
  /** 最近錯誤/降級原因（日誌 + 部分 client 展示；缺 = 無）。 */
  lastError?: string | null;
  /** 連接器自報版本（§update）；缺省 = 未上報版本的舊連接器 → updateAvailable。 */
  connectorVersion?: string;
  /**
   * #768 安裝目錄（磁盤）版本。與 `connectorVersion`（進程內常量）分開：
   * install 成功但進程未換代時 `installedVersion > connectorVersion` → server 派生 `pendingRestart`。
   * 缺省 = 舊連接器不報；server 不推導 pendingRestart。
   */
  installedVersion?: string;
  /** 連接器類型（hermes | openclaw | claude-code | codex）；client gate 專屬功能。 */
  kind?: string;
  /**
   * #310 agent CLI 登錄態：false = 最近一個驅動回合因認證失敗告終（claude OAuth 失效 /
   * codex auth.json 過期），app 顯示「需要重新登錄」降級態；下個成功回合自動恢復 true。
   * 缺省 = 不支持偵測的連接器（hermes/openclaw 或舊版），client 視為正常。
   */
  authOk?: boolean;
  /**
   * #89 語音轉錄能力位：true=連接器自帶 STT（如 Hermes 本地 whisper，私密優先）；false=無
   * （server 據此不下達音頻、直接走雲端 BYOK STT 回退鏈）；缺省=未知（舊連接器，照常下達音頻）。
   */
  stt?: boolean;
  /**
   * #940 自動更新的**回程**：supervisor 上一次決策。放量策略（`rolloutPercent`）是簽名的控制面，
   * 但此前沒有任何一端能回答「開到 100% 之後，送到了幾台、沒送到的卡在哪」——12 個理由碼只落在
   * 那台機器的日誌裡，於是 4 台連接器在舊版上釘了 11 天而我們這邊一切正常。
   *
   * `supervised` 是**三態**，別把缺省當 false：
   * - `true` = supervisor 活着（狀態檔裡的存活印章新鮮）；
   * - `false` = 沒人管它 —— 狀態檔不存在，或印章已過期（典型成因：`install.sh` 找不到 supervise
   *   二進制時會靜默退化成直跑，而舊狀態檔還躺在原地）。自動更新根本不會發生，這本身就是答案；
   * - 缺省 = 不知道（老 supervisor 不蓋印章）。猜一個 true 恰恰是本 issue 要修的那種錯。
   *
   * `reason` = `update_decider` 的理由碼（`busy` / `not-in-rollout` / `blocked` / `trial-pending`
   * / `update-stopped` / `auto-update-off` / `policy-expired` …），`target` = 當時要裝的版本，
   * `at` = epoch 秒。判定為沒人管時不帶 `reason`（那是陳年舊事，留着只會誤導排查）。
   *
   * 整個字段缺省 = 舊連接器不報。server 只落庫 + 展示，**絕不據此改變任何行為**（更新決策的權威
   * 永遠在簽名策略那一側，不能由一個上報字段反向影響）。
   */
  update?: {
    supervised?: boolean;
    reason?: string;
    target?: string;
    at?: number;
  };
  /**
   * #10 累計計數（進程生命週期，重啟歸零）：mirrorBatches/mirrorMessages/mirrorNacks/
   * promptRetries/dispatchErrors/gatewayRestarts…（各連接器按自身路徑上報，鍵不強約定）。
   * 狀態快照看不見「一次性的丟/重複/重投」——計數器才看得見。缺省=舊連接器。
   */
  counters?: Record<string, number>;
}

/**
 * #199 一條 agent 命令/技能(連接器上報;`name` 無前導斜杠,client 渲染成 `/name`)。
 * 描述可能很長(Hermes p90≈199 字)——連接器上報前應截斷(≤200);client 據 `source` 分組。
 */
export interface CommandInfo {
  name: string;
  description?: string;
  /** 參數提示(如 `<file>`);CC supportedCommands 原生提供。 */
  argumentHint?: string;
  /** 來源分組(builtin/plugin/user/project/skill/分類名…,連接器自定)。 */
  source?: string;
}
