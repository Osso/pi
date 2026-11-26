import { describe, expect, it } from "vitest";
import { withHeadlessPi } from "./headless-pi.ts";

describe("RPC TUI information commands", () => {
	it("returns the active tool descriptions, loaded extensions, and changelog", async () => {
		await withHeadlessPi(async (agent) => {
			const tools = await agent.send({ type: "get_tools" });
			expect(tools).toMatchObject({ command: "get_tools", success: true });
			const toolList = (tools as { data: { tools: Array<{ name: string; description: string }> } }).data.tools;
			expect(toolList).toEqual(expect.arrayContaining([expect.objectContaining({ name: "read" })]));
			expect(toolList.every((tool) => typeof tool.description === "string")).toBe(true);

			const extensions = await agent.send({ type: "get_extensions" });
			expect(extensions).toMatchObject({ command: "get_extensions", success: true });
			expect((extensions as { data: { extensions: unknown[]; errors: unknown[] } }).data).toEqual({
				extensions: expect.any(Array),
				errors: expect.any(Array),
			});

			const keybindings = await agent.send({ type: "get_keybindings" });
			expect(keybindings).toMatchObject({ command: "get_keybindings", success: true });
			expect((keybindings as { data: { keybindings: Record<string, unknown> } }).data.keybindings).toHaveProperty(
				"app.interrupt",
			);

			const available = await agent.send({ type: "get_available_models" });
			const model = (available as { data: { models: Array<{ provider: string; id: string }> } }).data.models[0];
			expect(model).toBeDefined();
			const currentModels = await agent.send({ type: "get_scoped_models" });
			expect(currentModels).toMatchObject({ command: "get_scoped_models", success: true, data: { models: [] } });
			expect(
				await agent.send({ type: "set_scoped_models", models: [`${model?.provider}/${model?.id}`] }),
			).toMatchObject({
				command: "set_scoped_models",
				success: true,
				data: { models: [{ provider: model?.provider, id: model?.id }] },
			});
			expect(await agent.send({ type: "get_scoped_models" })).toMatchObject({
				command: "get_scoped_models",
				data: { models: [{ provider: model?.provider, id: model?.id }] },
			});

			const changelog = await agent.send({ type: "get_changelog" });
			expect(changelog).toMatchObject({ command: "get_changelog", success: true });
			expect(typeof (changelog as { data: { changelog: unknown } }).data.changelog).toBe("string");
		});
	}, 60_000);
});
