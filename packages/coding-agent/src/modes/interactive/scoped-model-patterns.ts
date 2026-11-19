import type { ScopedModel } from "../../core/model-resolver.ts";

export function scopedModelId(scoped: ScopedModel): string {
	return `${scoped.model.provider}/${scoped.model.id}`;
}

/**
 * The scoped-models selector works on bare `provider/id` values. Map them back to `enabledModels` patterns that keep
 * each model's thinking-level suffix from the scope the selector started with, so toggling, reordering, and saving
 * preserve per-model reasoning effort.
 */
export function createScopedModelPatternMapper(scope: readonly ScopedModel[] | null) {
	const levels = new Map(scope?.map((scoped) => [scopedModelId(scoped), scoped.thinkingLevel]));
	return (ids: string[] | null): string[] | null =>
		ids?.map((id) => {
			const level = levels.get(id);
			return level ? `${id}:${level}` : id;
		}) ?? null;
}
