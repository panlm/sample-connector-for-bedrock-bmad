import { describe, it, expect, vi } from 'vitest';

// —— 边界 mock：在 import helper 前 hoist 生效，隔离外部依赖、杜绝副作用 ——
vi.mock('../src/config', () => ({ default: {} }));
vi.mock('../src/service/model', () => ({ default: {} }));
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }));
vi.mock('@aws-sdk/client-s3', () => ({ S3Client: vi.fn(), GetObjectCommand: vi.fn() }));
vi.mock('../src/util/logger', () => ({ default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import helper from '../src/util/helper';

describe('parseModelString', () => {
  it('含 / → 拆分', () => {
    expect(helper.parseModelString('bedrock/claude-3')).toEqual({ model: 'bedrock', model_id: 'claude-3' });
  });
  it('不含 / → null', () => {
    expect(helper.parseModelString('claude-3')).toBeNull();
  });
  it('按第一个 / 切分', () => {
    expect(helper.parseModelString('a/b/c')).toEqual({ model: 'a', model_id: 'b/c' });
  });
});

describe('genApiKey', () => {
  it('br- 前缀 + 29 位字母数字（总长 32）', () => {
    expect(helper.genApiKey()).toMatch(/^br-[A-Za-z0-9]{29}$/);
  });
});

describe('generateUUID', () => {
  it('合法 UUID v4', () => {
    expect(helper.generateUUID()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });
});
