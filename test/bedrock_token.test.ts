import { describe, it, expect, vi, beforeEach } from "vitest";

// —— 边界 mock：在 import 目标模块前 hoist 生效，隔离外部依赖、杜绝副作用、捕获入参 ——
// hoisted spies 供各 factory 与断言共享（vi.mock 工厂被提升到文件顶部，只能引用 hoisted 值）。
const h = vi.hoisted(() => {
  const openaiCtor = vi.fn();
  const createMock = vi.fn(async () => ({
    usage: { prompt_tokens: 3, completion_tokens: 5 },
    choices: [{ message: { content: "ok" } }],
  }));
  const getTokenMock = vi.fn(async () => "minted-token-from-getToken");
  const provideTokenMock = vi.fn(async () => "minted-token-from-provider");
  const getTokenProviderMock = vi.fn(() => provideTokenMock);
  const bedrockRuntimeClientMock = vi.fn();
  return {
    openaiCtor,
    createMock,
    getTokenMock,
    provideTokenMock,
    getTokenProviderMock,
    bedrockRuntimeClientMock,
  };
});

// base OpenAI 类（非 AzureOpenAI）：捕获 `new OpenAI({ baseURL, apiKey })` 入参 → 断 apiKey/baseURL。
vi.mock("openai", () => ({
  default: class {
    chat: any;
    constructor(opts: any) {
      h.openaiCtor(opts);
      this.chat = { completions: { create: h.createMock } };
    }
  },
}));

// token generator：捕获 getToken 调用次数与入参；getTokenProvider 返回一个可捕获的 provider。
vi.mock("@aws/bedrock-token-generator", () => ({
  getToken: h.getTokenMock,
  getTokenProvider: h.getTokenProviderMock,
}));

// AC-6：断言全路径 0 个 `@aws-sdk/client-*` 服务客户端被构造（相关 mock not.toHaveBeenCalled）。
vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: h.bedrockRuntimeClientMock,
  InvokeModelCommand: vi.fn(),
  InvokeModelWithResponseStreamCommand: vi.fn(),
}));

// 隔离 config/logger（provider → abstract_provider → cache 会 import 它们）。
vi.mock("../src/config", () => ({ default: {} }));
vi.mock("../src/util/logger", () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// AC-5/AC-6 讲的是 provider 行为：import Story 1.3 的 provider 触发认证路径（QF-1 裁定）。
import BedrockOpenAI from "../src/providers/bedrock_openai";

const ENV_KEY = "AWS_BEARER_TOKEN_BEDROCK";

function buildProvider(config: any) {
  const p = new BedrockOpenAI();
  p.setModelData({ config, price_in: 0, price_out: 0, name: "bedrock-openai" });
  p.setKeyData({ id: 1, month_fee: 0, month_quota: 0, balance: 0, total_fee: 0 });
  return p;
}

function buildCtx() {
  return {
    status: 0,
    performanceMode: true, // 跳过 DB（saveThread 在 performanceMode 下早返回 null）
    body: undefined as any,
    set: vi.fn(),
    res: { write: vi.fn(), end: vi.fn() },
  };
}

function buildChatRequest() {
  return {
    model: "gpt",
    model_id: "openai.gpt-oss-20b",
    stream: false,
    messages: [{ role: "user", content: "hi" }],
  } as any;
}

// 取最后一次 `new OpenAI` 的入参。
function lastOpenAIArgs(): any {
  return h.openaiCtor.mock.calls[h.openaiCtor.mock.calls.length - 1][0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("bedrock-openai 出站认证矩阵", () => {
  // AC-7：P1 bearerToken 原样用作 apiKey、不铸（generator 调用 0 次）。
  it("P1 bearerToken → 原样作 apiKey，generator 0 次（AC-7/AC-5）", async () => {
    const p = buildProvider({ bearerToken: "user-supplied-bearer", region: "us-east-1" });
    await p.chat(buildChatRequest(), "sess-1", buildCtx());

    expect(h.getTokenMock).not.toHaveBeenCalled();
    expect(h.getTokenProviderMock).not.toHaveBeenCalled();
    expect(h.provideTokenMock).not.toHaveBeenCalled();

    const args = lastOpenAIArgs();
    expect(args.apiKey).toBe("user-supplied-bearer");
    expect(args.baseURL).toBe("https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1");
  });

  // AC-8：P2 credentials → 用该 AKSK 铸，结果作 apiKey。
  it("P2 credentials → 用该 AKSK 铸，结果作 apiKey（AC-8/AC-5）", async () => {
    const credentials = { accessKeyId: "AKID", secretAccessKey: "SECRET" };
    const p = buildProvider({ credentials, region: "eu-west-1" });
    await p.chat(buildChatRequest(), "sess-2", buildCtx());

    expect(h.getTokenMock).toHaveBeenCalledTimes(1);
    const getTokenArg = h.getTokenMock.mock.calls[0][0] as any;
    expect(getTokenArg.credentials).toEqual(credentials);
    expect(getTokenArg.region).toBe("eu-west-1");

    expect(h.getTokenProviderMock).not.toHaveBeenCalled();

    const args = lastOpenAIArgs();
    expect(args.apiKey).toBe("minted-token-from-getToken");
    expect(args.baseURL).toBe("https://bedrock-runtime.eu-west-1.amazonaws.com/openai/v1");
  });

  // AC-9：P3 默认链 → 均未配时走默认链铸，未传显式 credentials。
  it("P3 默认链 → 走默认链铸，未传显式 credentials（AC-9/AC-5）", async () => {
    const p = buildProvider({ region: "us-east-1" });
    await p.chat(buildChatRequest(), "sess-3", buildCtx());

    expect(h.getTokenProviderMock).toHaveBeenCalledTimes(1);
    const providerArg = (h.getTokenProviderMock.mock.calls[0][0] || {}) as any;
    expect(providerArg.credentials).toBeUndefined();
    expect(providerArg.region).toBe("us-east-1");
    expect(h.provideTokenMock).toHaveBeenCalledTimes(1);

    // 默认链不使用显式 credentials 版本的 getToken
    expect(h.getTokenMock).not.toHaveBeenCalled();

    const args = lastOpenAIArgs();
    expect(args.apiKey).toBe("minted-token-from-provider");
  });

  // AC-4：铸 token 的有效期默认 43200、硬上限 43200。
  it("AC-4：默认有效期 43200（P2）", async () => {
    const p = buildProvider({
      credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET" },
      region: "us-east-1",
    });
    await p.chat(buildChatRequest(), "sess-4", buildCtx());
    const getTokenArg = h.getTokenMock.mock.calls[0][0] as any;
    expect(getTokenArg.expiresInSeconds).toBe(43200);
  });

  it("AC-4：传入 >43200 被夹到 43200（改坏放大即转红）", async () => {
    const p = buildProvider({
      credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET" },
      region: "us-east-1",
      expiresInSeconds: 999999,
    });
    await p.chat(buildChatRequest(), "sess-5", buildCtx());
    const getTokenArg = h.getTokenMock.mock.calls[0][0] as any;
    expect(getTokenArg.expiresInSeconds).toBeLessThanOrEqual(43200);
    expect(getTokenArg.expiresInSeconds).toBe(43200);
  });

  it("AC-4：传入合法值（<43200）原样透传", async () => {
    const p = buildProvider({
      credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET" },
      region: "us-east-1",
      expiresInSeconds: 3600,
    });
    await p.chat(buildChatRequest(), "sess-6", buildCtx());
    const getTokenArg = h.getTokenMock.mock.calls[0][0] as any;
    expect(getTokenArg.expiresInSeconds).toBe(3600);
  });

  // AC-6：全路径 0 个 `@aws-sdk/client-*` 服务客户端被构造。
  it("AC-6：三条认证路径均不构造 @aws-sdk/client-* 服务客户端", async () => {
    await buildProvider({ bearerToken: "b", region: "us-east-1" }).chat(
      buildChatRequest(),
      "s-a",
      buildCtx()
    );
    await buildProvider({
      credentials: { accessKeyId: "A", secretAccessKey: "S" },
      region: "us-east-1",
    }).chat(buildChatRequest(), "s-b", buildCtx());
    await buildProvider({ region: "us-east-1" }).chat(buildChatRequest(), "s-c", buildCtx());

    expect(h.bedrockRuntimeClientMock).not.toHaveBeenCalled();
  });

  // AC-10：token 不经 process.env（运行前后 AWS_BEARER_TOKEN_BEDROCK 不变）。
  it("AC-10：token 不经 process.env（三路径运行前后 env 不变）", async () => {
    const before = process.env[ENV_KEY];
    expect(before).toBeUndefined();

    await buildProvider({ bearerToken: "b", region: "us-east-1" }).chat(
      buildChatRequest(),
      "e-a",
      buildCtx()
    );
    await buildProvider({
      credentials: { accessKeyId: "A", secretAccessKey: "S" },
      region: "us-east-1",
    }).chat(buildChatRequest(), "e-b", buildCtx());
    await buildProvider({ region: "us-east-1" }).chat(buildChatRequest(), "e-c", buildCtx());

    expect(process.env[ENV_KEY]).toBe(before);
    expect(process.env[ENV_KEY]).toBeUndefined();
  });

  // AD-6：region 单一真源，同喂 baseURL 与铸 token 两处（同一 region）。
  it("AD-6：region 同喂 baseURL 与铸 token（同一值）", async () => {
    const credentials = { accessKeyId: "AKID", secretAccessKey: "SECRET" };
    await buildProvider({ credentials, region: "ap-southeast-2" }).chat(
      buildChatRequest(),
      "r-1",
      buildCtx()
    );
    const getTokenArg = h.getTokenMock.mock.calls[0][0] as any;
    expect(getTokenArg.region).toBe("ap-southeast-2");
    expect(lastOpenAIArgs().baseURL).toContain("ap-southeast-2");
  });

  // AC-12/AD-6：mantle 形态经 provider 端到端仍参数化。
  it("endpointVariant=mantle → provider 用 mantle baseURL", async () => {
    await buildProvider({ bearerToken: "b", region: "us-east-1", endpointVariant: "mantle" }).chat(
      buildChatRequest(),
      "m-1",
      buildCtx()
    );
    expect(lastOpenAIArgs().baseURL).toBe("https://bedrock-mantle.us-east-1.api.aws/openai/v1");
  });
});
