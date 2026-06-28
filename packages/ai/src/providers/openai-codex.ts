import { openAICodexResponsesApi } from "../api/openai-codex-responses.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { loadOpenAICodexOAuth } from "../utils/oauth/load.ts";
import { OPENAI_CODEX_MODELS } from "./openai-codex.models.ts";

export function openaiCodexProvider(
	id: string = "openai-codex",
	name: string = "OpenAI Codex",
): Provider<"openai-codex-responses"> {
	return createProvider({
		id,
		name,
		baseUrl: "https://chatgpt.com/backend-api",
		auth: {
			oauth: lazyOAuth({ name: "OpenAI (ChatGPT Plus/Pro)", load: loadOpenAICodexOAuth }),
		},
		models: Object.values(OPENAI_CODEX_MODELS).map((model) => ({ ...model, provider: id })),
		api: openAICodexResponsesApi(),
	});
}
