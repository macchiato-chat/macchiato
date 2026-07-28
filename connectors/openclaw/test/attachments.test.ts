import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import {
  DOWNLOAD_MAX,
  _resetAttachInflightForTest,
  _setAttachInflightForTest,
  attachInflightCount,
  fetchChatAttachment,
  isPrivateIp,
  pinnedLookup,
  validateDownloadUrl,
} from "../src/openclaw/attachments";

const LOCAL_ENV_KEYS = [
  "MACCHIATO_ATTACH_ALLOW_LOCALHOST",
  "MACCHIATO_ATTACH_LOCAL_PORT",
  "MACCHIATO_ATTACH_LOCAL_PATH_PREFIX",
] as const;

function clearLocalAttachEnv() {
  for (const k of LOCAL_ENV_KEYS) delete process.env[k];
}

function allowLocalPort(port: number) {
  process.env.MACCHIATO_ATTACH_ALLOW_LOCALHOST = "1";
  process.env.MACCHIATO_ATTACH_LOCAL_PORT = String(port);
  process.env.MACCHIATO_ATTACH_LOCAL_PATH_PREFIX = "";
}

afterEach(() => {
  clearLocalAttachEnv();
  _resetAttachInflightForTest();
});

describe("openclaw SSRF 防護(#249/#270/#379)", () => {
  it("isPrivateIp:私網/環回/link-local/雲元數據 → true;公網 → false", () => {
    for (const ip of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "192.168.1.1", "172.16.0.1", "::1", "fd00::1"])
      expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ["1.1.1.1", "8.8.8.8", "93.184.216.34"]) expect(isPrivateIp(ip), ip).toBe(false);
  });

  it("validateDownloadUrl:生產默認拒 file/ftp/data/http/loopback、私網 https", async () => {
    clearLocalAttachEnv();
    for (const bad of [
      "file:///etc/passwd",
      "ftp://x/y",
      "data:text/plain,hi",
      "http://evil.com/x",
      "http://localhost:8080/attachments/x",
      "http://127.0.0.1:8080/attachments/x",
      "http://[::1]:8080/attachments/x",
      "http://0.0.0.0:8080/attachments/x",
      "https://169.254.169.254/x",
      "https://127.0.0.1/x",
      "https://10.0.0.5/x",
    ])
      await expect(validateDownloadUrl(bad), bad).rejects.toThrow();
  });

  it("validateDownloadUrl:dev env 下放行 http→loopback；錯 port/path/userinfo 仍拒", async () => {
    process.env.MACCHIATO_ATTACH_ALLOW_LOCALHOST = "1";
    for (const ok of [
      "http://localhost:8080/attachments/raw?k=1",
      "http://127.0.0.1:8080/attachments/x",
      "http://[::1]:8080/attachments",
    ])
      await expect(validateDownloadUrl(ok), ok).resolves.toBeUndefined();

    for (const bad of [
      "http://localhost/attachments/x",
      "http://localhost:9/attachments/x",
      "http://localhost:8080/other/x",
      "http://evil@127.0.0.1:8080/attachments/x",
      "http://0.0.0.0:8080/attachments/x",
      "https://localhost:8080/attachments/x",
    ])
      await expect(validateDownloadUrl(bad), bad).rejects.toThrow();

    process.env.MACCHIATO_ATTACH_LOCAL_PORT = "9999";
    process.env.MACCHIATO_ATTACH_LOCAL_PATH_PREFIX = "/media";
    await expect(validateDownloadUrl("http://127.0.0.1:9999/media/a")).resolves.toBeUndefined();
    await expect(validateDownloadUrl("http://127.0.0.1:8080/media/a")).rejects.toThrow();
  });

  it("#249 pinnedLookup:解析到私網 IP → 拒(連接時校驗實際 IP,防 rebinding TOCTOU)", async () => {
    // localhost 必解析到環回 = 私網 → pinnedLookup 應報錯
    await expect(
      new Promise<string>((resolve, reject) => pinnedLookup("localhost", {}, (err, addr) => (err ? reject(err) : resolve(addr)))),
    ).rejects.toThrow(/私網|SSRF/);
    // 字面公網 IP → 原樣放行
    const addr = await new Promise<string>((resolve, reject) =>
      pinnedLookup("1.1.1.1", {}, (err, a) => (err ? reject(err) : resolve(a))),
    );
    expect(addr).toBe("1.1.1.1");
  });
});


describe("#383 openclaw 附件流式/配額/並發", () => {
  afterEach(() => {
    _resetAttachInflightForTest();
    delete process.env.MACCHIATO_OPENCLAW_ATTACH_MAX_INFLIGHT;
  });

  function listen(
    handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
  ): Promise<{ port: number; close: () => Promise<void> }> {
    const srv = createServer(handler);
    return new Promise((resolve) => {
      srv.listen(0, "127.0.0.1", () => {
        const port = (srv.address() as { port: number }).port;
        resolve({
          port,
          close: () =>
            new Promise((r, j) => {
              srv.close((e) => (e ? j(e) : r()));
            }),
        });
      });
    });
  }

  it("正常下載 → base64 content", async () => {
    const payload = Buffer.from("openclaw-body");
    const { port, close } = await listen((_q, res) => {
      res.setHeader("content-length", String(payload.length));
      res.end(payload);
    });
    allowLocalPort(port);
    try {
      const att = await fetchChatAttachment({ id: "a", name: "f.txt", mime: "text/plain", url: `http://127.0.0.1:${port}/f.txt` });
      expect(att.fileName).toBe("f.txt");
      expect(att.mimeType).toBe("text/plain");
      expect(Buffer.from(att.content, "base64")).toEqual(payload);
    } finally {
      await close();
    }
  });

  it("Content-Length 超 DOWNLOAD_MAX → 早拒", async () => {
    const { port, close } = await listen((_q, res) => {
      res.setHeader("content-length", String(DOWNLOAD_MAX + 1));
      res.end(Buffer.alloc(8));
    });
    allowLocalPort(port);
    try {
      await expect(fetchChatAttachment({ id: "b", name: "big", url: `http://127.0.0.1:${port}/big` })).rejects.toThrow(
        /Content-Length/,
      );
      expect(attachInflightCount()).toBe(0);
    } finally {
      await close();
    }
  });

  it("流式超限(無 CL) → 拒", async () => {
    const { port, close } = await listen((_q, res) => {
      const chunk = Buffer.alloc(1024 * 1024, 0xcd);
      const n = Math.floor(DOWNLOAD_MAX / chunk.length) + 2;
      res.writeHead(200);
      let i = 0;
      const pump = () => {
        while (i < n) {
          i += 1;
          if (!res.write(chunk)) {
            res.once("drain", pump);
            return;
          }
        }
        res.end();
      };
      pump();
    });
    allowLocalPort(port);
    try {
      await expect(fetchChatAttachment({ id: "c", name: "huge", url: `http://127.0.0.1:${port}/huge` })).rejects.toThrow(
        /超過上限/,
      );
      expect(attachInflightCount()).toBe(0);
    } finally {
      await close();
    }
  }, 30_000);

  it("並發達上限 → 拒絕", async () => {
    process.env.MACCHIATO_OPENCLAW_ATTACH_MAX_INFLIGHT = "1";
    _setAttachInflightForTest(1);
    try {
      await expect(fetchChatAttachment({ id: "i2", name: "b", url: (allowLocalPort(9), "http://127.0.0.1:9/b") })).rejects.toThrow(/並發/);
      expect(attachInflightCount()).toBe(1);
    } finally {
      _resetAttachInflightForTest();
    }
  });
});
