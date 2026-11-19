import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface FakeCommand {
	name: string;
	invocationName: string;
	getArgumentCompletions?: (prefix: string) => { value: string; label: string }[] | null;
}

function createProvider(commands: FakeCommand[], templateNames: string[] = []): AutocompleteProvider {
	const fakeThis = {
		session: {
			promptTemplates: templateNames.map((name) => ({ name, description: `template ${name}` })),
			extensionRunner: { getRegisteredCommands: () => commands },
			resourceLoader: { getSkills: () => ({ skills: [] }) },
		},
		settingsManager: { getEnableSkillCommands: () => false },
		skillCommands: new Map<string, string>(),
		sessionManager: { getCwd: () => "/tmp" },
		fdPath: undefined,
		prefixAutocompleteDescription: (description: string | undefined) => description,
	};
	const create = Reflect.get(InteractiveMode.prototype, "createBaseAutocompleteProvider") as (
		this: typeof fakeThis,
	) => AutocompleteProvider;
	return create.call(fakeThis);
}

async function suggestionValues(provider: AutocompleteProvider, line: string): Promise<string[]> {
	const result = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
	return result?.items.map((item) => item.value) ?? [];
}

describe("interactive slash-command completion", () => {
	test("offers suffixed extension commands that share a built-in name", async () => {
		const provider = createProvider([
			{ name: "name", invocationName: "name:1" },
			{ name: "name", invocationName: "name:2" },
		]);

		expect(await suggestionValues(provider, "/name")).toEqual(expect.arrayContaining(["name:1", "name:2"]));
	});

	test("completes extension arguments when a prompt template has the same name", async () => {
		const provider = createProvider(
			[
				{
					name: "deploy",
					invocationName: "deploy",
					getArgumentCompletions: (prefix) =>
						["prod", "staging"]
							.filter((env) => env.startsWith(prefix))
							.map((env) => ({ value: env, label: env })),
				},
			],
			["deploy"],
		);

		expect(await suggestionValues(provider, "/deploy pro")).toEqual(["prod"]);
	});
});
