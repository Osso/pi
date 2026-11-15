import { formatSkillsForPrompt, type Skill } from "../../../src/core/skills.ts";

export const MCP_SERVER_NAME = "custom-tools";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

export type SkillReadTool = "mcp" | "none";

export function renderSkillsBlock(skills: Skill[], readTool: SkillReadTool): string | undefined {
	if (readTool === "none" || skills.length === 0) return undefined;
	const block = formatSkillsForPrompt(skills).trim();
	if (!block) return undefined;
	return block.replace(
		"Use the read tool to load a skill's file",
		`Use the read tool (${MCP_TOOL_PREFIX}read) to load a skill's file`,
	);
}
