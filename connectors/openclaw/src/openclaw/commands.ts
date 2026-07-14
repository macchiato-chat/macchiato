/**
 * #199 命令/技能枚舉與上報:composer `/` 菜單的數據源。
 * 權威源 = gateway RPC `skills.status {agentId}`(operator.read 只讀;**必須傳 agentId**,
 * 不傳拿 default view 漏 per-agent 過濾),篩 `commandVisible===true`(= eligible && 未被
 * agent filter 擋 && userInvocable,即「此刻可手動調」——Linux 上近半 skill 是 macOS-only,
 * 全靠這個標誌濾)。勿 dir-walk(拿不到 eligibility 會多報;core skills 在 npm install 內,
 * 升級後路徑變)。真機 2026-07-14:59 skills → 29 條 commandVisible。
 * 上報時機:gateway 每次連上(升級後 skill 集可能變)+ Link B 每次 ready(server 重啟丟緩存)。
 */
import type { CommandInfo } from "../linkb/proto";
import type { OpenClawGateway } from "./gateway";
import type { LinkBClient } from "../linkb/client";

const DESC_MAX = 200;

/** 驅動的 agent id(對齊 mirror MACCHIATO_PREFIX 的 agent:main:);多 agent 部署可 env 覆蓋。 */
export function agentId(): string {
  return process.env.MACCHIATO_OPENCLAW_AGENT_ID || "main";
}

/** skills.status 的 skills[] → 協議 CommandInfo[](只留 commandVisible;截描述;emoji 拼進描述前綴)。 */
export function toCommandInfos(skills: unknown[]): CommandInfo[] {
  const out: CommandInfo[] = [];
  for (const raw of skills ?? []) {
    const s = (raw ?? {}) as Record<string, unknown>;
    if (s.commandVisible !== true) continue;
    const name = String(s.name ?? "").trim();
    if (!name) continue;
    const emoji = String(s.emoji ?? "").trim();
    const desc = String(s.description ?? "").trim();
    const description = `${emoji ? emoji + " " : ""}${desc}`.trim().slice(0, DESC_MAX);
    const source = String(s.source ?? "").trim();
    out.push({ name, ...(description ? { description } : {}), ...(source ? { source } : {}) });
  }
  return out;
}

/** #199 上報器:gateway 連上刷新,Link B ready 重發緩存。失敗只缺菜單,靜默降級。 */
export class CommandsReporter {
  private cache: CommandInfo[] | null = null;

  constructor(
    private readonly gw: OpenClawGateway,
    private readonly linkb: LinkBClient,
  ) {}

  start(): void {
    this.gw.onConnected(() => void this.refresh());
    this.linkb.onReady(() => this.push());
    void this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      const res = await this.gw.request("skills.status", { agentId: agentId() });
      const skills = Array.isArray(res?.skills) ? res.skills : [];
      this.cache = toCommandInfos(skills);
      console.log(`· #199 命令枚舉:${skills.length} skills → ${this.cache.length} 條 commandVisible`);
      this.push();
    } catch (e) {
      console.error(`[#199 skills.status 失敗(/菜單缺席,其餘不受影響)] ${(e as Error).message}`);
    }
  }

  private push(): void {
    if (!this.cache) return;
    this.linkb.send({ t: "commands", agentLinkId: this.linkb.agentLinkId, commands: this.cache });
  }
}
