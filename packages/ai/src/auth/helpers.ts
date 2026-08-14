import type { ApiKeyAuth, OAuthAuth } from "./types.ts";

/**
 * Standard api-key auth: a stored credential owns the provider. A nonempty
 * stored key resolves; an empty key remains unconfigured without env fallback.
 * When no credential is stored, the first set env var resolves. Includes a
 * `login` that prompts for the key.
 * Providers with non-standard resolution (provider env, ambient files, IAM)
 * write their own `ApiKeyAuth`.
 */
export function envApiKeyAuth(name: string, envVars: readonly string[]): ApiKeyAuth {
	return {
		name,
		login: async (callbacks) => {
			const key = await callbacks.prompt({ type: "secret", message: `Enter ${name}` });
			return { type: "api_key", key };
		},
		resolve: async ({ ctx, credential }) => {
			if (credential) {
				if (credential.key) return { auth: { apiKey: credential.key }, source: "stored credential" };
				return undefined;
			}
			for (const envVar of envVars) {
				const value = await ctx.env(envVar);
				if (value) return { auth: { apiKey: value }, source: envVar };
			}
			return undefined;
		},
	};
}

/**
 * Wraps a dynamically imported `OAuthAuth` so provider definitions can
 * advertise OAuth without importing the implementation. The flow loads on
 * first `login`/`refresh`/`toAuth` call; callers keep Node-only flow code out
 * of bundles by loading through a bundler-opaque dynamic import (variable
 * specifier, see the bedrock lazy wrapper).
 */
export function lazyOAuth(input: { name: string; load: () => Promise<OAuthAuth> }): OAuthAuth {
	let promise: Promise<OAuthAuth> | undefined;
	const loaded = () => {
		promise ??= input.load();
		return promise;
	};
	return {
		name: input.name,
		login: async (callbacks) => (await loaded()).login(callbacks),
		refresh: async (credential) => (await loaded()).refresh(credential),
		toAuth: async (credential) => (await loaded()).toAuth(credential),
	};
}
