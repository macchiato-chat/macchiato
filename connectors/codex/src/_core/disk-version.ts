/**
 * #768 安裝目錄上的連接器版本（進程內 CONNECTOR_VERSION 之外）。
 *
 * 手點 self_update 後，install.sh 先把新版落到磁盤，systemd/launchd 再換進程。
 * 中間這段窗口：進程仍報舊 `connectorVersion`，但磁盤已是新版。
 * 只比「進程版本變了沒」會把「已裝好、待重啟」和「裝失敗」畫成同一句「更新失敗」。
 *
 * 讀取順序（任一命中即用）：
 *  1. `~/.macchiato/installed-version-<kind>` —— installer 退出 0 時寫入（本進程寫、不依賴佈局）
 *  2. 安裝樹內 vendored `CONNECTOR_VERSION = "x.y.z"`（public 樹的 linkb/proto 或 hermes connector.py）
 *  3. 無 → null（舊連接器 / 開發 monorepo 未裝到 app 樹）
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { stateDir } from "./identity";

const STRICT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** 本地副本：避免 selfupdate ↔ disk-version 環形 import。 */
function parseSemver(version: string): readonly [number, number, number] {
  const m = STRICT.exec(version);
  if (!m) throw new Error(`版本格式不合法:${version}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])] as const;
}

function isSemverLt(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i]! < pb[i]!) return true;
    if (pa[i]! > pb[i]!) return false;
  }
  return false;
}

/** installer 成功後寫的標記（per-kind；與 health 文件同根）。 */
export function installedVersionMarkPath(kind: string): string {
  const safe = kind.replace(/[^a-z0-9._-]+/gi, "_") || "unknown";
  return join(stateDir(), `installed-version-${safe}`);
}

/**
 * 默認安裝樹（install.sh 佈局）。profile 隔離時 STATE_DIR 已偏，hermes 仍是 `$STATE/app`。
 */
export function defaultConnectorAppRoot(kind: string): string {
  const base = stateDir();
  switch (kind) {
    case "claude-code":
      return join(base, "claude-code-app");
    case "codex":
      return join(base, "codex-app");
    case "openclaw":
      return join(base, "openclaw-app");
    case "hermes":
      return join(base, "app");
    default:
      return join(base, `${kind}-app`);
  }
}

/** 從一段文本抽出 CONNECTOR_VERSION = "x.y.z"（TS / Python 同構）。 */
export function parseConnectorVersionFromSource(text: string): string | null {
  const m = text.match(/CONNECTOR_VERSION\s*=\s*["'](\d+\.\d+\.\d+)["']/);
  if (!m?.[1] || !STRICT.test(m[1])) return null;
  try {
    parseSemver(m[1]);
    return m[1];
  } catch {
    return null;
  }
}

function readVersionFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8").trim().split(/\s+/)[0] ?? "";
    if (!STRICT.test(raw)) return null;
    parseSemver(raw);
    return raw;
  } catch {
    return null;
  }
}

function readVersionFromAppTree(appRoot: string): string | null {
  const candidates = [
    join(appRoot, "src", "linkb", "proto.ts"),
    join(appRoot, "linkb", "proto.ts"),
    join(appRoot, "src", "linkb", "proto.js"),
    join(appRoot, "connector.py"),
  ];
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const v = parseConnectorVersionFromSource(readFileSync(p, "utf8"));
      if (v) return v;
    } catch {
      /* 下一個候選 */
    }
  }
  return null;
}

/**
 * #888 只讀**安裝樹自己**的版本，繞開 mark 文件。
 *
 * 為什麼要有這個「繞開」的口子：mark 文件是我們**根據 installer 退出碼**寫下的一句話，
 * 拿它去驗證「installer 到底裝上了沒」等於自證。安裝樹裡的 `CONNECTOR_VERSION` 才是
 * 第一手憑據——它只有真被解包覆蓋才會變。#888 的 installer 半路死掉卻退 0，靠退出碼
 * 判定成功就會寫下一個**永不失效**的假 mark（`readDiskConnectorVersion` 優先讀它），
 * app 從此永久顯示「更新已安裝，等待重啟」而重啟毫無作用。
 *
 * 開發 monorepo 沒有安裝樹 → null（調用方按「不知道」處理，不得當成失敗或成功）。
 */
export function readAppTreeConnectorVersion(kind: string, appRoot?: string): string | null {
  return readVersionFromAppTree(appRoot ?? defaultConnectorAppRoot(kind));
}

/**
 * 讀磁盤上「已安裝」版本。`kind` 用於 mark 文件與默認 app 樹。
 * `appRoot` 可注入（單測 / 非標準佈局）。
 */
export function readDiskConnectorVersion(kind: string, appRoot?: string): string | null {
  const fromMark = readVersionFile(installedVersionMarkPath(kind));
  if (fromMark) return fromMark;
  const root = appRoot ?? defaultConnectorAppRoot(kind);
  return readVersionFromAppTree(root);
}

/**
 * health 上報用：進程版 vs 磁盤版取較新者作 `installedVersion`。
 * 進程已追上（重啟完成）→ 等於 processVersion；磁盤更新 → 磁盤版。
 */
export function reportInstalledVersion(processVersion: string, kind: string, appRoot?: string): string {
  const disk = readDiskConnectorVersion(kind, appRoot);
  if (!disk) return processVersion;
  try {
    // disk > process → 待重啟
    if (isSemverLt(processVersion, disk)) return disk;
  } catch {
    /* 畸形版本當無磁盤 */
  }
  return processVersion;
}

/** installer 退出 0：記下磁盤已是此版（下一次 health 即可判 pending_restart）。 */
export function noteInstalledVersionOnDisk(kind: string, version: string): void {
  try {
    parseSemver(version);
  } catch {
    return;
  }
  const path = installedVersionMarkPath(kind);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
    writeFileSync(tmp, `${version}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    /* 寫失敗不擋更新路徑 */
  }
}
