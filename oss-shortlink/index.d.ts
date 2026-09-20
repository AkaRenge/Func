/**
 * oss-shortlink 类型定义
 */

import type { Server, IncomingMessage, ServerResponse } from 'http';

export type StreamMode = 'redirect' | 'proxy';
export type LinkMode = 'player' | 'jump';

export interface OssOptions {
  /** 是否对私有读 Bucket 现场签名，默认 false */
  signedRead?: boolean;
  /** 形如 oss-cn-hangzhou.aliyuncs.com，签名为空时可不填 */
  endpoint?: string;
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
  /** 直接从配置文件启动（CLI 用），会忽略上面的平铺配置项 */
  configFile?: string;
  /** 是否用环境变量 PORT / HOST / ADMIN_KEY / PUBLIC_BASE_URL 覆盖配置，默认 false */
  applyEnv?: boolean;
  /** 覆盖内置视图模板 */
  templates?: Partial<Record<'player.html' | 'admin.html' | '404.html', string>>;
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
  oss: Required<OssOptions>;
  /** 配置文件来源文件名，仅 configFile 启动时有 */
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
  touch(code: string): LinkRecord | null;
  shareUrl(code: string): string;
}

export interface Db {
  version: number;
  links: Record<string, LinkRecord>;
}

export interface Store {
  kind?: string;
  file?: string;
  load(): Promise<Db>;
  save(db: Db): Promise<void>;
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
}

export interface ShortlinkApp {
  config: ResolvedConfig;
  store: Store;
  links: LinkManager;
  render: Renderer;
  /** 可直接挂到任意 http server 上 */
  handler(req: IncomingMessage, res: ServerResponse): void;
  listen(port?: number, host?: string): Server;
  attach(server: Server): Server;
  snapshot(): Db;
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
  loadFromDisk(rootDir: string, env?: NodeJS.ProcessEnv): ResolvedConfig;
  applyEnv<T extends { port: number; host: string; adminKey: string; publicBaseUrl: string }>(cfg: T, env: NodeJS.ProcessEnv): T;
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
  now?: () => number;
}): LinkManager;

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
