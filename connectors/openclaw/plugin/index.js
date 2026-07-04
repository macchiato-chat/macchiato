/**
 * Macchiato channel plugin for OpenClaw（§17 主動投遞）。
 * OpenClaw 對 channel "macchiato" 的出站消息 → 本地 unix socket → macchiato 連接器 →
 * connector_push → Macchiato app 的「主動消息」。線協議：一行 JSON {chatId,text} → ack 行。
 * 安裝：openclaw plugins install <此目錄>；需要 macchiato-openclaw-connector 在跑（socket 才在）。
 */
import { createChatChannelPlugin, createChannelPluginBase, defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const SOCK = process.env.MACCHIATO_OPENCLAW_PUSH_SOCK || join(homedir(), ".macchiato/openclaw-push.sock");
const TIMEOUT_MS = 10000;

function pushToConnector(chatId, text) {
  return new Promise((resolve, reject) => {
    const sock = connect(SOCK);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("macchiato connector timeout（連接器沒在跑？）"));
    }, TIMEOUT_MS);
    sock.on("connect", () => sock.write(JSON.stringify({ chatId, text }) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      try {
        const ack = JSON.parse(buf.slice(0, nl));
        if (ack.ok) resolve(ack);
        else reject(new Error(ack.error || "macchiato push failed"));
      } catch (e) {
        reject(e);
      }
      sock.end();
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`macchiato connector unreachable: ${e.message}`));
    });
  });
}

function resolveAccount(cfg, accountId) {
  return { accountId: accountId ?? null };
}

const macchiatoPlugin = createChatChannelPlugin({
  base: createChannelPluginBase({
    id: "macchiato",
    // registry 硬性要求 config.listAccountIds + config.resolveAccount（零配置：單默認賬號）
    config: {
      listAccountIds: () => ["default"],
      resolveAccount,
      defaultAccountId: () => "default",
    },
    setup: {
      resolveAccount,
      inspectAccount(cfg) {
        const section = cfg.channels?.macchiato;
        return {
          enabled: section?.enabled !== false,
          configured: true, // 零配置渠道：連接器在則通
          tokenStatus: "available",
        };
      },
    },
  }),
  outbound: {
    attachedResults: {
      sendText: async (params) => {
        const ack = await pushToConnector(params.to || "home", params.text ?? "");
        return { messageId: String(ack.pushId ?? "0") };
      },
    },
  },
});

export default defineChannelPluginEntry({
  id: "macchiato",
  name: "Macchiato",
  description: "Deliver proactive messages to the Macchiato app via the local connector",
  plugin: macchiatoPlugin,
});
