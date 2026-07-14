import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectImportSessions, groupProjects } from "../src/cc/history-import";

/** #154 按 project 導入:分組計數 + project 派生(cwd 優先,回退目錄 slug)。 */

describe("#154 groupProjects", () => {
  it("聚合計數、數量降序", () => {
    const out = groupProjects([{ project: "/a" }, { project: "/b" }, { project: "/b" }]);
    expect(out).toEqual([
      { name: "/b", count: 2 },
      { name: "/a", count: 1 },
    ]);
  });
});

describe("#154 collectImportSessions.project", () => {
  it("project 取 transcript 條目的 cwd", () => {
    const cfg = mkdtempSync(join(tmpdir(), "cc-imp-"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    const dir = join(cfg, "projects", "-opt-proj");
    mkdirSync(dir, { recursive: true });
    const line = (o: any) => JSON.stringify(o) + "\n";
    writeFileSync(
      join(dir, "6966afc5-2dca-477d-a987-848421d25199.jsonl"),
      line({ type: "user", uuid: "00000000-0000-4000-8000-000000000001", cwd: "/opt/proj", timestamp: "2026-07-14T00:00:00Z", message: { role: "user", content: "hi" } }),
    );
    const built = collectImportSessions();
    expect(built).toHaveLength(1);
    expect(built[0]!.project).toBe("/opt/proj");
  });
});
