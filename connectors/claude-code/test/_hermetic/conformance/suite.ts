/**
 * #303 共享 conformance suite：一份契約 × 各家 adapter 枚舉。
 * 由各連接器 test/conformance.test.ts 調用 defineConformanceSuite(adapter)。
 */
import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import {
  assertPathIsSandboxed,
  getRealHome,
  getSandboxHome,
  isCredentialEnvKey,
} from "../index";
import { assertTuiEventEnvelope, eventsOfType, extractTuiEvents } from "./frames";
import {
  assertClarifyRequestPayload,
  assertMessageCompletePayload,
  assertTaskStartPayload,
  assertTurnUsagePayload,
} from "./payloads";
import type { ConformanceAdapter } from "./types";

/**
 * 掛載共享契約測試到當前 vitest 套件。
 * caps=false 的能力不註冊用例（避免 skip 堆積進護欄預算）；
 * 缺 collector 而 caps=true 時 fail-closed（寫 adapter 漏了會紅）。
 */
export function defineConformanceSuite(adapter: ConformanceAdapter): void {
  describe(`#303 conformance:${adapter.name}`, () => {
    it("hermetic: HOME 沙箱 + TZ=UTC（不觸真 ~/.macchiato）", () => {
      const home = homedir();
      expect(home).toBe(getSandboxHome());
      expect(home).not.toBe(getRealHome());
      expect(process.env.TZ).toBe("UTC");
      // 默認 macchiato / claude 路徑必落沙箱
      assertPathIsSandboxed(`${home}/.macchiato`);
      assertPathIsSandboxed(`${home}/.claude`);
    });

    it("hermetic: 宿主憑證形 env 不應在 setup 後殘留（抽樣常見 key）", () => {
      // setup 已 scrub；測試過程中個別用例可能再 set——這裡只抽樣「不該被宿主注入」的常見 key
      // 若本用例開始前它們非空，說明 setup 沒掛上或被全局污染
      const hostLeaks = [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "DEMO_STT_API_KEY",
        "STT_API_KEY",
      ];
      for (const k of hostLeaks) {
        expect(process.env[k], `${k} should be scrubbed by hermetic setup`).toBeUndefined();
      }
      // 謂詞自洽
      expect(isCredentialEnvKey("ANTHROPIC_API_KEY")).toBe(true);
      expect(isCredentialEnvKey("PATH")).toBe(false);
    });

    if (adapter.caps.turnUsage) {
      it("turn.usage 契約:信封 + 非負 output_tokens", async () => {
        if (!adapter.collectTurn) {
          throw new Error(`${adapter.name}: caps.turnUsage=true but collectTurn missing`);
        }
        const sent = await adapter.collectTurn();
        const usages = eventsOfType(sent, "turn.usage");
        expect(usages.length, "expected ≥1 turn.usage").toBeGreaterThanOrEqual(1);
        for (const ev of usages) {
          assertTuiEventEnvelope(ev);
          assertTurnUsagePayload(ev.payload);
        }
      });
    }

    if (adapter.caps.messageComplete) {
      it("message.complete 契約:信封 + status/usage 形狀", async () => {
        if (!adapter.collectTurn) {
          throw new Error(
            `${adapter.name}: caps.messageComplete=true but collectTurn missing`,
          );
        }
        const sent = await adapter.collectTurn();
        const completes = eventsOfType(sent, "message.complete");
        expect(completes.length, "expected ≥1 message.complete").toBeGreaterThanOrEqual(1);
        for (const ev of completes) {
          assertTuiEventEnvelope(ev);
          assertMessageCompletePayload(ev.payload);
        }
        // 至少有一條帶 text 或 status（回合定稿信號）——不斷言具體文案
        expect(
          completes.some(
            (e) => typeof e.payload.text === "string" || typeof e.payload.status === "string",
          ),
        ).toBe(true);
      });
    }

    if (adapter.caps.clarify) {
      it("clarify.request 契約:request_id + question + choices", async () => {
        if (!adapter.collectClarify) {
          throw new Error(`${adapter.name}: caps.clarify=true but collectClarify missing`);
        }
        const sent = await adapter.collectClarify();
        const reqs = eventsOfType(sent, "clarify.request");
        expect(reqs.length, "expected ≥1 clarify.request").toBeGreaterThanOrEqual(1);
        for (const ev of reqs) {
          assertTuiEventEnvelope(ev);
          assertClarifyRequestPayload(ev.payload);
        }
      });
    }

    if (adapter.caps.backgroundTask) {
      it("task.start 契約:task_id + kind + desc", async () => {
        if (!adapter.collectBackgroundTask) {
          throw new Error(
            `${adapter.name}: caps.backgroundTask=true but collectBackgroundTask missing`,
          );
        }
        const sent = await adapter.collectBackgroundTask();
        const starts = eventsOfType(sent, "task.start");
        expect(starts.length, "expected ≥1 task.start").toBeGreaterThanOrEqual(1);
        for (const ev of starts) {
          assertTuiEventEnvelope(ev);
          assertTaskStartPayload(ev.payload);
        }
      });
    }

    it("出站 tui event 全量信封可解析（無殘缺 frame）", async () => {
      // 若 adapter 提供 collector，順便跑一輪做信封衛生檢查；否則只測 extract 空列表不炸
      if (!adapter.collectTurn) {
        expect(extractTuiEvents([])).toEqual([]);
        return;
      }
      const sent = await adapter.collectTurn();
      const evs = extractTuiEvents(sent);
      for (const ev of evs) {
        assertTuiEventEnvelope(ev);
      }
    });
  });
}
