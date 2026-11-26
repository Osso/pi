import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { type HeadlessPi, withHeadlessPi } from "./headless-pi.ts";

async function completeTurn(agent: HeadlessPi, message: string, reply: string): Promise<void> {
	await agent.send({ type: "prompt", message });
	const request = await agent.waitForLlmRequest((candidate) => candidate.agentId === null);
	agent.respondToLlmRequest(
		request.id,
		fauxAssistantMessage([{ type: "text", text: reply }, fauxToolCall("end_turn", { reason: "Done" })], {
			stopReason: "toolUse",
		}),
	);
	await agent.waitForEvent((event) => event.type === "agent_settled");
}

type TreeNode = {
	entry: { id: string; type: string; message?: { role: string; content: unknown } };
	children: TreeNode[];
};

function findUserEntry(nodes: TreeNode[], text: string): string | undefined {
	for (const node of nodes) {
		const { entry } = node;
		if (entry.message?.role === "user" && JSON.stringify(entry.message.content).includes(text)) return entry.id;
		const found = findUserEntry(node.children, text);
		if (found) return found;
	}
	return undefined;
}

describe("navigate_tree over RPC", () => {
	it("moves the leaf before a user message, returns its text, and later prompts branch from there", async () => {
		await withHeadlessPi(async (agent) => {
			await completeTurn(agent, "first question", "First answer.");
			await completeTurn(agent, "second question", "Second answer.");

			const tree = (await agent.send({ type: "get_tree" })) as {
				data: { tree: TreeNode[]; leafId: string; branchSummarySkipPrompt: boolean };
			};
			expect(tree.data.branchSummarySkipPrompt).toBe(false);
			const secondId = findUserEntry(tree.data.tree, "second question");
			if (!secondId) throw new Error("second question is not in the tree");

			const navigated = await agent.send({ type: "navigate_tree", entryId: secondId });
			expect(navigated).toMatchObject({
				success: true,
				command: "navigate_tree",
				data: { cancelled: false, aborted: false, editorText: "second question" },
			});

			const messages = JSON.stringify(await agent.send({ type: "get_messages" }));
			expect(messages).toContain("First answer.");
			expect(messages).not.toContain("second question");

			await completeTurn(agent, "other question", "Other answer.");
			const branched = (await agent.send({ type: "get_tree" })) as { data: { tree: TreeNode[] } };
			// Both branches stay in the session file.
			expect(findUserEntry(branched.data.tree, "second question")).toBe(secondId);
			expect(findUserEntry(branched.data.tree, "other question")).toBeDefined();
		});
	}, 60_000);
});
