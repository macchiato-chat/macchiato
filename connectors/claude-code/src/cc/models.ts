/**
 * #231 model 清單上報:喂 client 的 model chip + effort chip(動態,絕不硬編碼別名/檔位)。
 * 權威源 = SDK `Query.supportedModels()`(每個 ModelInfo 帶 value/displayName/description +
 * supportsEffort/supportedEffortLevels)。與 #199 命令枚舉同機制:短命 query 枚舉、ready 重發。
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelOption } from "../linkb/proto";
import type { LinkBClient } from "../linkb/client";
import { claudeBinIsAbsolute, resolveClaudeBin } from "./claude-bin";

/** #553 CC 的 effort 默認由產品定為 high(SDK ModelInfo 無上游真值;drive.resolveEffort 真下發同值)。 */
export const CC_DEFAULT_EFFORT = "high";

/** SDK ModelInfo[] → 協議 ModelOption[](effortLevels 僅在 supportsEffort 時帶)。
 *  #542 帶 resolvedId(=ModelInfo.resolvedModel,client 匹配持久化串的兜底);
 *  #553 支持 effort 的行帶 defaultEffort=high;並把 value="default" 行的 resolvedModel 對回
 *  具體別名行標 isDefault——client 據此去掉「Default」菜單項、空 model 顯具體默認。 */
export function toModelOptions(models: unknown[]): ModelOption[] {
  const out: ModelOption[] = [];
  let defaultResolved = "";
  for (const raw of models ?? []) {
    const m = (raw ?? {}) as Record<string, unknown>;
    // value = 傳給 session.model 的別名/id(supportedModels 的 value);缺則跳過。
    const id = String(m.value ?? "").trim();
    if (!id) continue;
    const label = String(m.displayName ?? id).trim();
    const description = String(m.description ?? "").trim();
    const resolved = String(m.resolvedModel ?? "").trim();
    if (id === "default" && resolved) defaultResolved = resolved;
    const levels = m.supportsEffort === true && Array.isArray(m.supportedEffortLevels)
      ? (m.supportedEffortLevels as unknown[]).map((x) => String(x)).filter(Boolean)
      : undefined;
    out.push({
      id,
      label,
      ...(description ? { description: description.slice(0, 200) } : {}),
      ...(levels && levels.length ? { effortLevels: levels, defaultEffort: CC_DEFAULT_EFFORT } : {}),
      ...(resolved ? { resolvedId: resolved } : {}),
    });
  }
  // default 行解析到的 wire id 對回第一個具體別名行 = 連接器實際默認跑的 model。
  // 對不上(清單漂移/無 default 行)→ 不標,client 誠實回退保留「Default」項。
  if (defaultResolved) {
    const hit = out.find((o) => o.id !== "default" && o.resolvedId === defaultResolved);
    if (hit) hit.isDefault = true;
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

  /**
   * #553 當前 model 是否支持 effort(drive.resolveEffort 兜底 high 的閘——不支持的 model 下發
   * effort 可能報錯,chip 本來也不顯)。匹配層級與 client 一致:id → resolvedId → label 忽略大小寫;
   * model 空 = 連接器默認 → 看 "default" 行。清單未就緒(枚舉失敗/未完成)→ false(不兜底,舊行為)。
   */
  supportsEffort(model: string | undefined): boolean {
    const list = this.cache;
    if (!list?.length) return false;
    const want = (model ?? "").trim();
    const row = !want
      ? (list.find((o) => o.id === "default") ?? list.find((o) => o.isDefault))
      : (list.find((o) => o.id === want) ??
        list.find((o) => !!o.resolvedId && o.resolvedId === want) ??
        list.find((o) => o.label.trim().toLowerCase() === want.toLowerCase()));
    return !!row?.effortLevels?.length;
  }

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
