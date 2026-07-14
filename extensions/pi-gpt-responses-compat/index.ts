import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createNodeInsecureDispatcher, installProviderTlsFetch } from "./tls-fetch.mjs";

let nodeInsecureDispatcher: unknown;

function getNodeInsecureDispatcher() {
  if (nodeInsecureDispatcher) return nodeInsecureDispatcher;
  nodeInsecureDispatcher = createNodeInsecureDispatcher();
  return nodeInsecureDispatcher;
}

export default function (pi: ExtensionAPI) {
  if (typeof globalThis.fetch === "function") {
    const runtime = typeof (globalThis as any).Bun === "undefined" ? "node" : "bun";
    installProviderTlsFetch({
      runtime,
      insecureDispatcher: runtime === "node" ? getNodeInsecureDispatcher : undefined
    });
  }

  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload as any;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    if (ctx.model?.provider !== "gpt") return;
    if (!("input" in payload)) return;

    const input = Array.isArray(payload.input) ? payload.input : [];
    const first = input[0];
    const isPrompt = first?.role === "system" || first?.role === "developer";
    const instructions =
      (typeof payload.instructions === "string" && payload.instructions.trim()) ||
      (isPrompt && typeof first.content === "string" && first.content.trim()) ||
      ctx.getSystemPrompt().trim();

    const nextPayload = { ...payload };
    delete nextPayload.prompt_cache_key;
    delete nextPayload.prompt_cache_retention;
    delete nextPayload.max_output_tokens;

    return { ...nextPayload, instructions, input: isPrompt ? input.slice(1) : input };
  });
}
