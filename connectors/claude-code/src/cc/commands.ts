/**
 * #199 命令/技能枚舉與上報:composer `/` 菜單的數據源。
 * 權威源 = SDK `Query.supportedCommands()`——builtin skills 編進 claude 二進制,磁碟上不存在,
 * **勿 dir-walk**。清單只含 skills/自定義命令;CLI 內建本地命令(/cost 等)不在其中(菜單自然不出)。
 * 上報時機:啟動時短命 query 枚舉一次 + 每次 Link B ready 重發(server 重啟丟內存緩存)+
 * live 通道 `system/commands_changed` 整份替換(SDK 明示:supportedCommands 是 init 快照,
 * 變更後重調只會拿到舊的,必須用 changed 消息自帶的載荷)。
 * 已知限制(v1):廣播 workDir() 級清單;project skills 隨會話 cwd 變的差異不反映(#199 記錄)。
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CommandInfo } from "../linkb/proto";
import type { LinkBClient } from "../linkb/client";
import { claudeBinIsAbsolute, resolveClaudeBin } from "./claude-bin";

const DESC_MAX = 200;

/** SDK SlashCommand[] → 協議 CommandInfo[](去前導斜杠、截描述、丟無名項)。 */
export function toCommandInfos(cmds: unknown[]): CommandInfo[] {
  const out: CommandInfo[] = [];
  for (const raw of cmds ?? []) {
    const c = (raw ?? {}) as Record<string, unknown>;
    const name = String(c.name ?? "")
      .trim()
      .replace(/^\//, "");
    if (!name) continue;
    const description = String(c.description ?? "")
      .trim()
      .slice(0, DESC_MAX);
    const argumentHint = String(c.argumentHint ?? "").trim();
    out.push({ name, ...(description ? { description } : {}), ...(argumentHint ? { argumentHint } : {}) });
  }
  return out;
}

/** 起一個短命 query 只為枚舉(#199 探針:supportedCommands 首回合前即可用,init 即返);拿到即 close 回收進程。 */
export async function enumerateCommands(cwd: string): Promise<CommandInfo[]> {
  // 永不產出的 prompt 流:只讓 CLI 走到 init,不起任何回合。
  const idle = (async function* (): AsyncGenerator<never> {
    await new Promise<never>(() => {});
  })();
  const q = query({
    prompt: idle as AsyncIterable<never>,
    options: {
      cwd,
      ...(claudeBinIsAbsolute() ? { pathToClaudeCodeExecutable: resolveClaudeBin() } : {}),
    },
  });
  // 後台空轉消費(控制協議響應不依賴迭代,但別讓內部緩衝積壓);close 後自然結束。
  void (async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of q as AsyncIterable<unknown>) {
      /* drain */
    }
  })().catch(() => {});
  try {
    const cmds = (await q.supportedCommands()) as unknown[];
    return toCommandInfos(cmds);
  } finally {
    try {
      (q as { close?: () => void }).close?.();
    } catch {
      /* 進程已死也無妨 */
    }
  }
}

/** #199 上報器:緩存最新清單,啟動枚舉 + ready 重發 + commands_changed 整份替換。 */
export class CommandsReporter {
  private cache: CommandInfo[] | null = null;

  constructor(private readonly linkb: LinkBClient) {}

  /** 啟動:掛 ready 重發鉤子 + 枚舉一次。枚舉失敗只缺菜單,不影響其他功能——別讓它拖垮啟動。 */
  async start(cwd: string): Promise<void> {
    this.linkb.onReady(() => this.push());
    try {
      this.cache = await enumerateCommands(cwd);
      console.log(`· #199 命令枚舉:${this.cache.length} 條(cwd=${cwd})`);
    } catch (e) {
      console.error(`[#199 命令枚舉失敗(/菜單缺席,其餘功能不受影響)] ${(e as Error).message}`);
      return;
    }
    this.push();
  }

  /** live 通道的 `system/commands_changed` 載荷 → 整份替換 + 立即上報。 */
  update(cmds: unknown[]): void {
    this.cache = toCommandInfos(cmds);
    console.log(`· #199 commands_changed → ${this.cache.length} 條`);
    this.push();
  }

  private push(): void {
    if (!this.cache) return;
    this.linkb.send({ t: "commands", agentLinkId: this.linkb.agentLinkId, commands: this.cache });
  }
}
