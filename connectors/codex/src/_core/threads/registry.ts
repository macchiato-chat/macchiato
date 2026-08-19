/**
 * #950（父 #926）`ThreadRegistry` —— 四家连接器共用的「对话 ↔ 执行线程」别名表。
 *
 * ## 为什么要有它
 *
 * 每家 agent 的**执行产物**都会增殖或轮换：codex 子 agent 从父线程 fork 出新 rollout、hermes 上
 * 下文压缩换一个 `sessions.id`、OpenClaw 会话重置换一份 transcript、CC 的 `--resume` 另起一档。
 * 我们却把「一段对话」的身份直接定义成了这个执行产物的 id，于是同一段对话要么在列表里长出好几
 * 行（噪音），要么被劈成两条、原来那条静默停更（**用户会以为历史丢了**，更伤）。
 *
 * 四家里只有 openclaw 做对了：gateway 的稳定 `key` 当身份，另持一张 `key → transcript sessionId`
 * 的别名表（#211/#347），换文件也认得同一段对话。本模块就是把那套抽出来给四家共用——它同时是
 * IMAP `UIDVALIDITY` 的老教训：**身份要么来自源系统并被持久化，要么就会在每次重扫时重新长出来。**
 *
 * ## 三个不变式
 *
 * - **I1**：每条 thread 恰好属于一个 conversation。
 * - **I2**：conversation 的**上报身份**（wire identity）在首次确立后**永不轮换**——server 的会话
 *   行按它认身份、E2E 的 K_S 也按它存键。轮换身份 = 服务器另起一行 + 密钥查不到（#807）。
 * - **I3**：历代 threadId 全部永久保留为别名，只增不删。
 *
 * ## fail-closed（照抄 openclaw #347）
 *
 * > 「aliases 是否涵蓋此 registry 建立以來的完整歷史。**不可由「字段存在」推斷**：舊 schema 在
 * > protected 狀態下補 seed 仍可能早已丟過 rotation alias，必須持久 false。」
 *
 * 所以 `historyTrusted` 只有两个来源：快照里**显式**写着 `true`，或调用方在能证明「此刻没有任何
 * 东西可丢」时显式 `adoptHistory(true)`。缺字段、解析失败、旧 schema 一律 `false`，
 * 而 `false` 时 `aliasesFor()` 恒返回空 —— **别名历史不可信就不得按新身份上报，维持旧身份。**
 *
 * ## 本模块**不做**什么
 *
 * 不落盘、不认识任何一家的目录结构。持久化由各家连接器把 `toJSON()` 塞进自己既有的 state 文件
 * （openclaw 是 mirror state、codex/CC 是各自的 mirror state）——那些文件的原子写、备份、锁都已
 * 经存在，再造一份只会多一处不一致。
 */

/** 落盘形状。字段全可选：老 state 文件天然缺它们，解析出来就是一张空的、不可信的表。 */
export interface ThreadRegistrySnapshot {
  /**
   * conversationId → 该对话历代**所有** threadId，**按首次见到的顺序**。
   * `[0]` 是首次确立的身份（I2：上报与 K_S 都锚在它上面），末位是当前活跃线程。
   */
  threads?: Record<string, string[]>;
  /**
   * 别名是否涵盖此 registry 建立以来的**完整**历史。见上「fail-closed」：不可由字段存在推断。
   */
  aliasHistoryTrusted?: boolean;
}

/** 快照非法（调用方应按「空 + 不可信」继续，绝不可当成「没有别名」放行）。 */
export class ThreadRegistryParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThreadRegistryParseError";
  }
}

export class ThreadRegistry {
  /** conversationId → 历代 threadId（有序、去重）。 */
  private readonly byConversation = new Map<string, string[]>();
  /** threadId → conversationId（反查索引，随 byConversation 同步维护）。 */
  private readonly conversationByThread = new Map<string, string>();
  private trusted = false;

  private constructor(snapshot?: ThreadRegistrySnapshot) {
    for (const [conversationId, threads] of Object.entries(snapshot?.threads ?? {})) {
      this.byConversation.set(conversationId, [...threads]);
      for (const t of threads) this.conversationByThread.set(t, conversationId);
    }
    // 只认显式的 true。缺字段 / 旧 schema / undefined 一律不可信。
    this.trusted = snapshot?.aliasHistoryTrusted === true;
  }

  /** 全新的表：空且**不可信**（还没人证明过它涵盖完整历史）。 */
  static empty(): ThreadRegistry {
    return new ThreadRegistry();
  }

  /**
   * 严格解析持久化快照。形状不对就抛——调用方应 catch 后退回 `empty()`（空且不可信），
   * **绝不可**把「解析失败」当成「这个对话没有别名」，那正是 #347 要防的那一刀。
   */
  static parse(raw: unknown): ThreadRegistry {
    if (raw === undefined || raw === null) return ThreadRegistry.empty();
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new ThreadRegistryParseError("thread registry 快照必须是对象");
    }
    const obj = raw as Record<string, unknown>;
    const snapshot: ThreadRegistrySnapshot = {};
    if (obj.threads !== undefined) {
      if (obj.threads === null || typeof obj.threads !== "object" || Array.isArray(obj.threads)) {
        throw new ThreadRegistryParseError("thread registry threads 必须是对象");
      }
      const threads: Record<string, string[]> = {};
      const seen = new Set<string>();
      for (const [conversationId, value] of Object.entries(obj.threads)) {
        if (!conversationId) throw new ThreadRegistryParseError("thread registry 的 conversationId 为空");
        if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v)) {
          throw new ThreadRegistryParseError(`thread registry ${conversationId} 的线程表非法`);
        }
        const list = value as string[];
        if (new Set(list).size !== list.length) {
          throw new ThreadRegistryParseError(`thread registry ${conversationId} 的线程 id 重复`);
        }
        // I1：一条 thread 只能属于一个 conversation；跨对话重复 = 表已经坏了，不许静默取一个。
        for (const t of list) {
          if (seen.has(t)) {
            throw new ThreadRegistryParseError(`thread ${t} 同时属于多个 conversation`);
          }
          seen.add(t);
        }
        threads[conversationId] = list;
      }
      snapshot.threads = threads;
    }
    if (obj.aliasHistoryTrusted !== undefined && typeof obj.aliasHistoryTrusted !== "boolean") {
      throw new ThreadRegistryParseError("thread registry aliasHistoryTrusted 必须是布尔");
    }
    if (obj.aliasHistoryTrusted === true && snapshot.threads === undefined) {
      // 声称「历史完整」却没有别名表 —— 自相矛盾，按不可信处理。
      throw new ThreadRegistryParseError("thread registry 声称历史可信但没有 threads 字段");
    }
    if (typeof obj.aliasHistoryTrusted === "boolean") snapshot.aliasHistoryTrusted = obj.aliasHistoryTrusted;
    return new ThreadRegistry(snapshot);
  }

  /** 别名历史是否涵盖此表建立以来的完整历史（见「fail-closed」）。 */
  get historyTrusted(): boolean {
    return this.trusted;
  }

  /**
   * 声明别名历史完整。**只有调用方能判断**这一点：它要能证明此刻没有任何东西可丢
   * （openclaw 的判据 = 零 protected E2E 会话 ∧ 已套用权威 server 快照）。
   * `canAdopt` 为假时不做任何事——一旦是 false 就必须持久 false，不许自升。
   */
  adoptHistory(canAdopt: boolean): boolean {
    if (!canAdopt || this.trusted) return false;
    this.trusted = true;
    return true;
  }

  /**
   * 记一条「这条线程属于这段对话」。返回是否发生变化（调用方据此决定要不要落盘）。
   *
   * **必须在读/发这条新线程的内容之前先持久化**：崩在中间会让别名丢失一环，而
   * `historyTrusted` 是持久 true 的——丢了就再也发现不了。openclaw 的
   * `recordFileIdentity` + `persistIdentityStateOrThrow` 就是这个顺序。
   */
  record(conversationId: string, threadId: string): boolean {
    if (!conversationId || !threadId) throw new Error("ThreadRegistry.record: 空的 conversationId/threadId");
    const owner = this.conversationByThread.get(threadId);
    if (owner && owner !== conversationId) {
      // I1 被打破 = 上游给的血缘自相矛盾。响亮失败，不要静默改归属：那会把一条会话的
      // 全部消息搬到另一条下面。
      throw new Error(
        `ThreadRegistry: thread ${threadId} 已属于 conversation ${owner}，拒绝改挂到 ${conversationId}`,
      );
    }
    const list = this.byConversation.get(conversationId);
    if (!list) {
      this.byConversation.set(conversationId, [threadId]);
      this.conversationByThread.set(threadId, conversationId);
      return true;
    }
    if (list.includes(threadId)) return false;
    list.push(threadId);
    this.conversationByThread.set(threadId, conversationId);
    return true;
  }

  /** 这条线程属于哪段对话（未登记 → undefined）。 */
  conversationOf(threadId: string): string | undefined {
    return this.conversationByThread.get(threadId);
  }

  /**
   * 该对话**首次确立**的身份（I2）：上报给 server 的 `hermesSessionId`、E2E 的 K_S 键都用它。
   * 源系统换了 id 也**映射而不是另建**——这正是 openclaw 一年来没长出重复会话的原因。
   */
  wireIdentityOf(conversationId: string): string | undefined {
    return this.byConversation.get(conversationId)?.[0];
  }

  /** 该对话当前活跃的线程（末位 = 最近一次 record 的）。 */
  currentThreadOf(conversationId: string): string | undefined {
    const list = this.byConversation.get(conversationId);
    return list?.[list.length - 1];
  }

  /** 该对话的历代全部线程（只读副本）。 */
  threadsOf(conversationId: string): readonly string[] {
    return [...(this.byConversation.get(conversationId) ?? [])];
  }

  /**
   * 与 `threadId` 同属一段对话的**其它**线程 id，**首次确立的那个排在最前**。
   *
   * **历史不可信时恒为空** —— 这是 fail-closed 那道闸的落点：拿不到别名，调用方就查不到旧键、
   * 也就不会按新身份上报，只能维持旧身份（老行为），而不是落进 #807 那条「connector-ahead
   * 永久不可恢复」。
   */
  aliasesFor(threadId: string): readonly string[] {
    if (!this.trusted) return [];
    const conversationId = this.conversationByThread.get(threadId);
    if (!conversationId) return [];
    return (this.byConversation.get(conversationId) ?? []).filter((t) => t !== threadId);
  }

  /**
   * 交给 `E2EKeyStore.setIdentityAliases()` 的解析器：身份换成 `conversationId` 之后，存量会话的
   * K_S 还压在旧键（threadId）下，直查必然 miss。
   *
   * 只在 `historyTrusted` 时给候选；否则空数组 = keystore 行为与今天逐字节一致。
   */
  identityAliasResolver(): (sid: string) => readonly string[] {
    return (sid) => this.aliasesFor(sid);
  }

  /** 落盘形状。`aliasHistoryTrusted` 一律显式写出，缺字段等于不可信。 */
  toJSON(): Required<ThreadRegistrySnapshot> {
    const threads: Record<string, string[]> = {};
    for (const [conversationId, list] of this.byConversation) threads[conversationId] = [...list];
    return { threads, aliasHistoryTrusted: this.trusted };
  }
}
