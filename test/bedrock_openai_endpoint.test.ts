import { describe, it, expect } from "vitest";

// 纯函数，无外部依赖，无需 mock。
import { resolveBedrockOpenAIBaseURL } from "../src/util/bedrock_openai_endpoint";

describe("resolveBedrockOpenAIBaseURL", () => {
  // AC-11: 默认/未设 variant → bedrock-runtime.{region}.amazonaws.com
  it("默认形态（未设 variant）→ bedrock-runtime host", () => {
    const url = resolveBedrockOpenAIBaseURL({ region: "us-east-1" });
    expect(url).toBe("https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1");
  });

  it("显式 variant=runtime → bedrock-runtime host", () => {
    const url = resolveBedrockOpenAIBaseURL({ variant: "runtime", region: "us-east-1" });
    expect(url).toBe("https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1");
  });

  // AC-12: variant=mantle → bedrock-mantle.{region}.api.aws
  it("mantle 形态 → bedrock-mantle host", () => {
    const url = resolveBedrockOpenAIBaseURL({ variant: "mantle", region: "us-east-1" });
    expect(url).toBe("https://bedrock-mantle.us-east-1.api.aws/openai/v1");
  });

  // AC-13: region 参数化、不硬编码 —— 换 region host 随之变化
  it("region 参数化：换 region，host 随之变化（无硬编码）", () => {
    const eu = resolveBedrockOpenAIBaseURL({ region: "eu-west-1" });
    const us = resolveBedrockOpenAIBaseURL({ region: "us-east-1" });
    expect(eu).toContain("eu-west-1");
    expect(us).toContain("us-east-1");
    expect(eu).not.toBe(us);
    // 传入的 region 不应意外含有其它写死的 region 字面量
    expect(eu).not.toContain("us-east-1");
  });

  it("mantle 形态下 region 同样参数化", () => {
    const eu = resolveBedrockOpenAIBaseURL({ variant: "mantle", region: "eu-west-1" });
    expect(eu).toBe("https://bedrock-mantle.eu-west-1.api.aws/openai/v1");
  });

  // AD-6: region 缺失/空 → 显式抛错
  it("region 缺失 → 抛错", () => {
    expect(() => resolveBedrockOpenAIBaseURL({} as any)).toThrow(/region/);
  });

  it("region 为空串 → 抛错", () => {
    expect(() => resolveBedrockOpenAIBaseURL({ region: "" })).toThrow(/region/);
  });

  // 未知 variant → 走默认 runtime 分支
  it("未知 variant → 走默认 runtime 形态", () => {
    const url = resolveBedrockOpenAIBaseURL({ variant: "does-not-exist", region: "us-east-1" });
    expect(url).toBe("https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1");
  });
});
