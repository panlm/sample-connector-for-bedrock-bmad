// bedrock-openai provider.
// Story 1.3: orchestrate the endpoint util (Story 1.1) and the token util
// (Story 1.2), then drive requests through the OpenAI SDK transport against the
// selected Bedrock endpoint.
//
// Hard invariants:
// - AD-1: extends AbstractProvider and implements chat via the OpenAI SDK.
// - AD-4/AD-5: never writes process.env, never constructs any AWS SDK client.
// - AD-6: the client cache key MUST include the bearer, so a different bearer on
//         the same baseURL never reuses a prior client (cross-tenant leak guard).
//         This deliberately does NOT copy openai_compatible.ts's baseURL-only cache.
import OpenAI from 'openai';
import { ChatRequest, ResponseData } from "../entity/chat_request";
import AbstractProvider from "./abstract_provider";
import buildBedrockOpenAIEndpoint from "../util/bedrock_openai_endpoint";
import resolveBearerToken from "../util/bedrock_token";

interface ExtendedDelta {
  content?: string;
  reasoning_content?: string;
}

export default class BedrockOpenAI extends AbstractProvider {

  client: OpenAI;
  // AD-6: remembers baseURL + bearer of the cached client; a change in either
  // (not just baseURL) forces a rebuild.
  private clientCacheKey: string;

  constructor() {
    super();
  }

  async chat(chatRequest: ChatRequest, session_id: string, ctx: any) {
    const config = this.modelData.config || {};
    const { model } = config;

    // Story 1.1 endpoint util → baseURL; Story 1.2 token util → bearer as apiKey.
    const baseURL = buildBedrockOpenAIEndpoint(config);
    const apiKey = await resolveBearerToken(config);

    // AD-6: cache key includes the bearer. A different bearer on the same baseURL
    // must NOT reuse the client.
    const cacheKey = `${baseURL}|${apiKey}`;
    if (!this.client || this.clientCacheKey !== cacheKey) {
      this.client = new OpenAI({ baseURL, apiKey });
      this.clientCacheKey = cacheKey;
    }

    if (!chatRequest.model_id && model) {
      chatRequest.model_id = model;
    }

    ctx.status = 200;

    if (chatRequest.stream) {
      ctx.set({
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/event-stream',
      });
      await this.chatStream(ctx, chatRequest, session_id);
    } else {
      ctx.set({
        'Content-Type': 'application/json',
      });
      ctx.body = await this.chatSync(ctx, chatRequest, session_id);
    }
  }

  async chatStream(ctx: any, chatRequest: ChatRequest, session_id: string) {
    const chatResponse = await this.client.chat.completions.create({
      model: chatRequest.model_id,
      messages: JSON.parse(JSON.stringify(chatRequest.messages)),
      temperature: chatRequest.temperature || 1.0,
      top_p: chatRequest.top_p || 1.0,
      max_tokens: chatRequest.max_tokens,
      max_completion_tokens: chatRequest.max_completion_tokens,
      stream: true,
      ...(chatRequest.tools && { tools: chatRequest.tools }),
      ...(chatRequest.tool_choice && { tool_choice: chatRequest.tool_choice })
    });

    let responseText = "";
    for await (const part of chatResponse) {
      const reasoning_content = (part.choices[0]?.delta as ExtendedDelta)?.reasoning_content || '';
      responseText += reasoning_content;
      const content = part.choices[0]?.delta?.content || '';
      responseText += content;
      if (part.choices[0]?.finish_reason === "stop") {
        const {
          completion_tokens = 0,
          prompt_tokens = 0
        } = part.usage ?? {};

        const response: ResponseData = {
          text: responseText,
          input_tokens: prompt_tokens,
          output_tokens: completion_tokens,
        }
        await this.saveThread(ctx, session_id, chatRequest, response);
      }
      ctx.res.write("data: " + JSON.stringify(part) + "\n\n");
    }
    ctx.res.write("data: [DONE]\n\n")
    ctx.res.end();
  }

  async chatSync(ctx: any, chatRequest: ChatRequest, session_id: string) {
    const messages = JSON.parse(JSON.stringify(chatRequest.messages));
    const chatResponse = await this.client.chat.completions.create({
      model: chatRequest.model_id,
      temperature: chatRequest.temperature || 1.0,
      top_p: chatRequest.top_p || 1.0,
      max_tokens: chatRequest.max_tokens,
      max_completion_tokens: chatRequest.max_completion_tokens,
      messages: messages,
      ...(chatRequest.tools && { tools: chatRequest.tools }),
      ...(chatRequest.tool_choice && { tool_choice: chatRequest.tool_choice })
    });

    const {
      completion_tokens = 0,
      prompt_tokens = 0
    } = chatResponse.usage ?? {};

    const content = chatResponse.choices[0].message.content || "";

    const response: ResponseData = {
      text: content,
      input_tokens: prompt_tokens,
      output_tokens: completion_tokens,
    }

    await this.saveThread(ctx, session_id, chatRequest, response);

    return chatResponse;
  }

}
