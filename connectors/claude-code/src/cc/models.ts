/**
 * #231 model 清單上報:喂 client 的 model chip + effort chip(動態,絕不硬編碼別名/檔位)。
 * 權威源 = SDK `Query.supportedModels()`(每個 ModelInfo 帶 value/displayName/description +
 * supportsEffort/supportedEffortLevels)。與 #199 命令枚舉同機制:短命 query 枚舉、ready 重發。
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelOption } from "../linkb/proto";
import type { LinkBClient } from "../linkb/client";
import { claudeBinIsAbsolute, resolveClaudeBin } from "./claude-bin";

/** SDK ModelInfo[] → 協議 ModelOption[](effortLevels 僅在 supportsEffort 時帶)。 */
export function toModelOptions(models: unknown[]): ModelOption[] {
  const out: ModelOption[] = [];
  for (const raw of models ?? []) {
    const m = (raw ?? {}) as Record<string, unknown>;
    // value = 傳給 session.model 的別名/id(supportedModels 的 value);缺則跳過。
    const id = String(m.value ?? "").trim();
    if (!id) continue;
    const label = String(m.displayName ?? id).trim();
    const description = String(m.description ?? "").trim();
    const levels = m.supportsEffort === true && Array.isArray(m.supportedEffortLevels)
      ? (m.supportedEffortLevels as unknown[]).map((x) => String(x)).filter(Boolean)
      : undefined;
    out.push({
      id,
      label,
      ...(description ? { description: description.slice(0, 200) } : {}),
      ...(levels && levels.length ? { effortLevels: levels } : {}),
    });
  }
  return out;
}

/** 短命 query 枚舉 supportedModels()(同 enumerateCommands),拿到即 close。 */
export async function enumerateModels(cwd: string): Promise<ModelOption[]> {
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
  void (async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of q as AsyncIterable<unknown>) {
      /* drain */
    }
  })().catch(() => {});
  try {
    const models = (await q.supportedModels()) as unknown[];
    return toModelOptions(models);
  } finally {
    try {
      (q as { close?: () => void }).close?.();
    } catch {
      /* 進程已死也無妨 */
    }
  }
}

/** #231 上報器:啟動枚舉 + ready 重發(server 重啟丟緩存)。失敗只缺動態清單(client 回退硬編碼)。 */
export class ModelsReporter {
  private cache: ModelOption[] | null = null;
  constructor(private readonly linkb: LinkBClient) {}

  async start(cwd: string): Promise<void> {
    this.linkb.onReady(() => this.push());
    try {
      this.cache = await enumerateModels(cwd);
      console.log(`· #231 model 枚舉:${this.cache.length} 個(cwd=${cwd})`);
    } catch (e) {
      console.error(`[#231 model 枚舉失敗(chip 回退硬編碼,其餘不受影響)] ${(e as Error).message}`);
      return;
    }
    this.push();
  }

  private push(): void {
    if (!this.cache) return;
    this.linkb.send({ t: "models", agentLinkId: this.linkb.agentLinkId, models: this.cache });
  }
}
