import { describe, it, expect, vi } from 'vitest';

// —— 边界 mock：在 import 被测模块前 hoist 生效，隔离 helper 的外部依赖 ——
// config.bedrock.region 是 selectRandomRegion 未给 region 时的回退终点。
vi.mock('../src/config', () => ({ default: { bedrock: { region: 'us-east-1' }, debugMode: false } }));
vi.mock('../src/service/model', () => ({ default: {} }));
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }));
vi.mock('@aws-sdk/client-s3', () => ({ S3Client: vi.fn(), GetObjectCommand: vi.fn() }));
vi.mock('../src/util/logger', () => ({ default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import buildBedrockOpenAIEndpoint, {
  bedrockOpenAIEndpointHost,
} from '../src/util/bedrock_openai_endpoint';

describe('buildBedrockOpenAIEndpoint — 形态选择 (AD-8)', () => {
  it('AC-1 默认形态：未指定 flavor + 单 region → bedrock-runtime.{region}.amazonaws.com', () => {
    const url = buildBedrockOpenAIEndpoint({ regions: 'us-west-2' });
    // 主机形态是判定点；把默认主机写错一次即变红。
    expect(url).toContain('bedrock-runtime.us-west-2.amazonaws.com');
    expect(url).not.toContain('bedrock-mantle');
    // OQ-1 固化：https scheme + /openai/v1 path 后缀。
    expect(url).toBe('https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1');
  });

  it('AC-2 mantle 形态：flavor=bedrock-mantle → bedrock-mantle.{region}.api.aws', () => {
    const url = buildBedrockOpenAIEndpoint({ regions: 'eu-central-1', endpointFlavor: 'bedrock-mantle' });
    expect(url).toBe('https://bedrock-mantle.eu-central-1.api.aws/openai/v1');
    expect(url).not.toContain('amazonaws.com');
  });

  it('未知 flavor 值 → 回落默认 bedrock-runtime 形态（非 mantle）', () => {
    const url = buildBedrockOpenAIEndpoint({ regions: 'us-east-1', endpointFlavor: 'something-else' });
    expect(url).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1');
  });
});

describe('buildBedrockOpenAIEndpoint — region 解析 (AD-7, 复用 helper.selectRandomRegion)', () => {
  it('AC-3 region 单值 → 该值', () => {
    const url = buildBedrockOpenAIEndpoint({ regions: 'ap-southeast-1' });
    expect(url).toContain('.ap-southeast-1.');
  });

  it('AC-3 region 多值（逗号分隔）→ 选取集合内之一', () => {
    const set = ['us-east-1', 'us-west-2', 'eu-west-1'];
    const url = buildBedrockOpenAIEndpoint({ regions: set.join(',') });
    const picked = set.filter((r) => url.includes(`.${r}.`));
    expect(picked.length).toBe(1);
  });

  it('AC-3 region 多值（数组）→ 选取集合内之一', () => {
    const set = ['ca-central-1', 'sa-east-1'];
    const url = buildBedrockOpenAIEndpoint({ regions: set });
    const picked = set.filter((r) => url.includes(`.${r}.`));
    expect(picked.length).toBe(1);
  });

  it('AC-4 未给 region → 回退 config.bedrock.region (us-east-1)', () => {
    const url = buildBedrockOpenAIEndpoint({});
    // 删掉回退分支或改错回退值一次即变红。
    expect(url).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1');
  });
});

describe('bedrockOpenAIEndpointHost — 纯主机组装', () => {
  it('默认 → runtime 主机', () => {
    expect(bedrockOpenAIEndpointHost('us-east-1')).toBe('bedrock-runtime.us-east-1.amazonaws.com');
  });
  it('mantle → mantle 主机', () => {
    expect(bedrockOpenAIEndpointHost('us-east-1', 'bedrock-mantle')).toBe('bedrock-mantle.us-east-1.api.aws');
  });
});
