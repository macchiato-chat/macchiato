/**
 * #370 E2E 用户控制认证。
 *
 * server 只负责路由 `e2e.control`，不能生成、改写或重放设备意图。本模块用会话 K_S
 * 派生独立 K_ctrl，验证 HMAC 后先持久推进 `(wireSid, keyId, deviceId) -> maxSeq`，
 * 再把原始 JSON payload 交给 drive。
 *
 * 此文件会随 connector 独立公开分发；不要依赖 server 端实现或 server secret。
 */
import { createHash, createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { E2EKeyStore } from "./keys";

export const E2E_CONTROL_MAGIC = Buffer.from("macchiato-e2e-control-v1", "utf8");
export const E2E_CONTROL_HKDF_SALT = createHash("sha256")
  .update("macchiato-e2e-control-v1:salt", "utf8")
  .digest();
export const E2E_CONTROL_HKDF_INFO = Buffer.from("macchiato-e2e-control-v1:key", "utf8");

export const E2E_CONTROL_MAX_PAYLOAD_BYTES = 64 * 1024;
export const E2E_CONTROL_MAX_LIFETIME_MS = 5 * 60 * 1000;
export const E2E_CONTROL_CLOCK_SKEW_MS = 60 * 1000;
export const E2E_APPROVAL_DISPLAY_MAX_BYTES = 48 * 1024;
export const E2E_DISABLE_RECEIPT_MAGIC = Buffer.from(
  "macchiato-e2e-disable-receipt-v1",
  "utf8",
);

const MAX_U64 = (1n << 64n) - 1n;
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const MAX_LOCK_OWNER_BYTES = 1024;
const LOCK_OWNER_FILE = "owner.json";
const LOCK_RECLAIM_FILE = "reclaim.json";
const ENVELOPE_KEYS = [
  "deviceId",
  "expiresAtMs",
  "hermesSessionId",
  "issuedAtMs",
  "keyId",
  "kind",
  "mac",
  "msgId",
  "payloadB64",
  "seq",
  "sessionId",
  "v",
] as const;

export const E2E_CONTROL_KINDS = [
  "command.invoke",
  "approval.respond",
  "clarify.respond",
  "secret.respond",
  "session.interrupt",
  "task.stop",
  "session.e2e.disable",
  "session.cwd.set",
  "session.permission.set",
  "session.model.set",
  "session.effort.set",
] as const;

export type E2EControlKind = (typeof E2E_CONTROL_KINDS)[number];

export interface E2EControlEnvelopeV1 {
  v: 1;
  sessionId: string;
  hermesSessionId: string;
  deviceId: string;
  keyId: string;
  msgId: string;
  seq: string;
  issuedAtMs: string;
  expiresAtMs: string;
  kind: E2EControlKind;
  payloadB64: string;
  mac: string;
}

export interface E2EDisableReceiptV1 {
  v: 1;
  kind: "session.e2e.disabled";
  sessionId: string;
  hermesSessionId: string;
  keyId: string;
  intentDeviceId: string;
  intentMsgId: string;
  intentSeq: string;
  receiptId: string;
  mac: string;
}

export interface VerifiedE2EControl {
  envelope: E2EControlEnvelopeV1;
  kind: E2EControlKind;
  payload: Record<string, unknown>;
}

export interface E2EControlDispatch {
  method:
    | "command.invoke"
    | "approval.respond"
    | "clarify.respond"
    | "secret.respond"
    | "session.interrupt"
    | "task.stop"
    | "session.e2e.disable"
    | "session.create";
  params: Record<string, unknown>;
}

type ReplayFloors = Map<string, Map<string, Map<string, bigint>>>;
type PublicSessionBindings = Map<string, string>;
interface ReplayState {
  floors: ReplayFloors;
  bindings: PublicSessionBindings;
}
type Snapshot =
  | { kind: "missing" }
  | { kind: "valid"; state: ReplayState }
  | { kind: "invalid"; error: unknown };

type KeyProvider = Pick<E2EKeyStore, "requireKey">;
type DisableResumeKeyStore = Pick<E2EKeyStore, "hasPendingDisable">;
type DisableResumeLink = {
  agentLinkId: string;
  send(frame: Record<string, unknown>): void;
};

interface ReplayLockOwner {
  v: 1;
  pid: number;
  token: string;
  createdAtMs: number;
}

export class E2EControlError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "E2EControlError";
  }
}

/**
 * server 的裸 `e2e_disable_request` 只能恢复本地已持久化的签封 intent。
 * 无 marker 时显式回 found:false，让 server 清 pending；绝不触发明文回灌。
 */
export function authorizeE2EDisableResume(
  keys: DisableResumeKeyStore,
  linkb: DisableResumeLink,
  sid: string,
): boolean {
  if (keys.hasPendingDisable(sid)) return true;
  linkb.send({
    t: "e2e_backfill",
    agentLinkId: linkb.agentLinkId,
    hermesSessionId: sid,
    mode: "disable",
    found: false,
  });
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isEEXIST(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

function sameLockOwner(a: ReplayLockOwner, b: ReplayLockOwner): boolean {
  return (
    a.v === b.v &&
    a.pid === b.pid &&
    a.token === b.token &&
    a.createdAtMs === b.createdAtMs
  );
}

function utf8Field(value: unknown, name: string, ascii = false): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > 512) {
    throw new E2EControlError(`invalid ${name}`);
  }
  if (ascii && !/^[\x20-\x7e]+$/.test(value)) throw new E2EControlError(`invalid ${name}`);
  return value;
}

function parseU64(value: unknown, name: string, allowZero = false): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new E2EControlError(`${name} must be a canonical UInt64 string`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_U64 || (!allowZero && parsed === 0n)) {
    throw new E2EControlError(`${name} out of range`);
  }
  return parsed;
}

function decodeCanonicalBase64(value: unknown, name: string, maxBytes: number): Buffer {
  if (typeof value !== "string" || !value || value.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    throw new E2EControlError(`${name} is not canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (!decoded.length || decoded.length > maxBytes || decoded.toString("base64") !== value) {
    throw new E2EControlError(`${name} is not canonical base64`);
  }
  return decoded;
}

function lengthPrefixed(raw: Buffer): Buffer {
  if (raw.length > 0xffff_ffff) throw new E2EControlError("control field too large");
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(raw.length, 0);
  return Buffer.concat([prefix, raw]);
}

/** 跨 Swift/Node/Python 的固定 MAC 编码；payload 必须是 base64 解码后的原始 JSON bytes。 */
export function e2eControlMacInput(
  envelope: Pick<
    E2EControlEnvelopeV1,
    | "sessionId"
    | "hermesSessionId"
    | "deviceId"
    | "keyId"
    | "msgId"
    | "seq"
    | "issuedAtMs"
    | "expiresAtMs"
    | "kind"
  >,
  payload: Buffer,
): Buffer {
  const fields = [
    E2E_CONTROL_MAGIC,
    Buffer.from("1", "utf8"),
    Buffer.from(envelope.sessionId, "utf8"),
    Buffer.from(envelope.hermesSessionId, "utf8"),
    Buffer.from(envelope.deviceId, "utf8"),
    Buffer.from(envelope.keyId, "ascii"),
    Buffer.from(envelope.msgId, "utf8"),
    Buffer.from(envelope.seq, "ascii"),
    Buffer.from(envelope.issuedAtMs, "ascii"),
    Buffer.from(envelope.expiresAtMs, "ascii"),
    Buffer.from(envelope.kind, "ascii"),
    payload,
  ];
  return Buffer.concat(fields.map(lengthPrefixed));
}

/** RFC 5869 HKDF-SHA256(K_S, fixed salt/info), 32 bytes。 */
export function deriveE2EControlKey(sessionKey: Buffer): Buffer {
  if (sessionKey.length !== 32) throw new E2EControlError("K_S must be 32 bytes");
  return Buffer.from(hkdfSync("sha256", sessionKey, E2E_CONTROL_HKDF_SALT, E2E_CONTROL_HKDF_INFO, 32));
}

/** base64url-no-pad(SHA256(K_S))。 */
export function e2eControlKeyId(sessionKey: Buffer): string {
  if (sessionKey.length !== 32) throw new E2EControlError("K_S must be 32 bytes");
  return createHash("sha256").update(sessionKey).digest("base64url");
}

/** 供跨语言固定向量和 iOS 对齐测试使用；输出 standard padded base64。 */
export function e2eControlMac(
  sessionKey: Buffer,
  envelope: Parameters<typeof e2eControlMacInput>[0],
  payload: Buffer,
): string {
  return createHmac("sha256", deriveE2EControlKey(sessionKey))
    .update(e2eControlMacInput(envelope, payload))
    .digest("base64");
}

export function e2eDisableReceiptMacInput(
  receipt: Omit<E2EDisableReceiptV1, "mac">,
): Buffer {
  return Buffer.concat([
    E2E_DISABLE_RECEIPT_MAGIC,
    Buffer.from("1", "ascii"),
    Buffer.from(receipt.kind, "ascii"),
    Buffer.from(receipt.sessionId, "utf8"),
    Buffer.from(receipt.hermesSessionId, "utf8"),
    Buffer.from(receipt.keyId, "ascii"),
    Buffer.from(receipt.intentDeviceId, "utf8"),
    Buffer.from(receipt.intentMsgId, "utf8"),
    Buffer.from(receipt.intentSeq, "ascii"),
    Buffer.from(receipt.receiptId, "utf8"),
  ].map(lengthPrefixed));
}

export function createE2EDisableReceipt(
  sessionKey: Buffer,
  intent: E2EControlEnvelopeV1,
  receiptId = randomUUID(),
): E2EDisableReceiptV1 {
  if (intent.kind !== "session.e2e.disable") {
    throw new E2EControlError("disable receipt requires session.e2e.disable intent");
  }
  const expectedKeyId = e2eControlKeyId(sessionKey);
  if (intent.keyId !== expectedKeyId) {
    throw new E2EControlError("disable intent key id mismatch");
  }
  parseU64(intent.seq, "intentSeq");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      receiptId,
    )
  ) {
    throw new E2EControlError("invalid disable receipt id");
  }
  const unsigned: Omit<E2EDisableReceiptV1, "mac"> = {
    v: 1,
    kind: "session.e2e.disabled",
    sessionId: intent.sessionId,
    hermesSessionId: intent.hermesSessionId,
    keyId: intent.keyId,
    intentDeviceId: intent.deviceId,
    intentMsgId: intent.msgId,
    intentSeq: intent.seq,
    receiptId,
  };
  return {
    ...unsigned,
    mac: createHmac("sha256", deriveE2EControlKey(sessionKey))
      .update(e2eDisableReceiptMacInput(unsigned))
      .digest("base64"),
  };
}

export function verifyE2EDisableReceipt(
  sessionKey: Buffer,
  intent: E2EControlEnvelopeV1,
  value: unknown,
): E2EDisableReceiptV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new E2EControlError("disable receipt must be an object");
  }
  const receipt = value as Record<string, unknown>;
  const fields = [
    "v", "kind", "sessionId", "hermesSessionId", "keyId",
    "intentDeviceId", "intentMsgId", "intentSeq", "receiptId", "mac",
  ];
  if (!exactKeys(receipt, fields) || receipt.v !== 1 || receipt.kind !== "session.e2e.disabled") {
    throw new E2EControlError("invalid disable receipt shape");
  }
  for (const field of [
    "sessionId", "hermesSessionId", "keyId", "intentDeviceId",
    "intentMsgId", "intentSeq", "receiptId", "mac",
  ]) {
    if (typeof receipt[field] !== "string" || !receipt[field]) {
      throw new E2EControlError(`invalid disable receipt ${field}`);
    }
  }
  const typed = receipt as unknown as E2EDisableReceiptV1;
  parseU64(typed.intentSeq, "intentSeq");
  if (
    typed.sessionId !== intent.sessionId ||
    typed.hermesSessionId !== intent.hermesSessionId ||
    typed.keyId !== intent.keyId ||
    typed.intentDeviceId !== intent.deviceId ||
    typed.intentMsgId !== intent.msgId ||
    typed.intentSeq !== intent.seq
  ) {
    throw new E2EControlError("disable receipt does not match intent");
  }
  if (typed.keyId !== e2eControlKeyId(sessionKey)) {
    throw new E2EControlError("disable receipt key id mismatch");
  }
  const supplied = decodeCanonicalBase64(typed.mac, "disable receipt mac", 32);
  if (supplied.length !== 32) throw new E2EControlError("invalid disable receipt MAC length");
  const { mac: _mac, ...unsigned } = typed;
  const expected = createHmac("sha256", deriveE2EControlKey(sessionKey))
    .update(e2eDisableReceiptMacInput(unsigned))
    .digest();
  if (!timingSafeEqual(supplied, expected)) {
    throw new E2EControlError("disable receipt MAC mismatch");
  }
  return typed;
}

function visibleJSONString(value: string): string {
  // JSON.stringify 会保留 bidi/zero-width/default-ignorable 字符本体；若直接展示，攻击者可让
  // “完整 JSON”视觉上重排或隐藏实际执行内容。这里把它们编码成可见的 \uXXXX（非 BMP
  // 使用一对 surrogate escape）。digest 与 executionDisplay 都走同一函数，二者 byte-identical。
  return JSON.stringify(value).replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu,
    (character) =>
      [...character]
        .map((scalar) => {
          const codePoint = scalar.codePointAt(0)!;
          if (codePoint <= 0xffff) return `\\u${codePoint.toString(16).padStart(4, "0")}`;
          const offset = codePoint - 0x10000;
          const high = 0xd800 + (offset >> 10);
          const low = 0xdc00 + (offset & 0x3ff);
          return `\\u${high.toString(16)}\\u${low.toString(16)}`;
        })
        .join(""),
  );
}

function stableJSON(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return typeof value === "string" ? visibleJSONString(value) : JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new E2EControlError("request digest contains unsafe integer or non-integer number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableJSON(item ?? null)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${visibleJSONString(key)}:${stableJSON(item)}`).join(",")}}`;
  }
  throw new E2EControlError("request digest contains unsupported value");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/**
 * 将 SDK/RPC 回调参数复制为唯一的 canonical JSON 快照并递归冻结。审批 digest、加密卡片和
 * 最终执行必须共用这份快照，不能继续引用调用方随后仍可修改的对象。
 */
export function immutableE2EApprovalSnapshot<T>(value: T): T {
  return deepFreeze(JSON.parse(stableJSON(value)) as T);
}

/** 设备必须完整显示的 canonical 执行请求；超限时 connector 直接拒绝本次审批。 */
export function canonicalE2EApprovalDisplay(value: unknown): string {
  const display = stableJSON(value);
  if (Buffer.byteLength(display, "utf8") > E2E_APPROVAL_DISPLAY_MAX_BYTES) {
    throw new E2EControlError("E2E approval execution request exceeds display limit");
  }
  return display;
}

/**
 * connector 生成的审批上下文摘要。用 K_ctrl 做 keyed digest，避免不可信 server 根据公开
 * requestId/sessionId 对低熵命令、路径做离线字典猜测。
 *
 * 编码：HMAC-SHA256(K_ctrl,
 *   u32be(len("approval-request-v1")) || "approval-request-v1" ||
 *   u32be(len(stableJSON)) || stableJSON)
 * 输出 base64url-no-pad。
 */
export function e2eApprovalRequestDigest(
  sessionKey: Buffer,
  value: Record<string, unknown>,
): string {
  const domain = Buffer.from("approval-request-v1", "utf8");
  const body = Buffer.from(stableJSON(value), "utf8");
  return createHmac("sha256", deriveE2EControlKey(sessionKey))
    .update(Buffer.concat([lengthPrefixed(domain), lengthPrefixed(body)]))
    .digest("base64url");
}

function adjacentControlPath(keyStorePath: string): string {
  return keyStorePath.endsWith(".json")
    ? `${keyStorePath.slice(0, -".json".length)}-control.json`
    : `${keyStorePath}-control.json`;
}

export function e2eControlStorePath(): string {
  const keyStorePath =
    process.env.MACCHIATO_CLAUDE_CODE_E2E_STORE ||
    join(homedir(), ".macchiato/claude-code-e2e.json");
  return (
    process.env.MACCHIATO_CLAUDE_CODE_E2E_CONTROL_STORE ||
    adjacentControlPath(keyStorePath)
  );
}

function emptyReplayState(): ReplayState {
  return { floors: new Map(), bindings: new Map() };
}

function cloneReplayState(source: ReplayState): ReplayState {
  const floors: ReplayFloors = new Map();
  for (const [sid, byKey] of source.floors) {
    const keyCopy = new Map<string, Map<string, bigint>>();
    for (const [keyId, byDevice] of byKey) keyCopy.set(keyId, new Map(byDevice));
    floors.set(sid, keyCopy);
  }
  return { floors, bindings: new Map(source.bindings) };
}

function mergeReplayStates(states: ReplayState[]): ReplayState {
  const out = emptyReplayState();
  for (const state of states) {
    for (const [sid, publicSessionId] of state.bindings) {
      const current = out.bindings.get(sid);
      if (current !== undefined && current !== publicSessionId) {
        throw new E2EControlError(`conflicting public session binding for wire session ${sid}`);
      }
      out.bindings.set(sid, publicSessionId);
    }
    for (const [sid, byKey] of state.floors) {
      let dstKeys = out.floors.get(sid);
      if (!dstKeys) out.floors.set(sid, (dstKeys = new Map()));
      for (const [keyId, byDevice] of byKey) {
        let dstDevices = dstKeys.get(keyId);
        if (!dstDevices) dstKeys.set(keyId, (dstDevices = new Map()));
        for (const [deviceId, seq] of byDevice) {
          const current = dstDevices.get(deviceId);
          if (current === undefined || seq > current) dstDevices.set(deviceId, seq);
        }
      }
    }
  }
  return out;
}

function parseReplayState(value: unknown): ReplayState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new E2EControlError("invalid replay state");
  }
  const root = value as Record<string, unknown>;
  const legacy =
    root.version === 1 &&
    Object.keys(root).sort().join(",") === "floors,version";
  const current =
    root.version === 2 &&
    Object.keys(root).sort().join(",") === "bindings,floors,version";
  if (
    (!legacy && !current) ||
    root.floors === null ||
    typeof root.floors !== "object" ||
    Array.isArray(root.floors)
  ) {
    throw new E2EControlError("invalid replay state");
  }
  const floors: ReplayFloors = new Map();
  for (const [sid, rawByKey] of Object.entries(root.floors as Record<string, unknown>)) {
    utf8Field(sid, "stored session id");
    if (rawByKey === null || typeof rawByKey !== "object" || Array.isArray(rawByKey)) {
      throw new E2EControlError("invalid replay key map");
    }
    const byKey = new Map<string, Map<string, bigint>>();
    for (const [keyId, rawByDevice] of Object.entries(rawByKey as Record<string, unknown>)) {
      utf8Field(keyId, "stored key id", true);
      if (rawByDevice === null || typeof rawByDevice !== "object" || Array.isArray(rawByDevice)) {
        throw new E2EControlError("invalid replay device map");
      }
      const byDevice = new Map<string, bigint>();
      for (const [deviceId, rawSeq] of Object.entries(rawByDevice as Record<string, unknown>)) {
        utf8Field(deviceId, "stored device id");
        byDevice.set(deviceId, parseU64(rawSeq, "stored seq"));
      }
      byKey.set(keyId, byDevice);
    }
    floors.set(sid, byKey);
  }
  const bindings: PublicSessionBindings = new Map();
  if (current) {
    if (
      root.bindings === null ||
      typeof root.bindings !== "object" ||
      Array.isArray(root.bindings)
    ) {
      throw new E2EControlError("invalid public session bindings");
    }
    for (const [sid, publicSessionId] of Object.entries(
      root.bindings as Record<string, unknown>,
    )) {
      utf8Field(sid, "stored binding wire session id");
      bindings.set(
        sid,
        utf8Field(publicSessionId, "stored binding public session id"),
      );
    }
  }
  return { floors, bindings };
}

function serializeReplayState(state: ReplayState): string {
  const root: Record<string, Record<string, Record<string, string>>> = Object.create(null);
  for (const [sid, byKey] of [...state.floors].sort(([a], [b]) => a.localeCompare(b))) {
    const keys: Record<string, Record<string, string>> = Object.create(null);
    for (const [keyId, byDevice] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
      const devices: Record<string, string> = Object.create(null);
      for (const [deviceId, seq] of [...byDevice].sort(([a], [b]) => a.localeCompare(b))) {
        devices[deviceId] = seq.toString();
      }
      keys[keyId] = devices;
    }
    root[sid] = keys;
  }
  const bindings: Record<string, string> = Object.create(null);
  for (const [sid, publicSessionId] of [...state.bindings].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    bindings[sid] = publicSessionId;
  }
  return JSON.stringify({ version: 2, bindings, floors: root });
}

function exactKeys(value: Record<string, unknown>, ...allowed: string[][]): boolean {
  const keys = Object.keys(value).sort().join("\u0000");
  return allowed.some((set) => [...set].sort().join("\u0000") === keys);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/**
 * 将已认证 payload 严格映射回既有 drive method。额外字段一律拒绝，避免三个 connector
 * 或新旧版本对同一已签 bytes 作出不同解释。
 */
export function dispatchForE2EControl(kind: E2EControlKind, payload: Record<string, unknown>): E2EControlDispatch {
  switch (kind) {
    case "command.invoke":
      // commands.list 尚未有设备认证 provenance；恶意 server 可把真实危险 slug 伪装成
      // 良性条目诱导设备签名。设备有 independent exact-slug confirmation UI 前统一 NACK。
      throw new E2EControlError("command.invoke is disabled for E2E controls");
    case "approval.respond": {
      const required = ["blockId", "requestId", "requestDigest", "choice", "all"];
      if (!exactKeys(payload, required)) {
        throw new E2EControlError("invalid approval.respond payload");
      }
      if (
        !nonEmptyString(payload.blockId) ||
        !nonEmptyString(payload.requestId) ||
        !validDigest(payload.requestDigest) ||
        !nonEmptyString(payload.choice) ||
        typeof payload.all !== "boolean"
      ) {
        throw new E2EControlError("invalid authenticated approval identity");
      }
      if (!["yes", "no"].includes(payload.choice)) {
        throw new E2EControlError("invalid authenticated approval choice");
      }
      if (payload.all) {
        // 会话级授权的精确 scope 尚未进入被签执行对象；先只允许单次 yes/no。
        throw new E2EControlError("authenticated approval scope is disabled");
      }
      return {
        method: "approval.respond",
        params: {
          blockId: payload.blockId,
          request_id: payload.requestId,
          requestDigest: payload.requestDigest,
          choice: payload.choice,
          all: payload.all,
        },
      };
    }
    case "clarify.respond": {
      const required = ["blockId", "requestId", "requestDigest", "answerEnc"];
      if (!exactKeys(payload, required)) {
        throw new E2EControlError("invalid clarify.respond payload");
      }
      if (
        !nonEmptyString(payload.blockId) ||
        !nonEmptyString(payload.requestId) ||
        !nonEmptyString(payload.answerEnc) ||
        !validDigest(payload.requestDigest)
      ) {
        throw new E2EControlError("invalid authenticated clarify response");
      }
      return {
        method: "clarify.respond",
        params: {
          blockId: payload.blockId,
          request_id: payload.requestId,
          requestDigest: payload.requestDigest,
          answerEnc: payload.answerEnc,
        },
      };
    }
    case "secret.respond": {
      const required = ["blockId", "requestId", "requestDigest", "secretEnc"];
      if (!exactKeys(payload, required)) {
        throw new E2EControlError("invalid secret.respond payload");
      }
      if (
        !nonEmptyString(payload.blockId) ||
        !nonEmptyString(payload.requestId) ||
        !nonEmptyString(payload.secretEnc) ||
        !validDigest(payload.requestDigest)
      ) {
        throw new E2EControlError("invalid authenticated secret response");
      }
      return {
        method: "secret.respond",
        params: {
          blockId: payload.blockId,
          request_id: payload.requestId,
          requestDigest: payload.requestDigest,
          secretEnc: payload.secretEnc,
        },
      };
    }
    case "session.interrupt":
      // 签名幀可能在当前回合结束后才到达并误杀下一回合；没有 turn identity 前统一禁用。
      throw new E2EControlError("session.interrupt is disabled for E2E controls");
    case "task.stop":
      // CC 历史实现会做 task id 前缀扩展；在完整 ID provenance 落地前连 exact ID 也不执行。
      throw new E2EControlError("task.stop is disabled for E2E controls");
    case "session.e2e.disable":
      if (!exactKeys(payload, [])) throw new E2EControlError("invalid session.e2e.disable payload");
      return { method: "session.e2e.disable", params: {} };
    case "session.cwd.set":
      if (!exactKeys(payload, ["cwd"]) || (payload.cwd !== null && typeof payload.cwd !== "string")) {
        throw new E2EControlError("invalid session.cwd.set payload");
      }
      return { method: "session.create", params: { cwd: payload.cwd ?? "" } };
    case "session.permission.set":
      if (
        !exactKeys(payload, ["permissionMode"]) ||
        (payload.permissionMode !== null && typeof payload.permissionMode !== "string")
      ) {
        throw new E2EControlError("invalid session.permission.set payload");
      }
      return { method: "session.create", params: { permissionMode: payload.permissionMode ?? "" } };
    case "session.model.set":
      if (!exactKeys(payload, ["model"]) || (payload.model !== null && typeof payload.model !== "string")) {
        throw new E2EControlError("invalid session.model.set payload");
      }
      return { method: "session.create", params: { model: payload.model ?? "" } };
    case "session.effort.set":
      if (!exactKeys(payload, ["effort"]) || (payload.effort !== null && typeof payload.effort !== "string")) {
        throw new E2EControlError("invalid session.effort.set payload");
      }
      return { method: "session.create", params: { effort: payload.effort ?? "" } };
  }
}

export class E2EControlVerifier {
  private state: ReplayState;
  private poisoned: E2EControlError | null = null;

  constructor(
    private readonly keys: KeyProvider,
    private readonly path: string = e2eControlStorePath(),
    private readonly nowMs: () => number = Date.now,
  ) {
    this.state = emptyReplayState();
    // 构造期的双快照修复也必须与消费共用同一跨进程锁；否则旧 reader 可能在另一
    // 进程刚推进高水位后把旧 merged 状态写回，重新开放已执行控制帧。
    const release = this.acquireReplayLock();
    try {
      this.state = this.load();
    } finally {
      release();
    }
  }

  private readSnapshot(path: string): Snapshot {
    let raw: string;
    try {
      if (statSync(path).size > MAX_STORE_BYTES) throw new Error("snapshot too large");
      raw = readFileSync(path, "utf8");
    } catch (error) {
      return isENOENT(error) ? { kind: "missing" } : { kind: "invalid", error };
    }
    try {
      return { kind: "valid", state: parseReplayState(JSON.parse(raw)) };
    } catch (error) {
      return { kind: "invalid", error };
    }
  }

  private load(repair = true): ReplayState {
    const primary = this.readSnapshot(this.path);
    const backup = this.readSnapshot(`${this.path}.bak`);
    if (primary.kind === "missing" && backup.kind === "missing") return emptyReplayState();
    // persist 顺序固定为 primary → backup，因此 primary 是唯一能证明“至少含最高已消费
    // seq”的快照。primary 丢失/损坏时绝不能降级读 backup：它可能正好是上一次写入，
    // 恢复它会重新开放已经执行过的控制帧。
    if (primary.kind !== "valid") {
      const p = primary.kind === "invalid" ? errorMessage(primary.error) : primary.kind;
      const b = backup.kind === "invalid" ? errorMessage(backup.error) : backup.kind;
      throw new E2EControlError(
        `E2E control replay primary is unavailable: primary=${p}, backup=${b}`,
      );
    }
    const merged = mergeReplayStates([
      primary.state,
      ...(backup.kind === "valid" ? [backup.state] : []),
    ]);
    if (repair) {
      try {
        this.persist(merged);
      } catch (error) {
        throw new E2EControlError("failed to repair E2E control replay snapshots", { cause: error });
      }
    }
    return merged;
  }

  private atomicWrite(target: string, raw: string): void {
    const parent = dirname(target);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const tmp = join(parent, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      writeFileSync(fd, raw, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, target);
      const dirFd = openSync(parent, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // 保留原始写入错误。
        }
      }
      try {
        unlinkSync(tmp);
      } catch {
        // rename 成功后 tmp 已不存在；失败清理 best-effort。
      }
    }
  }

  private persist(state: ReplayState): void {
    const raw = serializeReplayState(state);
    this.atomicWrite(this.path, raw);
    this.atomicWrite(`${this.path}.bak`, raw);
  }

  private lockOwnerPath(lockDir: string, reclaim = false): string {
    return join(lockDir, reclaim ? LOCK_RECLAIM_FILE : LOCK_OWNER_FILE);
  }

  private parseLockOwner(raw: string, label: string): ReplayLockOwner {
    if (Buffer.byteLength(raw, "utf8") > MAX_LOCK_OWNER_BYTES) {
      throw new E2EControlError(`${label} is too large`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new E2EControlError(`${label} is invalid JSON`, { cause: error });
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(",") !== "createdAtMs,pid,token,v"
    ) {
      throw new E2EControlError(`${label} has invalid shape`);
    }
    const owner = parsed as ReplayLockOwner;
    if (
      owner.v !== 1 ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      !Number.isSafeInteger(owner.createdAtMs) ||
      owner.createdAtMs < 0 ||
      typeof owner.token !== "string" ||
      !/^[0-9a-f-]{36}$/.test(owner.token)
    ) {
      throw new E2EControlError(`${label} has invalid fields`);
    }
    return owner;
  }

  private readLockOwner(lockDir: string, reclaim = false): ReplayLockOwner {
    const lockStat = lstatSync(lockDir);
    if (
      lockStat.isSymbolicLink() ||
      !lockStat.isDirectory() ||
      (lockStat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && lockStat.uid !== process.getuid())
    ) {
      throw new E2EControlError("E2E control replay lock directory is unsafe");
    }
    const ownerPath = this.lockOwnerPath(lockDir, reclaim);
    const before = lstatSync(ownerPath);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      (before.mode & 0o077) !== 0 ||
      before.size > MAX_LOCK_OWNER_BYTES ||
      (typeof process.getuid === "function" && before.uid !== process.getuid())
    ) {
      throw new E2EControlError("E2E control replay lock owner is unsafe");
    }
    const fd = openSync(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const after = fstatSync(fd);
      if (before.dev !== after.dev || before.ino !== after.ino || !after.isFile()) {
        throw new E2EControlError("E2E control replay lock owner changed while opening");
      }
      return this.parseLockOwner(
        readFileSync(fd, "utf8"),
        reclaim ? "E2E control replay reclaim owner" : "E2E control replay lock owner",
      );
    } finally {
      closeSync(fd);
    }
  }

  private writeLockOwner(lockDir: string, owner: ReplayLockOwner, reclaim = false): void {
    const ownerPath = this.lockOwnerPath(lockDir, reclaim);
    const fd = openSync(
      ownerPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, JSON.stringify(owner), "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const dirFd = openSync(lockDir, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }

  private pidIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false;
      if (code === "EPERM") return true;
      throw new E2EControlError(`cannot determine replay lock owner PID state: ${code ?? "unknown"}`, {
        cause: error,
      });
    }
  }

  private cleanupLockDir(lockDir: string): void {
    for (const name of [LOCK_RECLAIM_FILE, LOCK_OWNER_FILE]) {
      try {
        unlinkSync(join(lockDir, name));
      } catch (error) {
        if (!isENOENT(error)) throw error;
      }
    }
    rmdirSync(lockDir);
  }

  private removeOwnedReclaim(lockDir: string, owner: ReplayLockOwner): boolean {
    try {
      const current = this.readLockOwner(lockDir, true);
      if (!sameLockOwner(current, owner)) return false;
      unlinkSync(this.lockOwnerPath(lockDir, true));
      const dirFd = openSync(lockDir, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
      return true;
    } catch {
      return false;
    }
  }

  private acquireReplayLock(): () => void {
    const lockDir = `${this.path}.lock`;
    mkdirSync(dirname(lockDir), { recursive: true, mode: 0o700 });
    const owner: ReplayLockOwner = {
      v: 1,
      pid: process.pid,
      token: randomUUID(),
      createdAtMs: Date.now(),
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        mkdirSync(lockDir, { mode: 0o700 });
        try {
          this.writeLockOwner(lockDir, owner);
        } catch (error) {
          try {
            this.cleanupLockDir(lockDir);
          } catch {
            // 无法证明清理完整时保留锁并 fail closed。
          }
          throw error;
        }
        return () => {
          const current = this.readLockOwner(lockDir);
          if (!sameLockOwner(current, owner)) {
            throw new E2EControlError("E2E control replay lock ownership changed");
          }
          const released = `${lockDir}.released.${owner.token}`;
          renameSync(lockDir, released);
          const parentFd = openSync(dirname(lockDir), "r");
          try {
            fsyncSync(parentFd);
          } finally {
            closeSync(parentFd);
          }
          this.cleanupLockDir(released);
        };
      } catch (error) {
        if (!isEEXIST(error)) {
          throw new E2EControlError("failed to acquire E2E control replay lock", {
            cause: error,
          });
        }
      }

      let staleOwner: ReplayLockOwner;
      try {
        staleOwner = this.readLockOwner(lockDir);
      } catch (error) {
        throw new E2EControlError(
          "cannot prove E2E control replay lock ownership; refusing control",
          { cause: error },
        );
      }
      if (this.pidIsAlive(staleOwner.pid)) {
        throw new E2EControlError("E2E control replay lock is held by a live process");
      }

      const reclaimer: ReplayLockOwner = {
        v: 1,
        pid: process.pid,
        token: randomUUID(),
        createdAtMs: Date.now(),
      };
      try {
        this.writeLockOwner(lockDir, reclaimer, true);
      } catch (error) {
        if (isEEXIST(error)) {
          let abandoned: ReplayLockOwner;
          try {
            abandoned = this.readLockOwner(lockDir, true);
          } catch (readError) {
            throw new E2EControlError(
              "cannot prove E2E control replay reclaimer ownership",
              { cause: readError },
            );
          }
          if (!this.pidIsAlive(abandoned.pid) && this.removeOwnedReclaim(lockDir, abandoned)) {
            // 上个进程在 stale-owner 校验或 rename 前崩溃；只移除已证明死亡的 reclaimer，
            // 下一轮重新校验原 owner，绝不直接接管。
            continue;
          }
        }
        throw new E2EControlError("E2E control replay lock is already being reclaimed", {
          cause: error,
        });
      }
      const confirmed = this.readLockOwner(lockDir);
      if (!sameLockOwner(confirmed, staleOwner) || this.pidIsAlive(confirmed.pid)) {
        this.removeOwnedReclaim(lockDir, reclaimer);
        throw new E2EControlError("stale replay lock ownership could not be proven");
      }
      const reclaimed = `${lockDir}.stale.${reclaimer.token}`;
      try {
        renameSync(lockDir, reclaimed);
      } catch (error) {
        this.removeOwnedReclaim(lockDir, reclaimer);
        throw new E2EControlError("failed to atomically reclaim E2E control replay lock", {
          cause: error,
        });
      }
      try {
        this.cleanupLockDir(reclaimed);
      } catch (error) {
        throw new E2EControlError("failed to clean reclaimed E2E control replay lock", {
          cause: error,
        });
      }
    }
    throw new E2EControlError("failed to acquire E2E control replay lock");
  }

  verifyAndConsume(rawEnvelope: unknown, expectedWireSession: string): VerifiedE2EControl {
    if (this.poisoned) throw this.poisoned;
    if (
      rawEnvelope === null ||
      typeof rawEnvelope !== "object" ||
      Array.isArray(rawEnvelope) ||
      Object.keys(rawEnvelope).sort().join(",") !== [...ENVELOPE_KEYS].sort().join(",")
    ) {
      throw new E2EControlError("invalid control envelope shape");
    }
    const raw = rawEnvelope as Record<string, unknown>;
    if (raw.v !== 1) throw new E2EControlError("unsupported control envelope version");

    const envelope = raw as unknown as E2EControlEnvelopeV1;
    utf8Field(envelope.sessionId, "sessionId");
    utf8Field(envelope.hermesSessionId, "hermesSessionId");
    utf8Field(envelope.deviceId, "deviceId");
    utf8Field(envelope.keyId, "keyId", true);
    utf8Field(envelope.msgId, "msgId");
    utf8Field(envelope.kind, "kind", true);
    if (envelope.hermesSessionId !== expectedWireSession) {
      throw new E2EControlError("control wire session mismatch");
    }
    if (!(E2E_CONTROL_KINDS as readonly string[]).includes(envelope.kind)) {
      throw new E2EControlError("unsupported control kind");
    }

    const seq = parseU64(envelope.seq, "seq");
    const issued = parseU64(envelope.issuedAtMs, "issuedAtMs", true);
    const expires = parseU64(envelope.expiresAtMs, "expiresAtMs", true);
    const nowNumber = this.nowMs();
    if (!Number.isSafeInteger(nowNumber) || nowNumber < 0) {
      throw new E2EControlError("invalid verifier clock");
    }
    const now = BigInt(nowNumber);
    if (expires <= issued || expires - issued > BigInt(E2E_CONTROL_MAX_LIFETIME_MS)) {
      throw new E2EControlError("invalid control lifetime");
    }
    if (issued > now + BigInt(E2E_CONTROL_CLOCK_SKEW_MS) || expires < now) {
      throw new E2EControlError("control envelope expired or issued in the future");
    }

    const payloadRaw = decodeCanonicalBase64(
      envelope.payloadB64,
      "payloadB64",
      E2E_CONTROL_MAX_PAYLOAD_BYTES,
    );
    const suppliedMac = decodeCanonicalBase64(envelope.mac, "mac", 32);
    if (suppliedMac.length !== 32) throw new E2EControlError("invalid control MAC length");

    const sessionKey = this.keys.requireKey(expectedWireSession);
    const expectedKeyId = e2eControlKeyId(sessionKey);
    const suppliedKeyId = Buffer.from(envelope.keyId, "ascii");
    const expectedKeyIdBytes = Buffer.from(expectedKeyId, "ascii");
    if (
      suppliedKeyId.length !== expectedKeyIdBytes.length ||
      !timingSafeEqual(suppliedKeyId, expectedKeyIdBytes)
    ) {
      throw new E2EControlError("control key id mismatch");
    }
    const expectedMac = createHmac("sha256", deriveE2EControlKey(sessionKey))
      .update(e2eControlMacInput(envelope, payloadRaw))
      .digest();
    if (!timingSafeEqual(suppliedMac, expectedMac)) {
      throw new E2EControlError("control MAC mismatch");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadRaw));
    } catch (error) {
      throw new E2EControlError("payload is not UTF-8 JSON", { cause: error });
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new E2EControlError("payload must be a JSON object");
    }

    const release = this.acquireReplayLock();
    try {
      // verifier 可能早于另一个 connector 进程启动；持锁后必须重新读取磁盘并与本进程
      // floor 取 max，不能相信构造时快照。
      const latest = mergeReplayStates([this.state, this.load(false)]);
      const boundPublicSession = latest.bindings.get(expectedWireSession);
      if (
        boundPublicSession !== undefined &&
        boundPublicSession !== envelope.sessionId
      ) {
        throw new E2EControlError("control public/wire session binding mismatch");
      }
      const current = latest.floors
        .get(expectedWireSession)
        ?.get(expectedKeyId)
        ?.get(envelope.deviceId);
      if (current !== undefined && seq <= current) {
        throw new E2EControlError("replayed or out-of-order control envelope");
      }

      const next = cloneReplayState(latest);
      next.bindings.set(expectedWireSession, envelope.sessionId);
      let byKey = next.floors.get(expectedWireSession);
      if (!byKey) next.floors.set(expectedWireSession, (byKey = new Map()));
      let byDevice = byKey.get(expectedKeyId);
      if (!byDevice) byKey.set(expectedKeyId, (byDevice = new Map()));
      byDevice.set(envelope.deviceId, seq);
      try {
        // 先落 replay floor，再允许任何 agent / 本地配置副作用。
        this.persist(next);
      } catch (error) {
        this.poisoned = new E2EControlError(
          "failed to persist replay floor; verifier is poisoned until restart/repair",
          { cause: error },
        );
        throw this.poisoned;
      }
      this.state = next;
    } catch (error) {
      throw error;
    } finally {
      try {
        release();
      } catch (error) {
        this.poisoned = new E2EControlError(
          "failed to release replay lock; verifier is poisoned until restart/repair",
          { cause: error },
        );
        throw this.poisoned;
      }
    }
    return { envelope, kind: envelope.kind, payload: payload as Record<string, unknown> };
  }
}
