/** Link B protocol version — must match the Macchiato server (rejected as "proto mismatch" otherwise). */
export const LINK_B_PROTO = 4;

/** Connector release version (mirrors packages/protocol CONNECTOR_VERSION; sync-public 再生,永不漂移). */
export const CONNECTOR_VERSION = "1.5.48";

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
}
