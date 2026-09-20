/**
 * oss-shortlink 类型定义
 */

import type { Server, IncomingMessage, ServerResponse } from 'http';

export type StreamMode = 'redirect' | 'proxy';
export type LinkMode = 'player' | 'jump';

export interface OssOptions {
  /** 是否对私有读 Bucket 现场签名，默认 false */
  signedRead?: boolean;
  /** Bucket 名，签名时必填 */
  bucket?: string;
  /** RAM 子账号 AccessKeyId，建议只给该 Bucket 的只读权限 */
  accessKeyId?: string;
  accessKeySecret?: string;
  /** 签名有效期（秒），默认 300 */
  signTtlSeconds?: number;
}

export interface ShortlinkOptions {
  /** 监听端口，默认 3000 */
  port?: number;
  /** 监听地址，默认 127.0.0.1 */
  host?: string;
  /** 对外访问前缀，如 https://v.example.com。会影响 shareUrl 与播放页里的绝对地址 */
  publicBaseUrl?: string;
  /** 管理台与管理接口密钥。不给则管理相关端点返回 503 */
  adminKey?: string;
  /** 自动生成短码的长度，4-16，默认 6 */
  codeLength?: number;
  /** 播放页显示的品牌名 */
  brand?: string;
  /** 播放页底部补充文字 */
  footerText?: string;
  /** 取流方式，默认 'redirect'（302 直跳，服务器零带宽） */
  streamMode?: StreamMode;
  /** 视图模板目录，默认内置 views/ */
  viewDir?: string;
  /** 是否打印访问日志，默认 true */
  logRequests?: boolean;
  /** 有改动时的落盘间隔（毫秒），0 表示不定时落盘，默认 5000 */
  flushIntervalMs?: number;
  oss?: OssOptions;
  /** 存储适配器：对象、或直接给文件路径字符串 */
  store?: Store | string;
  /** 便捷写法：等价于 store = fileStore(dataFile) */
  dataFile?: string;
  /** 直接从配置文件启动（CLI 用），会忽略上面的平铺配置项。文件不存在即报错 */
  configFile?: string;
  /** 是否用环境变量 PORT / HOST / ADMIN_KEY / PUBLIC_BASE_URL 覆盖配置，默认 false */
  applyEnv?: boolean;
  /** 覆盖内置视图模板 */
  templates?: Partial<Record<'player.html' | 'admin.html' | '404.html', string>>;
  /** 是否记录扫码量，默认 true。不需要统计就设 false，省掉全部计数 I/O */
  trackHits?: boolean;
  /** 计数增量多久追加一次日志，默认 1000 毫秒；0 表示每次命中立刻追加 */
  hitAppendIntervalMs?: number;
  /** 计数多久压实一次全量快照，默认 300000 毫秒（5 分钟） */
  hitCompactIntervalMs?: number;
  /** 日志超过这个大小就提前压实，默认 4 MB；0 表示不限制 */
  hitJournalMaxBytes?: number;
  /** 自定义日志函数 */
  log?: (line: string) => void;
  /** 自定义时间源，便于测试注入 */
  now?: () => number;
}

export interface ResolvedConfig {
  port: number;
  host: string;
  publicBaseUrl: string;
  adminKey: string;
  codeLength: number;
  brand: string;
  footerText: string;
  streamMode: StreamMode;
  viewDir: string;
  logRequests: boolean;
  flushIntervalMs: number;
  /** 是否记录扫码量，默认 true。设为 false 则完全不写计数、零额外 I/O */
  trackHits: boolean;
  /** 计数增量多久追加一次日志，默认 1000；0 表示每次命中立刻追加 */
  hitAppendIntervalMs: number;
  /** 计数多久压实一次全量快照，默认 300000（5 分钟）；0 表示只在 close 时压实 */
  hitCompactIntervalMs: number;
  /** 日志超过这个大小就提前压实，默认 4 MB；0 表示不限制 */
  hitJournalMaxBytes: number;
  oss: Required<OssOptions>;
  /** 配置文件来源，仅 configFile 启动时有 */
  __source?: string;
}

export interface LinkRecord {
  code: string;
  title: string;
  desc: string;
  videoUrl: string;
  cover: string;
  mode: LinkMode;
  enabled: boolean;
  createdAt: string;
  updatedAt: string | null;
  hits: number;
  lastHitAt: string | null;
}

export interface LinkInput {
  videoUrl: string;
  title?: string;
  desc?: string;
  cover?: string;
  mode?: LinkMode;
  /** 自定义短码，不填则随机生成 */
  code?: string;
  enabled?: boolean;
}

export interface LinkPatch {
  title?: string;
  desc?: string;
  videoUrl?: string;
  cover?: string;
  mode?: LinkMode;
  enabled?: boolean;
}

export interface CreateResult {
  code: string;
  shareUrl: string;
  link: LinkRecord;
}

export interface LinkManager {
  create(input: LinkInput): CreateResult;
  get(code: string): LinkRecord | undefined;
  /** 取记录，不存在时抛出带 status=404 的错误 */
  require(code: string): LinkRecord;
  has(code: string): boolean;
  update(code: string, patch: LinkPatch): LinkRecord;
  /** 返回是否真的删掉了记录，重复删除返回 false 而不报错 */
  remove(code: string): boolean;
  /** 按创建时间倒序 */
  list(): LinkRecord[];
  /** 只数个数，不做排序 */
  count(): number;
  /** 分页 + 关键词搜索。limit <= 0 表示不分页 */
  page(opts?: { limit?: number; offset?: number; q?: string }): LinkPage;
  touch(code: string): LinkRecord | null;
  shareUrl(code: string): string;
}

export interface LinkPage {
  /** 过滤后的总数，不是本页条数 */
  total: number;
  offset: number;
  limit: number;
  list: LinkRecord[];
}

/**
 * 落盘的文档结构。
 * 注意 links 里的记录**不含** hits / lastHitAt —— 计数另有归宿：
 * 默认由 store.counters 单独存放，存储不支持时才会内联在 db.counts 里。
 * 对外 API（LinkRecord）依然带 hits，那是读取时合并出来的。
 */
export interface Db {
  version: number;
  links: Record<string, Omit<LinkRecord, 'hits' | 'lastHitAt'>>;
  counts?: Record<string, HitCount>;
}

export interface HitCount {
  hits: number;
  lastHitAt: string | null;
}

/** 一次访问的增量。seq 全局单调递增，是崩溃恢复时判断「是否已并入快照」的依据。 */
export interface HitIncrement {
  seq: number;
  code: string;
  at: number;
}

export interface CounterSnapshot {
  counts: Record<string, HitCount>;
  seq: number;
}

/**
 * 计数器后端。实现这三个方法后，访问计数就与短链定义分开落盘，
 * 一次扫码不会再去重写整个定义文档。
 */
export interface CounterBackend {
  load(): Promise<CounterSnapshot | Record<string, HitCount>>;
  /** 高频：只收增量，应当做成 O(1)（追加日志 / INCRBY），与短链总数无关 */
  applyIncrements(items: HitIncrement[]): Promise<void> | void;
  /** 低频：全量快照，可以做压实与清理 */
  saveSnapshot(counts: Record<string, HitCount>, seq: number): Promise<void> | void;
}

export interface Store {
  kind?: string;
  file?: string;
  load(): Promise<Db>;
  save(db: Db): Promise<void>;
  /** 可选。缺省时计数会内联进 db.counts，跟着定义一起落盘（1.1.x 行为） */
  counters?: CounterBackend;
}

export type CounterMode = 'separate' | 'inline' | 'off';

export interface CounterStats {
  mode: CounterMode;
  /** 有计数的短码数量 */
  tracked: number;
  /** 还没写进增量日志的命中数 */
  pending: number;
  /** 当前全局命中序号 */
  seq: number;
  journalBytes: number;
}

export interface CounterManager {
  mode: CounterMode;
  get(code: string): HitCount | null;
  record(code: string, atMs?: number): HitCount | null;
  drop(code: string): void;
  prune(exists: (code: string) => boolean): number;
  flush(): Promise<void>;
  compact(): Promise<void>;
  snapshot(): Record<string, HitCount>;
  stats(): CounterStats;
  close(): Promise<void>;
}

export interface Renderer {
  escapeHtml(value: unknown): string;
  fill(html: string, vars: Record<string, unknown>): string;
  raw(name: string): string;
  player(link: LinkRecord): string;
  admin(): string;
  notFound(): string;
  clearCache(): void;
}

export interface Stats {
  links: number;
  streamMode: StreamMode;
  signedRead: boolean;
  storeKind: string;
  dirty: boolean;
  counters: CounterStats;
}

export interface ShortlinkApp {
  config: ResolvedConfig;
  store: Store;
  links: LinkManager;
  render: Renderer;
  /** 访问计数管理器（诊断 / 测试用） */
  counters: CounterManager;
  /** 可直接挂到任意 http server 上 */
  handler(req: IncomingMessage, res: ServerResponse): void;
  listen(port?: number, host?: string): Server;
  attach(server: Server): Server;
  /** 深拷贝快照。links 里带回 hits（合并视图），另附独立的 counts */
  snapshot(): Db & { links: Record<string, LinkRecord> };
  stats(): Stats;
  save(): Promise<void>;
  close(): Promise<void>;
}

/** 创建一个短链服务实例。 */
export function createShortlink(options?: ShortlinkOptions): Promise<ShortlinkApp>;

/** 内存存储，进程退出即丢。 */
export function memoryStore(initial?: Db | null): Store & { snapshot(): Db };

/** 文件存储，原子写入。 */
export function fileStore(file: string): Store;

/** 自定义存储，需实现 load() 与 save()。 */
export function customStore(store: Store): Store;

export function normalizeDb(db: unknown): Db;

export declare const config: {
  normalize(input?: ShortlinkOptions): ResolvedConfig;
  /** 从一个明确的文件路径读配置；文件不存在时抛 code='CONFIG_NOT_FOUND' */
  loadFromFile(file: string, env?: NodeJS.ProcessEnv): ResolvedConfig;
  /** @deprecated 给定目录自动找 config.json / config.example.json，容易猜错文件 */
  loadFromDisk(rootDir: string, env?: NodeJS.ProcessEnv): ResolvedConfig;
  applyEnv<T extends { port: number; host: string; adminKey: string; publicBaseUrl: string; streamMode: StreamMode }>(cfg: T, env: NodeJS.ProcessEnv): T;
  normalizeStreamMode(value: unknown, fallback: StreamMode): StreamMode;
  isValidStreamMode(value: unknown): boolean;
  hasUsableAdminKey(cfg: { adminKey: string }): boolean;
};

export declare const codes: {
  randomCode(len: number): string;
  isValidCode(code: string): boolean;
  resolveCode(wanted: string, isTaken: (code: string) => boolean, len: number): string;
};

export declare const oss: {
  signUrl(rawUrl: string, oss: Required<OssOptions>, nowMs?: number): string;
  canSign(oss: OssOptions): boolean;
  resolveVideoUrl(link: { videoUrl: string }, oss: OssOptions, nowMs?: number): string;
  isHttpUrl(value: unknown): boolean;
};

export declare function createLinkManager(ctx: {
  getDb(): Db;
  markDirty(): void;
  getConfig(): ResolvedConfig;
  counters: CounterManager;
  now?: () => number;
}): LinkManager;

/** 计数器相关工具。想自己接 Redis / MySQL 时可以拿内置后端当参考实现。 */
export declare const counters: {
  create(opts: {
    mode?: CounterMode;
    backend?: CounterBackend | null;
    counts?: Record<string, HitCount>;
    seq?: number;
    appendIntervalMs?: number;
    compactIntervalMs?: number;
    maxJournalBytes?: number;
    markDirty?: () => void;
    log?: (line: string) => void;
    now?: () => number;
  }): CounterManager;
  memoryBackend(seed?: Record<string, HitCount>, seedSeq?: number): CounterBackend;
  /** 追加日志 + 低频快照的文件后端。base 是去掉 .json 的基名 */
  fileBackend(base: string): CounterBackend & { statsFile: string; journalFile: string; size(): number };
  isBackend(obj: unknown): boolean;
};

export declare const DB_VERSION: number;

export declare function createRenderer(opts: {
  viewDir: string;
  cfg: ResolvedConfig;
  templates?: Record<string, string>;
}): Renderer;

export declare function createRouter(ctx: {
  config: ResolvedConfig;
  links: LinkManager;
  render: Renderer;
  flush?: () => Promise<void> | void;
  log?: (line: string) => void;
}): {
  handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
  send: (...args: unknown[]) => void;
  sendJson: (...args: unknown[]) => void;
  sendHtml: (...args: unknown[]) => void;
  redirectTo: (res: ServerResponse, location: string) => void;
};

export declare const PLACEHOLDER_KEY: string;
export declare const version: string;
