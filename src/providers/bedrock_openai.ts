// bedrock-openai provider：用 OpenAI SDK 报文调 Bedrock 的 OpenAI 兼容 endpoint。
// 编排 Story 1.1 的 endpoint 模块 + Story 1.2 的 token 模块并转发 chat（AD-4：只编排）。
import OpenAI from "openai";
import { ChatRequest, ResponseData } from "../entity/chat_request";
import AbstractProvider from "./abstract_provider";
import { resolveRegion, buildBaseURL } from "../util/bedrock_openai_endpoint";
import { createBedrockOpenAIClient } from "../util/bedrock_token";

interface ExtendedDelta {
  content?: string;
  reasoning_content?: string;
}

export default class BedrockOpenAI extends AbstractProvider {
  constructor() {
    super();
  }

  async chat(chatRequest: ChatRequest, session_id: string, ctx: any) {
    const config = (this.modelData && this.modelData.config) || {};

    // ① endpoint 模块：一次解析 region，再据此拼 baseURL（避免多 region 随机不一致）。
    const region = resolveRegion(config);
    const baseURL = buildBaseURL(region, config);

    // ② token 模块（三档认证）：铸/取 bearer，产出已认证 OpenAI client。
    // AD-6：每请求新建 client（不缓存），凭证不跨租户复用。
    // AD-2/AD-5：不在此构造任何 AWS SDK client、不设 process.env。
    const client = await createBedrockOpenAIClient(config, baseURL, region);

    const model = config.model;
    if (!chatRequest.model_id && model) {
      chatRequest.model_id = model;
    }

    ctx.status = 200;

    // ③ 按 stream/sync 转发。
    if (chatRequest.stream) {
      ctx.set({
        Connection: "keep-alive",
        "Cache-Control": "no-cache",
        "Content-Type": "text/event-stream",
      });
      await this.chatStream(client, ctx, chatRequest, session_id);
    } else {
      ctx.set({
        "Content-Type": "application/json",
      });
      ctx.body = await this.chatSync(client, ctx, chatRequest, session_id);
    }
  }

  async chatStream(client: OpenAI, ctx: any, chatRequest: ChatRequest, session_id: string) {
    const chatResponse = await client.chat.completions.create({
      model: chatRequest.model_id,
      messages: JSON.parse(JSON.stringify(chatRequest.messages)),
      temperature: chatRequest.temperature || 1.0,
      top_p: chatRequest.top_p || 1.0,
      max_tokens: chatRequest.max_tokens,
      max_completion_tokens: chatRequest.max_completion_tokens,
      stream: true,
      ...(chatRequest.tools && { tools: chatRequest.tools }),
      ...(chatRequest.tool_choice && { tool_choice: chatRequest.tool_choice }),
    });

    let responseText = "";
    for await (const part of chatResponse) {
      const reasoning_content = (part.choices[0]?.delta as ExtendedDelta)?.reasoning_content || "";
      responseText += reasoning_content;
      const content = part.choices[0]?.delta?.content || "";
      responseText += content;
      if (part.choices[0]?.finish_reason === "stop") {
        const { completion_tokens = 0, prompt_tokens = 0 } = part.usage ?? {};
        const response: ResponseData = {
          text: responseText,
          input_tokens: prompt_tokens,
          output_tokens: completion_tokens,
        };
        await this.saveThread(ctx, session_id, chatRequest, response);
      }
      ctx.res.write("data: " + JSON.stringify(part) + "\n\n");
    }
    ctx.res.write("data: [DONE]\n\n");
    ctx.res.end();
  }

  async chatSync(client: OpenAI, ctx: any, chatRequest: ChatRequest, session_id: string) {
    const messages = JSON.parse(JSON.stringify(chatRequest.messages));
    const chatResponse = await client.chat.completions.create({
      model: chatRequest.model_id,
      temperature: chatRequest.temperature || 1.0,
      top_p: chatRequest.top_p || 1.0,
      max_tokens: chatRequest.max_tokens,
      max_completion_tokens: chatRequest.max_completion_tokens,
      messages: messages,
      ...(chatRequest.tools && { tools: chatRequest.tools }),
      ...(chatRequest.tool_choice && { tool_choice: chatRequest.tool_choice }),
    });

    const { completion_tokens = 0, prompt_tokens = 0 } = chatResponse.usage ?? {};
    const content = chatResponse.choices[0].message.content || "";

    const response: ResponseData = {
      text: content,
      input_tokens: prompt_tokens,
      output_tokens: completion_tokens,
    };

    await this.saveThread(ctx, session_id, chatRequest, response);

    return chatResponse;
  }
}
