import { describe, it, expect, vi, beforeEach } from 'vitest';

// —— hoisted mock 句柄：工厂在 import 前 hoist，用 vi.hoisted 规避 TDZ ——
const {
  getTokenMock,
  getTokenProviderMock,
  provideTokenMock,
  bedrockRuntimeClientMock,
  openAIConstructor,
} = vi.hoisted(() => {
  const provideTokenMock = vi.fn(async () => 'minted-default-chain');
  return {
    provideTokenMock,
    // 回吐可断言的 bearer：编码进 region / 传入的 credentials / expiresInSeconds
    getTokenMock: vi.fn(
      async (cfg: any) =>
        `minted:${cfg.region}:${cfg.credentials?.accessKeyId ?? 'na'}:${cfg.expiresInSeconds}`
    ),
    getTokenProviderMock: vi.fn((_cfg: any) => provideTokenMock),
    bedrockRuntimeClientMock: vi.fn(),
    // mock OpenAI 传输：捕获构造参数（apiKey / baseURL），chat 用可 resolve 的桩。
    openAIConstructor: vi.fn(function (opts: any) {
      return {
        baseURL: opts?.baseURL,
        apiKey: opts?.apiKey,
        chat: {
          completions: {
            create: vi.fn(async () => ({
              usage: { prompt_tokens: 1, completion_tokens: 1 },
              choices: [{ message: { content: 'ok' } }],
            })),
          },
        },
      };
    }),
  };
});

// —— 边界 mock（hoist 到 import 前）——
vi.mock('@aws/bedrock-token-generator', () => ({
  getToken: getTokenMock,
  getTokenProvider: getTokenProviderMock,
  BedrockTokenGenerator: vi.fn(),
}));
// 守护：任何 AWS SDK client 构造器都必须“从未被调用”（AD-5，禁 SigV4 退回）。
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: bedrockRuntimeClientMock,
  ConverseCommand: vi.fn(),
  ConverseStreamCommand: vi.fn(),
  InvokeModelCommand: vi.fn(),
}));
vi.mock('../src/config', () => ({ default: { bedrock: { region: 'us-east-1' }, debugMode: false } }));
vi.mock('../src/service/model', () => ({ default: {} }));
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }));
vi.mock('@aws-sdk/client-s3', () => ({ S3Client: vi.fn(), GetObjectCommand: vi.fn() }));
vi.mock('../src/util/logger', () => ({ default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

vi.mock('openai', () => ({ default: openAIConstructor }));

import resolveBearerToken, { MAX_TOKEN_EXPIRES_IN_SECONDS } from '../src/util/bedrock_token';
import buildBedrockOpenAIEndpoint from '../src/util/bedrock_openai_endpoint';
import BedrockOpenAI from '../src/providers/bedrock_openai';
import helper from '../src/util/helper';

// process.env 守护辅助：断言未写入任何键（尤其 AWS_BEARER_TOKEN_BEDROCK）。
function envSnapshot() {
  return JSON.stringify(process.env);
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AWS_BEARER_TOKEN_BEDROCK;
});

describe('resolveBearerToken — 三条认证路径 (AD-3)', () => {
  it('AC-2/AC-4 ① 显式 bearerToken → 直接返回，不铸；token-generator 未被调用', async () => {
    const before = envSnapshot();
    const token = await resolveBearerToken({ bearerToken: 'explicit-bearer', regions: 'us-east-1' });

    expect(token).toBe('explicit-bearer'); // 恒等，非“非空”弱化 (SM-C1)
    expect(getTokenMock).not.toHaveBeenCalled();
    expect(getTokenProviderMock).not.toHaveBeenCalled();
    expect(bedrockRuntimeClientMock).not.toHaveBeenCalled();
    expect(process.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(envSnapshot()).toBe(before);
  });

  it('AC-3 ② 显式 credentials → 用该 credentials 铸；返回值恒等于铸出的 bearer', async () => {
    const before = envSnapshot();
    const creds = { accessKeyId: 'AKIA_TEST', secretAccessKey: 'sk' };
    const token = await resolveBearerToken({ credentials: [creds], regions: 'us-west-2' });

    expect(getTokenMock).toHaveBeenCalledTimes(1);
    const passed = getTokenMock.mock.calls[0][0];
    expect(passed.credentials).toEqual(creds); // token-generator 确实收到该 credentials
    expect(passed.region).toBe('us-west-2');
    expect(token).toBe('minted:us-west-2:AKIA_TEST:43200'); // 恒等铸出值
    expect(getTokenProviderMock).not.toHaveBeenCalled();
    expect(bedrockRuntimeClientMock).not.toHaveBeenCalled();
    expect(process.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(envSnapshot()).toBe(before);
  });

  it('AC-1 ③ 默认凭证链 → getTokenProvider 铸；无 credentials 入参', async () => {
    const before = envSnapshot();
    const token = await resolveBearerToken({ regions: 'eu-west-1' });

    expect(getTokenProviderMock).toHaveBeenCalledTimes(1);
    expect(provideTokenMock).toHaveBeenCalledTimes(1);
    expect(getTokenMock).not.toHaveBeenCalled(); // 未走显式 credentials 分支
    const provCfg = getTokenProviderMock.mock.calls[0][0];
    expect(provCfg.region).toBe('eu-west-1');
    expect(token).toBe('minted-default-chain');
    expect(bedrockRuntimeClientMock).not.toHaveBeenCalled();
    expect(process.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(envSnapshot()).toBe(before);
  });

  it('AC-4 优先级 ① > ②：同配 bearerToken + credentials → 用 bearerToken，不铸', async () => {
    const token = await resolveBearerToken({
      bearerToken: 'wins',
      credentials: [{ accessKeyId: 'AKIA', secretAccessKey: 'sk' }],
      regions: 'us-east-1',
    });
    expect(token).toBe('wins');
    expect(getTokenMock).not.toHaveBeenCalled();
    expect(getTokenProviderMock).not.toHaveBeenCalled();
  });

  it('TTL ≤ 12h：显式 credentials 路径传入的 expiresInSeconds 恒 ≤ 43200', async () => {
    await resolveBearerToken({ credentials: [{ accessKeyId: 'A', secretAccessKey: 's' }], regions: 'us-east-1' });
    expect(getTokenMock.mock.calls[0][0].expiresInSeconds).toBeLessThanOrEqual(MAX_TOKEN_EXPIRES_IN_SECONDS);

    getTokenMock.mockClear();
    // 请求超 12h → 被 clamp 到 43200
    await resolveBearerToken({
      credentials: [{ accessKeyId: 'A', secretAccessKey: 's' }],
      regions: 'us-east-1',
      tokenExpiresInSeconds: 999999,
    });
    expect(getTokenMock.mock.calls[0][0].expiresInSeconds).toBe(MAX_TOKEN_EXPIRES_IN_SECONDS);
  });
});

// —— provider 层守护断言（落在 owns 内的 test 文件，AD-1/AD-4/AD-5/AD-6，SM-2）——
function makeCtx() {
  // performanceMode=true → saveThread 早退，无需 db。
  return { set: vi.fn(), res: { write: vi.fn(), end: vi.fn() }, performanceMode: true } as any;
}
function makeSyncRequest() {
  return { messages: [{ role: 'user', content: 'hi' }], stream: false } as any;
}

describe('BedrockOpenAI provider — bearer 真作 apiKey (AC-3)', () => {
  it('① bearerToken 路径：new OpenAI 的 apiKey 恒等于该 bearer，baseURL 来自 endpoint util', async () => {
    const config = { bearerToken: 'explicit-bearer', regions: 'us-east-1' };
    const p = new BedrockOpenAI();
    p.setModelData({ config });

    await p.chat(makeSyncRequest(), 'sess', makeCtx());

    expect(openAIConstructor).toHaveBeenCalledTimes(1);
    const opts = openAIConstructor.mock.calls[0][0];
    expect(opts.apiKey).toBe('explicit-bearer'); // 恒等 bearer，不弱化
    expect(opts.baseURL).toBe(buildBedrockOpenAIEndpoint(config));
    expect(bedrockRuntimeClientMock).not.toHaveBeenCalled();
    expect(process.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
  });

  it('② credentials 路径：apiKey 恒等于铸出的 bearer', async () => {
    const config = { credentials: [{ accessKeyId: 'AKIA_P', secretAccessKey: 'sk' }], regions: 'us-west-2' };
    const p = new BedrockOpenAI();
    p.setModelData({ config });

    await p.chat(makeSyncRequest(), 'sess', makeCtx());

    const opts = openAIConstructor.mock.calls[0][0];
    expect(opts.apiKey).toBe('minted:us-west-2:AKIA_P:43200');
    expect(opts.baseURL).toBe(buildBedrockOpenAIEndpoint(config));
    expect(bedrockRuntimeClientMock).not.toHaveBeenCalled();
    expect(process.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
  });

  it('③ 默认链路径：apiKey 恒等于铸出的 bearer', async () => {
    const config = { regions: 'eu-west-1' };
    const p = new BedrockOpenAI();
    p.setModelData({ config });

    await p.chat(makeSyncRequest(), 'sess', makeCtx());

    const opts = openAIConstructor.mock.calls[0][0];
    expect(opts.apiKey).toBe('minted-default-chain');
    expect(bedrockRuntimeClientMock).not.toHaveBeenCalled();
    expect(process.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
  });
});

describe('BedrockOpenAI provider — client 缓存判据含 bearer (AC-4, AD-6)', () => {
  it('baseURL 相同、bearer 不同 → 不复用 client（new OpenAI 被调用两次）', async () => {
    const p = new BedrockOpenAI();

    // 第一次 bearer=b1
    p.setModelData({ config: { bearerToken: 'b1', regions: 'us-east-1' } });
    await p.chat(makeSyncRequest(), 'sess', makeCtx());
    // 第二次 baseURL 相同（同 regions/flavor），bearer=b2
    p.setModelData({ config: { bearerToken: 'b2', regions: 'us-east-1' } });
    await p.chat(makeSyncRequest(), 'sess', makeCtx());

    // 只按 baseURL 缓存会只构造一次 → 该断言变红。
    expect(openAIConstructor).toHaveBeenCalledTimes(2);
    expect(openAIConstructor.mock.calls[0][0].apiKey).toBe('b1');
    expect(openAIConstructor.mock.calls[1][0].apiKey).toBe('b2');
    // 两次 baseURL 相同，佐证复用差异仅来自 bearer。
    expect(openAIConstructor.mock.calls[0][0].baseURL).toBe(openAIConstructor.mock.calls[1][0].baseURL);
  });

  it('baseURL 相同、bearer 相同 → 复用 client（new OpenAI 只调用一次）', async () => {
    const p = new BedrockOpenAI();
    p.setModelData({ config: { bearerToken: 'same', regions: 'us-east-1' } });
    await p.chat(makeSyncRequest(), 'sess', makeCtx());
    await p.chat(makeSyncRequest(), 'sess', makeCtx());
    expect(openAIConstructor).toHaveBeenCalledTimes(1);
  });
});

// —— MR-1 复现：多 region × 铸 token 的 region 分裂（评审 major）——
// 缺陷：endpoint util 与 token util 各自独立调 selectRandomRegion，多 region 下二者可能
// 落到不同 region；bearer 是 region-scoped，跨 region → 间歇 403。
// 修法：chat() 内只解析一次 region，同传两 util。
// 本用例 stub selectRandomRegion 使连续两次调用返回不同 region：
//   修复前（两 util 各自解析）→ endpoint region ≠ token region → 断言红；
//   修复后（一次解析、同传）  → 两者恒等且只解析一次 → 绿。
describe('BedrockOpenAI provider — 多 region × 铸 token 的 region 一致性 (MR-1)', () => {
  it('endpoint baseURL 里的 region == 铸 token 用的 region，且 chat 内只解析一次 region', async () => {
    // 连续两次调用返回不同 region：暴露"各自独立解析"的分裂。
    const spy = vi
      .spyOn(helper, 'selectRandomRegion')
      .mockReturnValueOnce('us-east-1')
      .mockReturnValueOnce('us-west-2')
      .mockReturnValue('us-west-2');
    try {
      // 铸 token 路径（② credentials）+ 多 region 配置。
      const config = {
        credentials: [{ accessKeyId: 'AKIA_MR1', secretAccessKey: 'sk' }],
        regions: 'us-east-1,us-west-2',
      };
      const p = new BedrockOpenAI();
      p.setModelData({ config });

      await p.chat(makeSyncRequest(), 'sess', makeCtx());

      const opts = openAIConstructor.mock.calls[0][0];
      // baseURL 里的 region：https://bedrock-runtime.{region}.amazonaws.com/openai/v1
      const urlRegion = opts.baseURL.match(/bedrock-runtime\.([^.]+)\.amazonaws/)![1];
      // apiKey（铸出的 bearer）编码的 region：minted:{region}:{akid}:{exp}
      const tokenRegion = opts.apiKey.split(':')[1];

      // 核心断言：endpoint 与 token 必须同 region（修复前二者分别为 us-east-1 / us-west-2 → 红）。
      expect(urlRegion).toBe(tokenRegion);
      // 只解析一次 region（chat 内单次解析后同传；修复前两 util 各调一次 = 2 → 红）。
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

// —— 回补 auth×endpoint 参数矩阵（父 issue 测试要求，非 happy path）——
// 上游 provider 层守护只跑了默认 flavor；此处把「三认证路径 × 两 endpoint 形态」6 个组合
// 一次跑齐，每格同时断言 apiKey==对应 bearer（bearer 真被用）+ baseURL==对应形态主机
// （endpoint 形态没被 provider 吞掉）+ 无 AWS SDK client（AD-5，杜绝静默 SigV4）+ 未写 env（AD-4）。
// 失败模式恰是组合：某一认证路径在某一 endpoint 形态下悄悄退回 SigV4 / baseURL 串味。
describe('BedrockOpenAI provider — 认证方式 × endpoint 形态 参数矩阵', () => {
  const authPaths = [
    {
      name: '① bearerToken',
      config: (flavor?: string) => ({ bearerToken: 'explicit-bearer', regions: 'us-east-1', endpointFlavor: flavor }),
      expectedApiKey: () => 'explicit-bearer',
    },
    {
      name: '② credentials',
      config: (flavor?: string) => ({
        credentials: [{ accessKeyId: 'AKIA_M', secretAccessKey: 'sk' }],
        regions: 'us-west-2',
        endpointFlavor: flavor,
      }),
      expectedApiKey: () => 'minted:us-west-2:AKIA_M:43200',
    },
    {
      name: '③ 默认凭证链',
      config: (flavor?: string) => ({ regions: 'eu-west-1', endpointFlavor: flavor }),
      expectedApiKey: () => 'minted-default-chain',
    },
  ];
  const flavors = [
    { name: 'runtime(默认)', flavor: undefined, hostFragment: 'bedrock-runtime.' },
    { name: 'mantle', flavor: 'bedrock-mantle', hostFragment: 'bedrock-mantle.' },
  ];

  for (const auth of authPaths) {
    for (const f of flavors) {
      it(`${auth.name} × ${f.name}：apiKey 恒等 bearer 且 baseURL 用对形态、无 AWS client、未写 env`, async () => {
        const before = envSnapshot();
        const config = auth.config(f.flavor);
        const p = new BedrockOpenAI();
        p.setModelData({ config });

        await p.chat(makeSyncRequest(), 'sess', makeCtx());

        const opts = openAIConstructor.mock.calls[0][0];
        // bearer 真被用：apiKey 恒等于该认证路径铸/取出的 bearer（非"非空"弱化，SM-C1）
        expect(opts.apiKey).toBe(auth.expectedApiKey());
        // endpoint 形态没被吞：baseURL 主机与 flavor 一致，且恒等于 endpoint util 的独立计算
        expect(opts.baseURL).toBe(buildBedrockOpenAIEndpoint(config));
        expect(opts.baseURL).toContain(f.hostFragment);
        expect(opts.baseURL.endsWith('/openai/v1')).toBe(true);
        // 全路径无 AWS SDK client（无 SigV4 静默退回）
        expect(bedrockRuntimeClientMock).not.toHaveBeenCalled();
        // 不经 process.env 传 token
        expect(process.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
        expect(envSnapshot()).toBe(before);
      });
    }
  }
});
