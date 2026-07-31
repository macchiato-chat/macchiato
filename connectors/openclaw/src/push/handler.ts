/**
 * §17 主動投遞：本地 unix socket 收 OpenClaw macchiato channel 插件的投遞請求 → connector_push。
 * 線協議與 Hermes 版一致：請求一行 JSON `{chatId, text, replyTo?, metadata?}`, 回 ack 一行
 * `{ok, pushId?|error, retryable?}`。socket: ~/.macchiato/openclaw-push.sock（0600, 與 Hermes 的分開）。
 */
import { existsSync, unlinkSync, chmodSync, mkdirSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { E2EKeyStore } from "../_core/e2e/keys";
import type { LinkBClient } from "../_core/linkb/client";
import { keyForSid } from "../openclaw/mirror";

export function pushSockPath(): string {
  return process.env.MACCHIATO_OPENCLAW_PUSH_SOCK || join(homedir(), ".macchiato/openclaw-push.sock");
}

export class PushHandler {
  private server: Server | null = null;
  private pushSeq = 0;
  /** #380 換行前硬字節上限——失陷/惡意本地客戶端不得無限累積。 */
  static readonly MAX_LINE_BYTES = 1 * 1024 * 1024;

  constructor(
    private readonly linkb: LinkBClient,
    private readonly e2e: E2EKeyStore,
  ) {}

  private isProtectedTarget(chatId: string): boolean {
    if (this.e2e.isE2E(chatId) || this.e2e.isE2E(`macchiato:${chatId}`)) return true;
    const target = chatId.trim().toLowerCase();
    const protectedIds = this.e2e.protectedSessionIds();
    return protectedIds.some((sid) => {
      const wire = sid.toLowerCase();
      return (
        target === wire ||
        target === keyForSid(sid).toLowerCase() ||
        `macchiato:${target}` === wire
      );
    });
  }

  start(): void {
    const path = pushSockPath();
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) unlinkSync(path); // 上次殘留
    this.server = createServer((sock) => this.handle(sock));
    this.server.listen(path, () => {
      chmodSync(path, 0o600);
      console.log(`· Push socket listening (${path})`);
    });
    this.server.on("error", (e) => console.error("push socket error:", e.message));
  }

  stop(): void {
    this.server?.close();
    try {
      unlinkSync(pushSockPath());
    } catch {
      /* ignore */
    }
  }

  private handle(sock: Socket): void {
    let buf = Buffer.alloc(0);
    let settled = false;
    const reply = (ack: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      sock.write(JSON.stringify(ack) + "\n");
      sock.end();
    };
    sock.setTimeout(10000, () => reply({ ok: false, error: "timeout" }));
    sock.on("data", (d) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(d) ? d : Buffer.from(d);
      if (buf.length + chunk.length > PushHandler.MAX_LINE_BYTES) {
        return reply({ ok: false, error: "line too large" });
      }
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      let req: Record<string, unknown>;
      try {
        req = JSON.parse(buf.subarray(0, nl).toString("utf8"));
      } catch {
        return reply({ ok: false, error: "bad json" });
      }
      const chatId = String(req.chatId ?? "");
      const text = String(req.text ?? "");
      if (!chatId || !text) return reply({ ok: false, error: "missing chatId/text" });
      if (this.isProtectedTarget(chatId)) {
        // connector_push 只有明文 text；目的會話（含 server inbox fallback sid）
        // 受 E2E 保護時必須在本機拒絕，不能先把正文交給 server。
        return reply({ ok: false, error: "E2E push unsupported" });
      }
      if (!this.linkb.isReady) return reply({ ok: false, error: "link B down", retryable: true });
      this.pushSeq += 1;
      const msg: Record<string, unknown> = {
        t: "connector_push",
        agentLinkId: this.linkb.agentLinkId,
        chatId,
        text,
        pushId: this.pushSeq,
      };
      if (req.replyTo) msg.replyTo = req.replyTo;
      if (req.metadata) msg.metadata = req.metadata;
      this.linkb.send(msg);
      console.log(`· Push → connector_push #${this.pushSeq} (chatId=${chatId}, ${text.length} chars)`);
      reply({ ok: true, pushId: this.pushSeq });
    });
    sock.on("error", () => {
      /* client 斷開等 */
    });
  }
}
