import "vitest";

declare module "vitest" {
	interface ProvidedContext {
		headlessCompileCacheRoot: string;
	}
}
