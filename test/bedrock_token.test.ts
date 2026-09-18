import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// —— 边界 mock（hoist）：捕获 new OpenAI 入参、捕获铸 token 入参、隔离 helper 副作用 ——
const openAICtor = vi.fn();
vi.mock("openai", () => ({
  default: class {
    constructor(opts: unknown) {
      openAICtor(opts);
    }
  },
}));

const getToken = vi.fn();
const getTokenProvider = vi.fn();
vi.mock("@aws/bedrock-token-generator", () => ({
  getToken: (...args: unknown[]) => getToken(...args),
  getTokenProvider: (...args: unknown[]) => getTokenProvider(...args),
}));

const selectCredentials = vi.fn();
vi.mock("../src/util/helper", () => ({
  default: {
    selectCredentials: (...args: unknown[]) => selectCredentials(...args),
  },
}));

// AC-15a 守护：mock AWS SDK client 构造器，断言全路径从未构造它。
const bedrockRuntimeCtor = vi.fn();
vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: class {
    constructor(opts: unknown) {
      bedrockRuntimeCtor(opts);
    }
  },
}));

import {
  mintBearerToken,
  createBedrockOpenAIClient,
  MAX_BEARER_TOKEN_TTL_SECONDS,
} from "../src/util/bedrock_token";

const ENV_KEY = "AWS_BEARER_TOKEN_BEDROCK";
const BASE_URL = "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1";

beforeEach(() => {
  openAICtor.mockReset();
  getToken.mockReset();
  getTokenProvider.mockReset();
  selectCredentials.mockReset();
  bedrockRuntimeCtor.mockReset();
  delete process.env[ENV_KEY];
});

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe("三档认证矩阵 → mintBearerToken", () => {
  it("AC-4：显式 bearerToken 最高优先，直接用作 bearer，不铸 token", async () => {
    const token = await mintBearerToken({ bearerToken: "br-explicit-bearer" }, "us-east-1");
    expect(token).toBe("br-explicit-bearer");
    expect(getToken).not.toHaveBeenCalled();
    expect(getTokenProvider).not.toHaveBeenCalled();
  });

  it("AC-5 + AC-7：显式 credentials 档用该凭证铸 bearer，有效期 ≤12h", async () => {
    const creds = { accessKeyId: "AKIA_T2", secretAccessKey: "secret2" };
    selectCredentials.mockReturnValue(creds);
    getToken.mockResolvedValue("minted-from-explicit-creds");

    const token = await mintBearerToken({ credentials: [creds] }, "eu-west-1");

    expect(token).toBe("minted-from-explicit-creds");
    expect(selectCredentials).toHaveBeenCalledWith([creds], null);
    expect(getToken).toHaveBeenCalledTimes(1);
    const arg = getToken.mock.calls[0][0];
    expect(arg.credentials).toEqual(creds);
    expect(arg.region).toBe("eu-west-1");
    expect(arg.expiresInSeconds).toBeLessThanOrEqual(12 * 60 * 60);
    expect(MAX_BEARER_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(12 * 60 * 60);
  });

  it("AC-5：单个 credentials 对象（非数组）也走铸 token，不经 selectCredentials 数组选取", async () => {
    const creds = { accessKeyId: "AKIA_SINGLE", secretAccessKey: "secretS" };
    getToken.mockResolvedValue("minted-single");

    const token = await mintBearerToken({ credentials: creds }, "us-west-2");

    expect(token).toBe("minted-single");
    expect(selectCredentials).not.toHaveBeenCalled();
    expect(getToken.mock.calls[0][0].credentials).toEqual(creds);
  });

  it("AC-6 + AC-7：默认链档用 getTokenProvider（不传 credentials）铸 bearer，≤12h", async () => {
    const provide = vi.fn().mockResolvedValue("minted-from-default-chain");
    getTokenProvider.mockReturnValue(provide);

    const token = await mintBearerToken({}, "ap-southeast-2");

    expect(token).toBe("minted-from-default-chain");
    expect(getToken).not.toHaveBeenCalled();
    expect(getTokenProvider).toHaveBeenCalledTimes(1);
    const cfg = getTokenProvider.mock.calls[0][0];
    expect(cfg.credentials).toBeUndefined();
    expect(cfg.region).toBe("ap-southeast-2");
    expect(cfg.expiresInSeconds).toBeLessThanOrEqual(12 * 60 * 60);
    expect(provide).toHaveBeenCalledTimes(1);
  });

  it("三档优先级顺序：bearerToken 存在时不看 credentials", async () => {
    const token = await mintBearerToken(
      { bearerToken: "br-wins", credentials: [{ accessKeyId: "x", secretAccessKey: "y" }] },
      "us-east-1"
    );
    expect(token).toBe("br-wins");
    expect(selectCredentials).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
  });
});

describe("createBedrockOpenAIClient — apiKey 注入 + 无 AWS client + 无 env", () => {
  it("AC-9 + AC-15a：bearer 作 apiKey 传进 new OpenAI({ apiKey, baseURL })", async () => {
    const client = await createBedrockOpenAIClient(
      { bearerToken: "br-inject" },
      BASE_URL,
      "us-east-1"
    );
    expect(client).toBeDefined();
    expect(openAICtor).toHaveBeenCalledTimes(1);
    expect(openAICtor).toHaveBeenCalledWith({ apiKey: "br-inject", baseURL: BASE_URL });
  });

  it("AC-15a：默认链铸出的 bearer 同样作 apiKey 注入", async () => {
    getTokenProvider.mockReturnValue(vi.fn().mockResolvedValue("chain-bearer"));
    await createBedrockOpenAIClient({}, BASE_URL, "us-east-1");
    expect(openAICtor).toHaveBeenCalledWith({ apiKey: "chain-bearer", baseURL: BASE_URL });
  });

  it("AC-15a：全路径不构造任何 AWS SDK client（BedrockRuntimeClient 从未被 new）", async () => {
    getTokenProvider.mockReturnValue(vi.fn().mockResolvedValue("chain-bearer"));
    await createBedrockOpenAIClient({}, BASE_URL, "us-east-1");
    selectCredentials.mockReturnValue({ accessKeyId: "a", secretAccessKey: "b" });
    getToken.mockResolvedValue("creds-bearer");
    await createBedrockOpenAIClient({ credentials: [{ accessKeyId: "a", secretAccessKey: "b" }] }, BASE_URL, "eu-west-1");
    await createBedrockOpenAIClient({ bearerToken: "br-x" }, BASE_URL, "us-east-1");
    expect(bedrockRuntimeCtor).not.toHaveBeenCalled();
  });

  it("AC-8：出站凭证不经 process.env（AWS_BEARER_TOKEN_BEDROCK 调用前后保持未设置）", async () => {
    expect(process.env[ENV_KEY]).toBeUndefined();

    await createBedrockOpenAIClient({ bearerToken: "br-inject" }, BASE_URL, "us-east-1");
    expect(process.env[ENV_KEY]).toBeUndefined();

    getTokenProvider.mockReturnValue(vi.fn().mockResolvedValue("chain-bearer"));
    await createBedrockOpenAIClient({}, BASE_URL, "us-east-1");
    expect(process.env[ENV_KEY]).toBeUndefined();

    selectCredentials.mockReturnValue({ accessKeyId: "a", secretAccessKey: "b" });
    getToken.mockResolvedValue("creds-bearer");
    await createBedrockOpenAIClient(
      { credentials: [{ accessKeyId: "a", secretAccessKey: "b" }] },
      BASE_URL,
      "eu-west-1"
    );
    expect(process.env[ENV_KEY]).toBeUndefined();
  });

  it("AC-9/AD-6：每次调用都新建 client（同 baseURL 也不复用），凭证不跨租户串", async () => {
    await createBedrockOpenAIClient({ bearerToken: "tenant-A" }, BASE_URL, "us-east-1");
    await createBedrockOpenAIClient({ bearerToken: "tenant-B" }, BASE_URL, "us-east-1");
    expect(openAICtor).toHaveBeenCalledTimes(2);
    expect(openAICtor.mock.calls[0][0].apiKey).toBe("tenant-A");
    expect(openAICtor.mock.calls[1][0].apiKey).toBe("tenant-B");
  });
});
