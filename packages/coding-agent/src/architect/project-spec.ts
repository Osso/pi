import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI } from "../core/extensions/types.ts";

const SPEC_INDEX_PATH = join("docs", "specs", "README.md");

export async function readProjectSpec(projectCwd: string, specPath: string): Promise<string> {
	const projectRoot = await realpath(await findProjectRoot(projectCwd));
	const specsRoot = await realpath(join(projectRoot, "docs", "specs"));
	const specsRelativePath = relative(projectRoot, specsRoot);
	if (specsRelativePath.startsWith("..") || isAbsolute(specsRelativePath)) {
		throw new Error("Architect project specs directory must remain inside the project root");
	}
	const requestedPath = resolve(specsRoot, specPath);
	const lexicalRelativePath = relative(specsRoot, requestedPath);
	if (
		isAbsolute(specPath) ||
		lexicalRelativePath.startsWith("..") ||
		isAbsolute(lexicalRelativePath) ||
		!requestedPath.endsWith(".md")
	) {
		throw new Error("Architect project spec path must reference a relative Markdown file inside docs/specs");
	}
	const canonicalPath = await realpath(requestedPath);
	const relativePath = relative(specsRoot, canonicalPath);
	if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
		throw new Error("Architect project spec path must remain inside docs/specs");
	}
	return readFile(canonicalPath, "utf8");
}

async function findProjectRoot(startCwd: string): Promise<string> {
	let candidate = resolve(startCwd);
	while (true) {
		try {
			await readFile(join(candidate, SPEC_INDEX_PATH), "utf8");
			return candidate;
		} catch (error) {
			const parent = dirname(candidate);
			if (parent === candidate) {
				throw new Error(`No docs/specs/README.md found above Architect project cwd: ${startCwd}`, {
					cause: error,
				});
			}
			candidate = parent;
		}
	}
}

export function registerArchitectProjectSpecTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read_project_spec",
		label: "Read project spec",
		description: "Read an authoritative Markdown spec from an explicit Architect request's project.",
		parameters: Type.Object({
			project_cwd: Type.String({ description: "Exact projectCwd from the Architect request." }),
			spec_path: Type.String({ description: "Path relative to docs/specs, such as README.md." }),
		}),
		approvalRequired: false,
		promptGuidelines: [],
		async execute(_toolCallId, params): Promise<AgentToolResult<{ path: string }>> {
			const content = await readProjectSpec(params.project_cwd, params.spec_path);
			return {
				content: [{ type: "text", text: content }],
				details: { path: params.spec_path },
			};
		},
	});
}
