import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizeE2EDisableResume,
  canonicalE2EApprovalDisplay,
  deriveE2EControlKey,
  dispatchForE2EControl,
  e2eApprovalRequestDigest,
  e2eControlKeyId,
  e2eControlMac,
  E2EControlError,
  E2EControlVerifier,
  immutableE2EApprovalSnapshot,
  type E2EControlEnvelopeV1,
  type E2EControlKind,
} from "../src/e2e/control";

const KEY = Buffer.from([...Array(32).keys()]);
const PUBLIC_SID = "01PUBLICSESSION00000000000001";
const WIRE_SID = "01WIRESESSION0000000000000001";
const NOW = 1_900_000_000_000;

type EnvelopeFields = Omit<E2EControlEnvelopeV1, "payloadB64" | "mac">;

function signedEnvelope(
  payload: Record<string, unknown>,
  overrides: Partial<EnvelopeFields> = {},
  sessionKey: Buffer = KEY,
): E2EControlEnvelopeV1 {
  const fields: EnvelopeFields = {
    v: 1,
    sessionId: PUBLIC_SID,
    hermesSessionId: WIRE_SID,
    deviceId: "device-test-1",
    keyId: e2eControlKeyId(sessionKey),
    msgId: "00000000-0000-4000-8000-000000000001",
    seq: "1",
    issuedAtMs: String(NOW),
    expiresAtMs: String(NOW + 300_000),
    kind: "command.invoke",
    ...overrides,
  };
  const raw = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    ...fields,
    payloadB64: raw.toString("base64"),
    mac: e2eControlMac(sessionKey, fields, raw),
  };
}

function keyProvider() {
  return {
    requireKey(sid: string): Buffer {
      if (sid !== WIRE_SID && sid !== `${WIRE_SID}-other`) throw new Error("missing key");
      return Buffer.from(KEY);
    },
  };
}

describe("#370 E2E control crypto + replay", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-control-auth-"));
    path = join(dir, "replay.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("固定跨语言向量：HKDF/keyId/长度前缀 HMAC 与 Swift/Python 对齐", () => {
    const payload = Buffer.from('{"command":"review"}', "utf8");
    const fields: EnvelopeFields = {
      v: 1,
      sessionId: "01HSESSION",
      hermesSessionId: "wire-1",
      deviceId: "device-A",
      keyId: e2eControlKeyId(KEY),
      msgId: "msg-0001",
      seq: "7",
      issuedAtMs: "1700000000000",
      expiresAtMs: "1700000300000",
      kind: "command.invoke",
    };
    expect(fields.keyId).toBe("Yw3NKWbEM2aRElRIu7JbT_QSpJxzLbLIq8G4WBvXEN0");
    expect(deriveE2EControlKey(KEY).toString("hex")).toBe(
      "a95965413eeeeee360ccbc235bb5b2ca2d5a706f01bb339d11d6189673281d9e",
    );
    expect(e2eControlMac(KEY, fields, payload)).toBe(
      "13u7V4UUOm1ichtZb9yiHZBiqrAecIm1X0CTIRUnvnU=",
    );
  });

  it("无本地签封 marker 的 raw disable resume 只回 found:false，不触发明文回灌", () => {
    const sent: Record<string, unknown>[] = [];
    const allowed = authorizeE2EDisableResume(
      { hasPendingDisable: () => false },
      { agentLinkId: "al-test", send: (frame) => sent.push(frame) },
      WIRE_SID,
    );
    expect(allowed).toBe(false);
    expect(sent).toEqual([{
      t: "e2e_backfill",
      agentLinkId: "al-test",
      hermesSessionId: WIRE_SID,
      mode: "disable",
      found: false,
    }]);
    expect(JSON.stringify(sent)).not.toContain("messages");
  });

  it("审批 requestDigest 使用 K_ctrl keyed HMAC，阻断 server 对低熵命令做字典猜测", () => {
    const value = { sessionId: WIRE_SID, requestId: "r1", command: "git status" };
    const digest = e2eApprovalRequestDigest(KEY, value);
    expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(e2eApprovalRequestDigest(KEY, value)).toBe(digest);
    expect(e2eApprovalRequestDigest(Buffer.alloc(32, 7), value)).not.toBe(digest);
    expect(() =>
      e2eApprovalRequestDigest(KEY, { requestId: "r2", integer: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow(/unsafe integer/);
    expect(() =>
      e2eApprovalRequestDigest(KEY, { requestId: "r2", fractional: 1.5 }),
    ).toThrow(/non-integer/);
  });

  it("审批 canonical 快照冻结完整执行参数，并把 bidi/零宽字符可视化；超 48KiB 直接拒绝", () => {
    const source = {
      command: "echo safe\u202e\u2066\u200bTAIL",
      nested: { suffix: "--dangerous-tail" },
    };
    const snapshot = immutableE2EApprovalSnapshot(source);
    const display = canonicalE2EApprovalDisplay(snapshot);
    source.command = "mutated";
    source.nested.suffix = "mutated";
    expect(snapshot).toEqual({
      command: "echo safe\u202e\u2066\u200bTAIL",
      nested: { suffix: "--dangerous-tail" },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.nested)).toBe(true);
    expect(display).toContain("\\u202e\\u2066\\u200bTAIL");
    expect(display).not.toContain("\u202e");
    expect(() => canonicalE2EApprovalDisplay({ command: "x".repeat(49 * 1024) })).toThrow(/display limit/);
  });

  it("合法信封先以 0600 原子持久 replay floor；重启后仍拒绝同帧", () => {
    const envelope = signedEnvelope({ command: "review", argsEnc: "enc-args" });
    const verifier = new E2EControlVerifier(keyProvider() as any, path, () => NOW);
    const verified = verifier.verifyAndConsume(envelope, WIRE_SID);
    expect(verified.kind).toBe("command.invoke");
    expect(verified.payload).toEqual({ command: "review", argsEnc: "enc-args" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}.bak`).mode & 0o777).toBe(0o600);
    expect(() =>
      new E2EControlVerifier(keyProvider() as any, path, () => NOW).verifyAndConsume(
        envelope,
        WIRE_SID,
      ),
    ).toThrow(/replayed|out-of-order/);
  });

  it("两个 verifier 从同一旧快照启动时也由跨进程锁串行，第二个会重读并拒绝 replay", () => {
    const envelope = signedEnvelope({ command: "once" });
    const first = new E2EControlVerifier(keyProvider() as any, path, () => NOW);
    const second = new E2EControlVerifier(keyProvider() as any, path, () => NOW);
    first.verifyAndConsume(envelope, WIRE_SID);
    expect(() => second.verifyAndConsume(envelope, WIRE_SID)).toThrow(/replayed|out-of-order/);
  });

  it("constructor 修复也持跨进程锁，遇到 live owner 不读写旧快照", () => {
    const envelope = signedEnvelope({ command: "floor" });
    new E2EControlVerifier(keyProvider() as any, path, () => NOW)
      .verifyAndConsume(envelope, WIRE_SID);
    const before = readFileSync(path, "utf8");
    mkdirSync(`${path}.lock`, { mode: 0o700 });
    writeFileSync(
      join(`${path}.lock`, "owner.json"),
      JSON.stringify({
        v: 1,
        pid: process.pid,
        token: "00000000-0000-4000-8000-000000000096",
        createdAtMs: NOW,
      }),
      { mode: 0o600 },
    );
    expect(() => new E2EControlVerifier(keyProvider() as any, path, () => NOW))
      .toThrow(/held by a live process/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("仅在 owner shape 完整且 PID 已死时原子回收 stale lock；无法证明则 fail closed", () => {
    const stalePath = join(dir, "stale-lock.json");
    const staleLock = `${stalePath}.lock`;
    mkdirSync(staleLock, { mode: 0o700 });
    writeFileSync(
      join(staleLock, "owner.json"),
      JSON.stringify({
        v: 1,
        pid: 2_000_000_000,
        token: "00000000-0000-4000-8000-000000000099",
        createdAtMs: NOW,
      }),
      { mode: 0o600 },
    );
    expect(
      new E2EControlVerifier(keyProvider() as any, stalePath, () => NOW)
        .verifyAndConsume(signedEnvelope({ command: "safe" }), WIRE_SID).kind,
    ).toBe("command.invoke");

    const abandonedReclaimPath = join(dir, "abandoned-reclaim.json");
    const abandonedReclaimLock = `${abandonedReclaimPath}.lock`;
    mkdirSync(abandonedReclaimLock, { mode: 0o700 });
    writeFileSync(
      join(abandonedReclaimLock, "owner.json"),
      JSON.stringify({
        v: 1,
        pid: 2_000_000_000,
        token: "00000000-0000-4000-8000-000000000097",
        createdAtMs: NOW,
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(abandonedReclaimLock, "reclaim.json"),
      JSON.stringify({
        v: 1,
        pid: 1_999_999_999,
        token: "00000000-0000-4000-8000-000000000098",
        createdAtMs: NOW,
      }),
      { mode: 0o600 },
    );
    expect(
      new E2EControlVerifier(keyProvider() as any, abandonedReclaimPath, () => NOW)
        .verifyAndConsume(signedEnvelope({ command: "recovered" }), WIRE_SID).kind,
    ).toBe("command.invoke");

    const unknownPath = join(dir, "unknown-lock.json");
    mkdirSync(`${unknownPath}.lock`, { mode: 0o700 });
    writeFileSync(join(`${unknownPath}.lock`, "owner.json"), "{bad", { mode: 0o600 });
    expect(() =>
      new E2EControlVerifier(keyProvider() as any, unknownPath, () => NOW)
        .verifyAndConsume(signedEnvelope({ command: "blocked" }), WIRE_SID),
    ).toThrow(/cannot prove/);
  });

  it("篡改任一已签字段、payload 或 MAC 都不能消费/执行", () => {
    const original = signedEnvelope({ command: "review" });
    const cases: E2EControlEnvelopeV1[] = [
      { ...original, sessionId: `${PUBLIC_SID}x` },
      { ...original, hermesSessionId: `${WIRE_SID}x` },
      { ...original, deviceId: "device-test-2" },
      { ...original, keyId: `A${original.keyId.slice(1)}` },
      { ...original, msgId: "00000000-0000-4000-8000-000000000002" },
      { ...original, seq: "2" },
      { ...original, issuedAtMs: String(NOW + 1) },
      { ...original, expiresAtMs: String(NOW + 299_999) },
      { ...original, kind: "approval.respond" },
      { ...original, payloadB64: Buffer.from('{"command":"pwn"}').toString("base64") },
      { ...original, mac: `${original.mac[0] === "A" ? "B" : "A"}${original.mac.slice(1)}` },
    ];
    for (const [index, envelope] of cases.entries()) {
      const verifier = new E2EControlVerifier(
        keyProvider() as any,
        join(dir, `tamper-${index}.json`),
        () => NOW,
      );
      expect(() => verifier.verifyAndConsume(envelope, WIRE_SID)).toThrow();
    }
  });

  it("拒绝 replay、低序乱序、跨会话移植；不同 device 有独立 floor", () => {
    const verifier = new E2EControlVerifier(keyProvider() as any, path, () => NOW);
    const seq2 = signedEnvelope(
      { command: "two" },
      { seq: "2", msgId: "00000000-0000-4000-8000-000000000002" },
    );
    verifier.verifyAndConsume(seq2, WIRE_SID);
    expect(() => verifier.verifyAndConsume(seq2, WIRE_SID)).toThrow(/replayed|out-of-order/);
    expect(() =>
      verifier.verifyAndConsume(
        signedEnvelope(
          { command: "one" },
          { seq: "1", msgId: "00000000-0000-4000-8000-000000000003" },
        ),
        WIRE_SID,
      ),
    ).toThrow(/replayed|out-of-order/);
    expect(() => verifier.verifyAndConsume(seq2, `${WIRE_SID}-other`)).toThrow(/session mismatch/);

    const secondDevice = signedEnvelope(
      { command: "device-two" },
      {
        deviceId: "device-test-2",
        seq: "1",
        msgId: "00000000-0000-4000-8000-000000000004",
      },
    );
    expect(verifier.verifyAndConsume(secondDevice, WIRE_SID).payload.command).toBe("device-two");
  });

  it("首次合法消费原子绑定 public↔wire；重启、换 device 与轮换 K_S 后均拒绝同 wire alias", () => {
    new E2EControlVerifier(keyProvider() as any, path, () => NOW).verifyAndConsume(
      signedEnvelope({ command: "bind" }),
      WIRE_SID,
    );
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      version: 2,
      bindings: { [WIRE_SID]: PUBLIC_SID },
    });

    const rotatedKey = Buffer.alloc(32, 9);
    const alias = signedEnvelope(
      { command: "alias" },
      {
        sessionId: `${PUBLIC_SID}-alias`,
        deviceId: "device-after-rotation",
        msgId: "00000000-0000-4000-8000-000000000090",
      },
      rotatedKey,
    );
    const restarted = new E2EControlVerifier(
      { requireKey: () => rotatedKey } as any,
      path,
      () => NOW,
    );
    expect(() => restarted.verifyAndConsume(alias, WIRE_SID)).toThrow(/binding mismatch/);
  });

  it("严格拒绝非 canonical UInt64、过期/超长时效与额外 envelope 字段", () => {
    const verifier = new E2EControlVerifier(keyProvider() as any, path, () => NOW);
    expect(() =>
      verifier.verifyAndConsume(
        signedEnvelope({ command: "x" }, { seq: "01" }),
        WIRE_SID,
      ),
    ).toThrow(/canonical UInt64/);
    expect(() =>
      verifier.verifyAndConsume(
        signedEnvelope(
          { command: "x" },
          { issuedAtMs: String(NOW - 300_001), expiresAtMs: String(NOW - 1) },
        ),
        WIRE_SID,
      ),
    ).toThrow(/expired|lifetime/);
    expect(() =>
      verifier.verifyAndConsume(
        signedEnvelope({ command: "x" }, { expiresAtMs: String(NOW + 300_001) }),
        WIRE_SID,
      ),
    ).toThrow(/lifetime/);
    expect(() =>
      verifier.verifyAndConsume({ ...signedEnvelope({ command: "x" }), extra: true }, WIRE_SID),
    ).toThrow(/shape/);
  });

  it("store 双快照全坏与 fsync/rename 写失败均 fail closed；写失败后 verifier 毒化", () => {
    writeFileSync(path, "{bad");
    writeFileSync(`${path}.bak`, "{bad");
    chmodSync(path, 0o600);
    chmodSync(`${path}.bak`, 0o600);
    expect(() => new E2EControlVerifier(keyProvider() as any, path, () => NOW)).toThrow(
      /primary is unavailable/,
    );

    const failingPath = join(dir, "write-failure.json");
    const verifier = new E2EControlVerifier(keyProvider() as any, failingPath, () => NOW);
    verifier.verifyAndConsume(signedEnvelope({ command: "first" }), WIRE_SID);
    unlinkSync(`${failingPath}.bak`);
    mkdirSync(`${failingPath}.bak`);
    expect(() =>
      verifier.verifyAndConsume(
        signedEnvelope(
          { command: "x" },
          { seq: "2", msgId: "00000000-0000-4000-8000-000000000005" },
        ),
        WIRE_SID,
      ),
    ).toThrow(/persist replay floor/);
    expect(() =>
      verifier.verifyAndConsume(
        signedEnvelope(
          { command: "y" },
          { seq: "3", msgId: "00000000-0000-4000-8000-000000000006" },
        ),
        WIRE_SID,
      ),
    ).toThrow(/poisoned/);
  });

  it("primary 单边损坏/缺失时绝不降级；backup 坏由持锁 constructor 修复", () => {
    const envelope = signedEnvelope({ command: "once" });

    const corruptPrimary = join(dir, "corrupt-primary.json");
    new E2EControlVerifier(keyProvider() as any, corruptPrimary, () => NOW)
      .verifyAndConsume(envelope, WIRE_SID);
    writeFileSync(corruptPrimary, "{bad");
    expect(
      () => new E2EControlVerifier(keyProvider() as any, corruptPrimary, () => NOW),
    ).toThrow(/primary is unavailable/);

    const missingPrimary = join(dir, "missing-primary.json");
    new E2EControlVerifier(keyProvider() as any, missingPrimary, () => NOW)
      .verifyAndConsume(envelope, WIRE_SID);
    unlinkSync(missingPrimary);
    expect(
      () => new E2EControlVerifier(keyProvider() as any, missingPrimary, () => NOW),
    ).toThrow(/primary is unavailable/);

    const corruptBackup = join(dir, "corrupt-backup.json");
    new E2EControlVerifier(keyProvider() as any, corruptBackup, () => NOW)
      .verifyAndConsume(envelope, WIRE_SID);
    writeFileSync(`${corruptBackup}.bak`, "{bad");
    const repaired = new E2EControlVerifier(keyProvider() as any, corruptBackup, () => NOW);
    expect(JSON.parse(readFileSync(`${corruptBackup}.bak`, "utf8")).version).toBe(2);
    expect(() => repaired.verifyAndConsume(envelope, WIRE_SID)).toThrow(/replayed|out-of-order/);
  });

  it("E2E 审批只允许单次 yes/no，always/all 一律禁用", () => {
    const digest = "A".repeat(43);
    expect(() =>
      dispatchForE2EControl("approval.respond", {
        blockId: "b1",
        requestId: "r1",
        requestDigest: digest,
        choice: "yes",
        all: true,
      }),
    ).toThrow(/scope/);
    expect(() =>
      dispatchForE2EControl("approval.respond", {
        blockId: "b1",
        requestId: "r1",
        requestDigest: digest,
        choice: "always",
        all: false,
      }),
    ).toThrow(/choice/);
    expect(() =>
      dispatchForE2EControl("approval.respond", {
        blockId: "b1",
        requestId: "r1",
        requestDigest: digest,
        choice: "always",
        all: true,
      }),
    ).toThrow();
    expect(
      dispatchForE2EControl("approval.respond", {
        blockId: "b1",
        requestId: "r1",
        requestDigest: digest,
        choice: "yes",
        all: false,
      }).method,
    ).toBe("approval.respond");
    for (const choice of ["allow", "deny"]) {
      expect(() =>
        dispatchForE2EControl("approval.respond", {
          blockId: "b1",
          requestId: "r1",
          requestDigest: digest,
          choice,
          all: false,
        }),
      ).toThrow(/choice/);
    }
  });

  it("完整 payload shape：config 语义字段、clarify/secret digest 均不可省略", () => {
    const digest = "A".repeat(43);
    expect(() =>
      dispatchForE2EControl("command.invoke", { command: "review", args: "plaintext" }),
    ).toThrow();
    expect(() => dispatchForE2EControl("command.invoke", {
      command: "review",
      argsEnc: "enc-args",
    })).toThrow(/disabled/);
    expect(
      dispatchForE2EControl("session.cwd.set", { cwd: "/repo" }),
    ).toEqual({ method: "session.create", params: { cwd: "/repo" } });
    expect(() =>
      dispatchForE2EControl("session.cwd.set", { value: "/repo" }),
    ).toThrow();
    expect(() =>
      dispatchForE2EControl("clarify.respond", {
        blockId: "b",
        requestId: "r",
        answer: "a",
        requestDigest: digest,
      }),
    ).toThrow();
    expect(
      dispatchForE2EControl("clarify.respond", {
        blockId: "b",
        requestId: "r",
        requestDigest: digest,
        answerEnc: "enc-answer",
      }),
    ).toEqual({
      method: "clarify.respond",
      params: {
        blockId: "b",
        request_id: "r",
        requestDigest: digest,
        answerEnc: "enc-answer",
      },
    });
    expect(() =>
      dispatchForE2EControl("secret.respond", {
        blockId: "b",
        requestId: "r",
        secret: "s",
        requestDigest: digest,
      }),
    ).toThrow();
    expect(
      dispatchForE2EControl("secret.respond", {
        blockId: "b",
        requestId: "r",
        requestDigest: digest,
        secretEnc: "enc-secret",
      }),
    ).toEqual({
      method: "secret.respond",
      params: {
        blockId: "b",
        request_id: "r",
        requestDigest: digest,
        secretEnc: "enc-secret",
      },
    });
    expect(() =>
      dispatchForE2EControl("approval.respond", {
        blockId: "b",
        requestId: "r",
        requestDigest: digest,
        choice: "yes",
        all: false,
        answer: "plaintext",
      }),
    ).toThrow();
    expect(() => dispatchForE2EControl("session.interrupt", {})).toThrow(/disabled/);
    expect(() => dispatchForE2EControl("session.interrupt", { extra: true })).toThrow();
    expect(() => dispatchForE2EControl("task.stop", { taskId: "task-1" })).toThrow(/disabled/);
    expect(() => dispatchForE2EControl("task.stop", { taskId: "" })).toThrow();
    expect(dispatchForE2EControl("session.e2e.disable", {})).toEqual({
      method: "session.e2e.disable",
      params: {},
    });
    expect(() => dispatchForE2EControl("session.e2e.disable", { force: true })).toThrow();
  });
});
