/** Link B protocol version — must match the Macchiato server (rejected as "proto mismatch" otherwise). */
export const LINK_B_PROTO = 3;

/** #199 一條 agent 命令/技能(連接器上報 {t:"commands"};鏡像 packages/protocol CommandInfo,字段只增不改)。 */
export interface CommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
  source?: string;
}
