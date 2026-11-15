/**
 * 大模型客户端 —— OpenAI 兼容协议（/v1/chat/completions）。
 *
 * 为什么只做这一种协议：DeepSeek / MiniMax / 通义 / 硅基流动 / OpenAI / 智谱
 * 全都是 OpenAI 兼容的，一份代码通吃，不用为每家写适配层。
 *
 * 配置从哪来（优先级从高到低）：
 *   ① 环境变量 MISHU_LLM_API_KEY / MISHU_LLM_BASE_URL / MISHU_LLM_MODEL
 *   ② data/greet-config.json 里的 llm 段（data/ 在 .gitignore 里，key 不会进仓库）
 *
 * ⚠️ **key 绝不能进仓库** —— 这个项目是公开的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
export const CONFIG_FILE = path.join(DATA_DIR, 'greet-config.json');
/** 项目根目录的 .env（已 gitignore —— key 不能进仓库） */
const DOTENV_FILE = path.resolve(DATA_DIR, '..', '.env');

export interface LlmConfig {
  /** 形如 https://api.deepseek.com/v1（不带结尾斜杠） */
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * 读项目根目录的 .env。
 *
 * 自己解析而不是用 process.loadEnvFile()：要的是「拿到值、按优先级挑」，
 * 而不是「把值塞进 process.env」（那样分不清是 .env 来的还是环境变量来的）。
 *
 * 格式上要容得下 `BASE_URL = "https://xxx"` 这种写法：
 * 等号两边有空格、值带引号。
 */
function readDotEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  let text = '';
  try {
    text = fs.readFileSync(DOTENV_FILE, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]!] = v;
  }
  return out;
}

/** 从配置文件读 llm 段（没有就返回空对象） */
function llmFromFile(): Partial<LlmConfig> {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const cfg = JSON.parse(raw);
    return (cfg?.llm ?? {}) as Partial<LlmConfig>;
  } catch {
    return {};
  }
}

/**
 * 拼出最终的 LLM 配置。
 *
 * 优先级：MISHU_LLM_* 环境变量 > .env > data/greet-config.json
 * 没有任何一项就算「没配」—— 宁可明确报错，也不要拿着半截配置去调，
 * 那会得到一堆看不懂的 401。
 */
export function loadLlmConfig(): LlmConfig | null {
  const file = llmFromFile();
  const dotenv = readDotEnv();
  const baseUrl = String(
    process.env.MISHU_LLM_BASE_URL || dotenv.BASE_URL || file.baseUrl || '',
  ).trim();
  const apiKey = String(
    process.env.MISHU_LLM_API_KEY || dotenv.API_KEY || file.apiKey || '',
  ).trim();
  const model = String(
    process.env.MISHU_LLM_MODEL || dotenv.MODEL || file.model || '',
  ).trim();
  if (!baseUrl || !apiKey || !model) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    model,
    temperature: Number(process.env.MISHU_LLM_TEMPERATURE ?? file.temperature ?? 0.4),
    // 推理模型（deepseek-flash / deepseek-reasoner）的思考过程也吃 max_tokens。
    // 给小了它会「想完就没了」——正文是空的。用户明确要求：**不设小截断，让它想**。
    maxTokens: Number(process.env.MISHU_LLM_MAX_TOKENS ?? file.maxTokens ?? 32000),
    timeoutMs: Number(process.env.MISHU_LLM_TIMEOUT_MS ?? file.timeoutMs ?? 240_000),
  };
}

/** 缺配置时给一行能照着做的提示 */
export function llmMissingHint(): string {
  return [
    '没配大模型，设置这三个环境变量（或写进 data/greet-config.json 的 llm 段）：',
    '  MISHU_LLM_BASE_URL=https://<你的 OpenAI 兼容地址>/v1',
    '  MISHU_LLM_API_KEY=<你的 key>',
    '  MISHU_LLM_MODEL=<模型名>',
  ].join('\n');
}

interface ChatResponse {
  choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[];
  error?: { message?: string };
  usage?: { total_tokens?: number };
}

/**
 * 调一次对话补全，返回文本。
 *
 * ⚠️ **带思维链的模型会先花掉一截 token 思考**（deepseek-flash / deepseek-reasoner
 * 这类），返回里正文在 `content`、思考过程在 `reasoning_content`。
 * 如果 token 上限给得不够，模型会**想完就没了** —— `content` 是空的，
 * `finish_reason` 是 `length`。
 *
 * 所以：正文空 + 还有思考内容 → 说明是**预算不够**，加倍重试一次，
 * 而不是当成「模型没话说」。
 */
export async function chat(
  cfg: LlmConfig,
  messages: LlmMessage[],
  opts: { json?: boolean; signal?: AbortSignal; maxTokens?: number } = {},
): Promise<string> {
  let budget = opts.maxTokens ?? cfg.maxTokens ?? 6000;

  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await chatOnce(cfg, messages, budget, opts.json, opts.signal);
    if (out.content.trim()) return out.content;
    // 正文空 —— 但有思考内容 → 是预算不够，加倍再来一次
    if (out.reasoning && attempt === 0) {
      budget = Math.min(budget * 3, 131072);
      continue;
    }
    throw new Error(
      out.reasoning
        ? `大模型的正文是空的（思考了 ${out.reasoning.length} 字但没写正文），token 上限 ${budget} 可能不够`
        : '大模型返回了空内容',
    );
  }
  throw new Error('大模型返回了空内容');
}

/** 单次请求 */
async function chatOnce(
  cfg: LlmConfig,
  messages: LlmMessage[],
  maxTokens: number,
  json?: boolean,
  signal?: AbortSignal,
): Promise<{ content: string; reasoning: string }> {
  const url = `${cfg.baseUrl}/chat/completions`;
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature ?? 0.4,
    max_tokens: maxTokens,
    stream: false,
  };
  if (json) body.response_format = { type: 'json_object' };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(cfg.timeoutMs ?? 90_000),
  });

  const text = await res.text();
  if (!res.ok) {
    // 把服务端说的原话带出来 —— 「401」「模型不存在」这类信息最有价值
    throw new Error(`大模型返回 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  let json_: ChatResponse;
  try {
    json_ = JSON.parse(text);
  } catch {
    throw new Error('大模型返回的不是 JSON：' + text.slice(0, 200));
  }
  if (json_.error?.message) throw new Error('大模型报错：' + json_.error.message);

  const msg = json_.choices?.[0]?.message;
  return {
    content: String(msg?.content ?? ''),
    reasoning: String(msg?.reasoning_content ?? ''),
  };
}

/**
 * 从模型回复里抠出 JSON。
 *
 * 模型经常在 JSON 外面裹一层 ```json ... ```，还爱在前面加一句「好的，以下是…」。
 * 所以：先剥代码块，再从第一个 [ 或 { 开始截。
 */
export function extractJson<T = any>(raw: string): T {
  let s = String(raw).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1]!.trim();

  const start = s.search(/[[{]/);
  if (start === -1) throw new Error('大模型回复里找不到 JSON：' + s.slice(0, 200));

  const open = s[start]!;
  const close = open === '{' ? '}' : ']';
  const end = s.lastIndexOf(close);
  if (end === -1) throw new Error('大模型回复里的 JSON 不完整：' + s.slice(0, 200));

  return JSON.parse(s.slice(start, end + 1));
}
