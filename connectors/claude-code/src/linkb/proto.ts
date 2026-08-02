/** Link B protocol version — must match the Macchiato server (rejected as "proto mismatch" otherwise). */
export const LINK_B_PROTO = 5;

/** Connector release version (mirrors packages/protocol CONNECTOR_VERSION; sync-public 再生,永不漂移). */
export const CONNECTOR_VERSION = "1.5.70";

/** #199 一條 agent 命令/技能(連接器上報 {t:"commands"};鏡像 packages/protocol CommandInfo,字段只增不改)。 */
export interface CommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
  source?: string;
}

/** #231 一個可選 model(連接器上報 {t:"models"};鏡像 packages/protocol ModelOption,字段只增不改)。 */
export interface ModelOption {
  id: string;
  label: string;
  description?: string;
  effortLevels?: string[];
  defaultEffort?: string;
  /** #542 本行 id 解析到的 canonical wire model id(SDK ModelInfo.resolvedModel;codex 無別名不帶)。 */
  resolvedId?: string;
  /** #553 連接器在 session.model 空時實際運行的那一行(CC = default 行對回的別名行;codex = model/list 的 isDefault)。 */
  isDefault?: boolean;
}

/** #492 健康上報 core+optional(鏡像 packages/protocol ConnectorHealthState;字段只增不改)。 */
export interface ConnectorHealthState {
  gatewayAlive: boolean;
  compatOk: boolean;
  mirrorLastPollAgeS?: number | null;
  ts?: number;
  uptimeS?: number;
  linkB?: string;
  hermesVersion?: string | null;
  compat?: Record<string, true | string>;
  lastError?: string | null;
  connectorVersion?: string;
  kind?: string;
  authOk?: boolean;
  stt?: boolean;
  counters?: Record<string, number>;
}
