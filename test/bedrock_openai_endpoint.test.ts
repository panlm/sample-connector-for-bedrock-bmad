import { describe, it, expect, vi, beforeEach } from "vitest";

// —— 边界 mock：在 import 前 hoist 生效，隔离 helper 对 config/logger 等的副作用 ——
// selectRandomRegion 被 mock，使我们能注入不同 region 并断言 region 来自解析（非硬编码）。
const selectRandomRegion = vi.fn();
vi.mock("../src/util/helper", () => ({
  default: {
    selectRandomRegion: (...args: unknown[]) => selectRandomRegion(...args),
  },
}));

import {
  resolveRegion,
  buildBaseURL,
  resolveBaseURL,
} from "../src/util/bedrock_openai_endpoint";

beforeEach(() => {
  selectRandomRegion.mockReset();
});

describe("resolveRegion", () => {
  it("AC-13：显式 config.region 优先，透传给 selectRandomRegion", () => {
    selectRandomRegion.mockReturnValue("eu-west-1");
    expect(resolveRegion({ region: "eu-west-1" })).toBe("eu-west-1");
    expect(selectRandomRegion).toHaveBeenCalledWith("eu-west-1");
  });

  it("AC-13：config.regions（数组/逗号串）透传给 selectRandomRegion", () => {
    selectRandomRegion.mockReturnValue("ap-southeast-2");
    expect(resolveRegion({ regions: ["ap-southeast-2", "ap-northeast-1"] })).toBe(
      "ap-southeast-2"
    );
    expect(selectRandomRegion).toHaveBeenCalledWith(["ap-southeast-2", "ap-northeast-1"]);
  });

  it("AC-13：未配置 region 时交给 selectRandomRegion 走默认链/回落 us-east-1", () => {
    selectRandomRegion.mockReturnValue("us-east-1");
    expect(resolveRegion({})).toBe("us-east-1");
    expect(selectRandomRegion).toHaveBeenCalledWith(undefined);
  });
});

// 参数矩阵：{bedrock-runtime, bedrock-mantle} × {显式 region, 走默认解析}
describe("buildBaseURL 形态 × region 矩阵", () => {
  it("AC-10：默认 bedrock-runtime 形态 → amazonaws.com + /openai/v1", () => {
    expect(buildBaseURL("us-west-2", {})).toBe(
      "https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1"
    );
  });

  it("AC-12：未显式选择形态时默认取 bedrock-runtime（非 mantle）", () => {
    const url = buildBaseURL("us-east-1", {});
    expect(url).toContain("bedrock-runtime.us-east-1.amazonaws.com");
    expect(url).not.toContain("bedrock-mantle");
  });

  it("AC-12：无法识别的 endpointType 回落到 bedrock-runtime", () => {
    const url = buildBaseURL("us-east-1", { endpointType: "garbage" as never });
    expect(url).toContain("bedrock-runtime.us-east-1.amazonaws.com");
  });

  it("AC-11：显式 bedrock-mantle 形态 → api.aws + /openai/v1", () => {
    expect(buildBaseURL("eu-central-1", { endpointType: "bedrock-mantle" })).toBe(
      "https://bedrock-mantle.eu-central-1.api.aws/openai/v1"
    );
  });

  it("AC-13：region 是被插入的变量，不同 region 改变 baseURL（改成硬编码应变红）", () => {
    const a = buildBaseURL("eu-west-1", {});
    const b = buildBaseURL("ap-southeast-2", {});
    expect(a).toContain("eu-west-1");
    expect(b).toContain("ap-southeast-2");
    expect(a).not.toBe(b);
  });
});

describe("resolveBaseURL 端到端（解析 region 后拼 URL）", () => {
  it("AC-10 + AC-13：runtime 形态，region 来自 selectRandomRegion 的解析结果", () => {
    selectRandomRegion.mockReturnValue("sa-east-1");
    expect(resolveBaseURL({ region: "sa-east-1" })).toBe(
      "https://bedrock-runtime.sa-east-1.amazonaws.com/openai/v1"
    );
  });

  it("AC-11 + AC-13：mantle 形态，region 来自解析（改硬编码应变红）", () => {
    selectRandomRegion.mockReturnValue("ap-northeast-1");
    expect(resolveBaseURL({ endpointType: "bedrock-mantle", regions: "ap-northeast-1" })).toBe(
      "https://bedrock-mantle.ap-northeast-1.api.aws/openai/v1"
    );
  });
});
