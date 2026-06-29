import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const CUSTOM_SECTION_START = "<repo_docs_files>";
const CUSTOM_SECTION_END = "</repo_docs_files>";
const EXCLUDED_DOC_DIRS = new Set(["claw-specs", "openclaw", "wiki"]);
const EXPLICIT_DOC_FILES = ["docs/openclaw/README.md", "docs/wiki/README.md"];

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

function toPortablePath(path: string): string {
	return path.split(sep).join("/");
}

async function collectDocsFiles(cwd: string, currentDir: string, files: string[]): Promise<void> {
	const entries = await readdir(currentDir, { withFileTypes: true });

	for (const entry of entries) {
		const absolutePath = join(currentDir, entry.name);
		const relativePath = toPortablePath(relative(cwd, absolutePath));

		if (entry.isDirectory()) {
			if (EXCLUDED_DOC_DIRS.has(entry.name)) {
				continue;
			}
			await collectDocsFiles(cwd, absolutePath, files);
			continue;
		}

		if (entry.isFile()) {
			files.push(relativePath);
		}
	}
}

async function buildDocsContext(cwd: string): Promise<string | undefined> {
	const docsDir = join(cwd, "docs");
	if (!(await pathExists(docsDir))) {
		return undefined;
	}

	const files: string[] = [];
	await collectDocsFiles(cwd, docsDir, files);

	for (const file of EXPLICIT_DOC_FILES) {
		if (await pathExists(join(cwd, file))) {
			files.push(file);
		}
	}

	const uniqueSortedFiles = [...new Set(files)].sort();
	if (uniqueSortedFiles.length === 0) {
		return undefined;
	}

	return `${CUSTOM_SECTION_START}\ndocs/ file tree:\n${uniqueSortedFiles.join(", ")}\n${CUSTOM_SECTION_END}`;
}

function insertAfterUserRules(systemPrompt: string, docsContext: string): string {
	if (systemPrompt.includes(CUSTOM_SECTION_START)) {
		return systemPrompt;
	}

	const userRulesEnd = "</user_rules>";
	const userRulesEndIndex = systemPrompt.indexOf(userRulesEnd);
	if (userRulesEndIndex === -1) {
		return `${systemPrompt}\n\n${docsContext}`;
	}

	const insertionIndex = userRulesEndIndex + userRulesEnd.length;
	return `${systemPrompt.slice(0, insertionIndex)}\n\n${docsContext}${systemPrompt.slice(insertionIndex)}`;
}

export default function docsTreeContextExtension(pi: ExtensionAPI): void {
	let docsContext: string | undefined;

	pi.on("session_start", async (_event, ctx) => {
		docsContext = await buildDocsContext(ctx.cwd);
	});

	pi.on("before_agent_start", (event) => {
		if (!docsContext) {
			return;
		}

		return {
			systemPrompt: insertAfterUserRules(event.systemPrompt, docsContext),
		};
	});
}
