// bedrock-openai connector: forwards standard OpenAI-shaped requests to Bedrock's
// OpenAI-compatible endpoint, authenticated with a freshly minted short-lived bearer.
//
// Architecture contracts (must hold):
// - AD-2: use the base `OpenAI` class (NOT AzureOpenAI); never construct any
//   `@aws-sdk/client-*` service client. The bearer goes out as `Authorization: Bearer`.
// - AD-6: the region is resolved ONCE per request and fed to BOTH the baseURL and the
//   token mint (invariant: token region === baseURL region).
// - AD-7: the per-request OpenAI client is a function-local `const`; it is NEVER stored
//   on `this` (a shared single client would leak tenant A's bearer to tenant B).
import OpenAI from "openai";
import { ChatRequest, ResponseData } from "../entity/chat_request";
import AbstractProvider from "./abstract_provider";
import { resolveBedrockOpenAIBaseURL } from "../util/bedrock_openai_endpoint";
import { resolveBedrockBearer } from "../util/bedrock_token";

interface ExtendedDelta {
  content?: string;
  reasoning_content?: string;
}

export default class BedrockOpenAI extends AbstractProvider {
  constructor() {
    super();
  }

  // Resolve the region ONCE from config (single source of truth, AD-6). Supports both
  // `region` (string) and `regions` (string or array). Missing → explicit error.
  resolveRegion(): string {
    const config = this.modelData.config || {};
    let region = config.region;
    if (!region && config.regions) {
      region = Array.isArray(config.regions) ? config.regions[0] : config.regions;
    }
    if (!region) {
      throw new Error(
        "You must specify the parameter 'region' (or 'regions') in the backend model configuration."
      );
    }
    return region;
  }

  async chat(chatRequest: ChatRequest, session_id: string, ctx: any) {
    const config = this.modelData.config || {};
    const { model, endpointVariant, bearerToken, credentials, expiresInSeconds } = config;

    // Region resolved once, fed to both the baseURL and the token mint (AD-6).
    const region = this.resolveRegion();
    const baseURL = resolveBedrockOpenAIBaseURL({ variant: endpointVariant, region });

    // Outbound auth priority lives in a single place (AD-5): P1 bearerToken > P2
    // credentials > P3 default chain. The result is the OpenAI apiKey (AC-5).
    const apiKey = await resolveBedrockBearer({
      bearerToken,
      credentials,
      region,
      expiresInSeconds,
    });

    // Function-local const client, per request — NEVER stored on `this` (AD-7).
    const client = new OpenAI({
      baseURL,
      apiKey,
    });

    if (!chatRequest.model_id && model) {
      chatRequest.model_id = model;
    }

    ctx.status = 200;

    if (chatRequest.stream) {
      ctx.set({
        Connection: "keep-alive",
        "Cache-Control": "no-cache",
        "Content-Type": "text/event-stream",
      });
      await this.chatStream(ctx, client, chatRequest, session_id);
    } else {
      ctx.set({
        "Content-Type": "application/json",
      });
      ctx.body = await this.chatSync(ctx, client, chatRequest, session_id);
    }
  }

  async chatStream(ctx: any, client: OpenAI, chatRequest: ChatRequest, session_id: string) {
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
      const reasoning_content =
        (part.choices[0]?.delta as ExtendedDelta)?.reasoning_content || "";
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

  async chatSync(ctx: any, client: OpenAI, chatRequest: ChatRequest, session_id: string) {
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
