/**
 * Model access, behind an interface.
 *
 * The interface exists because the model is the least durable decision in this
 * system. Providers change, tool-calling formats change, and the one thing that
 * must not change is the recorded artifact — which is why the loop below
 * converts model output into typed actions immediately and never lets a raw
 * completion reach the recorder.
 *
 * Replay does not import this module at all. That is the structural guarantee
 * behind "no model in the decision loop": it is not that replay chooses not to
 * call the model, it is that the production path has no model client in it.
 */

import OpenAI from "openai";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
}

export interface LlmDecision {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  /** Free text the model emitted alongside the call, if any. */
  commentary?: string;
}

export interface LlmProvider {
  readonly name: string;
  decide(messages: LlmMessage[], tools: ToolSpec[]): Promise<LlmDecision>;
}

export class OpenAiProvider implements LlmProvider {
  readonly name: string;
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: { apiKey?: string; model?: string } = {}) {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is not set. Discovery requires model access; replay does not. " +
          "Copy .env.example to .env and add a key, or run the replay demo instead.",
      );
    }
    this.model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-4o";
    this.name = `openai:${this.model}`;
    this.client = new OpenAI({ apiKey });
  }

  async decide(messages: LlmMessage[], tools: ToolSpec[]): Promise<LlmDecision> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      messages: messages.map((m) => {
        if (m.role === "tool") {
          return { role: "tool" as const, content: m.content, tool_call_id: m.toolCallId! };
        }
        if (m.role === "assistant" && m.toolCalls?.length) {
          return {
            role: "assistant" as const,
            content: m.content || null,
            tool_calls: m.toolCalls.map((t) => ({
              id: t.id,
              type: "function" as const,
              function: { name: t.name, arguments: t.arguments },
            })),
          };
        }
        return { role: m.role as "system" | "user" | "assistant", content: m.content };
      }),
      tools: tools.map((t) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: "required",
    });

    const choice = response.choices[0];
    const call = choice?.message?.tool_calls?.[0];
    if (!call || call.type !== "function") {
      throw new Error("model returned no tool call; the agent loop requires one action per turn");
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(call.function.arguments || "{}");
    } catch {
      throw new Error(`model returned unparseable arguments: ${call.function.arguments}`);
    }

    return {
      toolCallId: call.id,
      toolName: call.function.name,
      arguments: parsed,
      commentary: choice?.message?.content ?? undefined,
    };
  }
}
