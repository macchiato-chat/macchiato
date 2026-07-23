/**
 * #317 codex skills 枚舉與上報:composer `/` 菜單的數據源(#199 通用兩幀,codex 補位——
 * 當年可行性表只調研了 CC/Hermes/OpenClaw,codex 被誤歸「無此能力」;0.144.1 探針證僞)。
 * 權威源 = app-server `skills/list`(裸調即通,無需 experimental opt-in;cwds=[workDir()],
 * 對齊 CC 的 agent-link 級清單已知限制——project skills 隨會話 cwd 變不反映,#199 記錄)。
 * 保鮮:`skills/changed` 通知(schema 原文:失效信號 → 重跑 skills/list;去抖防 watcher 連發)
 * + 每次 Link B ready 重發(server 重啟丟內存緩存)。
 * exec 引擎無 skills 面 → 上報空(清 server 陳舊緩存、菜單不出;對齊 #231 models 語義)。
 * 另備 name→SKILL.md 路徑索引,供 drive 把 command.invoke 組成原生 SkillUserInput。
 */
import type { CommandInfo } from "../linkb/proto";
import type { AppServerClient } from "./appserver";
import type { LinkBClient } from "../linkb/client";
import { workDir } from "./drive";

const DESC_MAX = 200;
const CHANGED_DEBOUNCE_MS = 300;

/** skills/list 的 data(SkillsListEntry[])→ 菜單清單 + 調用索引。多 cwd 同名取首見。 */
export function parseSkills(data: unknown[]): { commands: CommandInfo[]; paths: Map<string, string> } {
  const commands: CommandInfo[] = [];
  const paths = new Map<string, string>();
  for (const rawEntry of data ?? []) {
    const entry = (rawEntry ?? {}) as Record<string, unknown>;
    for (const raw of Array.isArray(entry.skills) ? entry.skills : []) {
      const s = (raw ?? {}) as Record<string, unknown>;
      if (s.enabled === false) continue; // 用戶禁用的不進菜單
      const name = String(s.name ?? "").trim();
      if (!name || paths.has(name)) continue;
      const iface = (s.interface ?? {}) as Record<string, unknown>;
      // 菜單友好度:interface.shortDescription(一句話)> 遺留 shortDescription > description(模型向長文)。
      const description = String(iface.shortDescription ?? s.shortDescription ?? s.description ?? "")
        .trim()
        .slice(0, DESC_MAX);
      const source = String(s.scope ?? "").trim(); // user/system/project…(client 據此分組)
      paths.set(name, String(s.path ?? ""));
      commands.push({ name, ...(description ? { description } : {}), ...(source ? { source } : {}) });
    }
  }
  return { commands, paths };
}

/** #317 上報器:app-server 有 client → skills/list;changed 去抖重列;ready 重發。exec → 空一次。 */
export class SkillsReporter {
  private cache: CommandInfo[] = [];
  private paths = new Map<string, string>();
  private changedTimer?: NodeJS.Timeout;

  constructor(
    private readonly linkb: LinkBClient,
    private readonly client?: AppServerClient,
  ) {}

  /** drive 的 command.invoke 據此組 SkillUserInput(名→SKILL.md 絕對路徑)。 */
  pathFor(name: string): string | undefined {
    return this.paths.get(name);
  }

  async start(): Promise<void> {
    this.linkb.onReady(() => this.push());
    if (!this.client) {
      this.push(); // exec:上報空,清掉 server 可能殘留的 app-server 期緩存(否則降級後菜單陳舊)
      return;
    }
    this.client.onNotification((m) => {
      if (m !== "skills/changed") return;
      clearTimeout(this.changedTimer);
      this.changedTimer = setTimeout(() => void this.refresh("skills/changed"), CHANGED_DEBOUNCE_MS);
    });
    await this.refresh("啟動");
  }

  /** 重列 + 上報。失敗只缺菜單(推既有緩存,啟動期即空),不影響其他功能。 */
  private async refresh(why: string): Promise<void> {
    try {
      const res = await this.client!.request("skills/list", { cwds: [workDir()] });
      const parsed = parseSkills(Array.isArray(res?.data) ? res.data : []);
      this.cache = parsed.commands;
      this.paths = parsed.paths;
      console.log(`· #317 codex skills 枚舉(${why}):${parsed.commands.length} 個`);
    } catch (e) {
      console.error(`[#317 skills/list 失敗(/菜單缺席,其餘功能不受影響)] ${(e as Error).message}`);
    }
    this.push();
  }

  private push(): void {
    this.linkb.send({ t: "commands", agentLinkId: this.linkb.agentLinkId, commands: this.cache });
  }
}
