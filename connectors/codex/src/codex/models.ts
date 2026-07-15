/**
 * #231 codex model 清單上報:喂 client model/effort chip(動態,不硬編碼)。
 * app-server `model/list` → Model[](id/model/displayName/description + supportedReasoningEfforts +
 * defaultReasoningEffort;hidden 過濾)。exec 引擎無 model/list → 上報空(client 回退自由輸入)。
 */
import type { ModelOption } from "../linkb/proto";
import type { AppServerClient } from "./appserver";
import type { LinkBClient } from "../linkb/client";

/** codex Model[] → ModelOption[]。 */
export function toModelOptions(data: unknown[]): ModelOption[] {
  const out: ModelOption[] = [];
  for (const raw of data ?? []) {
    const m = (raw ?? {}) as Record<string, unknown>;
    if (m.hidden === true) continue;
    const id = String(m.id ?? m.model ?? "").trim();
    if (!id) continue;
    const label = String(m.displayName ?? id).trim();
    const description = String(m.description ?? "").trim();
    const efforts = Array.isArray(m.supportedReasoningEfforts)
      ? (m.supportedReasoningEfforts as unknown[])
          .map((o) => String((o as Record<string, unknown>)?.reasoningEffort ?? "").trim())
          .filter(Boolean)
      : [];
    const def = String(m.defaultReasoningEffort ?? "").trim();
    out.push({
      id,
      label,
      ...(description ? { description: description.slice(0, 200) } : {}),
      ...(efforts.length ? { effortLevels: efforts } : {}),
      ...(def ? { defaultEffort: def } : {}),
    });
  }
  return out;
}

/** #231 上報器:app-server 有 client → model/list;ready 重發。exec(無 client)→ 上報空一次。 */
export class ModelsReporter {
  private cache: ModelOption[] = [];
  constructor(
    private readonly linkb: LinkBClient,
    private readonly client?: AppServerClient,
  ) {}

  async start(): Promise<void> {
    this.linkb.onReady(() => this.push());
    if (this.client) {
      try {
        const res = await this.client.request("model/list", {});
        this.cache = toModelOptions(Array.isArray(res?.data) ? res.data : []);
        console.log(`· #231 codex model 枚舉:${this.cache.length} 個`);
      } catch (e) {
        console.error(`[#231 model/list 失敗(chip 回退自由輸入)] ${(e as Error).message}`);
      }
    }
    this.push();
  }

  private push(): void {
    this.linkb.send({ t: "models", agentLinkId: this.linkb.agentLinkId, models: this.cache });
  }
}
