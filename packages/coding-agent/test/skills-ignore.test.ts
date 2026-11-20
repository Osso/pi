import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { loadSkillsFromDir } from "../src/core/skills.ts";

const skillPaths = [
	"collection/drafts/direct",
	"collection/tools/drafts/deep-draft",
	"collection/tools/kept",
	"collection/tools/!literal/bang",
	"collection/tools/#literal/hash",
	"outside/drafts/outside",
];

const ignoreCases: [string, string[]][] = [
	["drafts/", ["bang", "hash", "kept", "outside"]],
	["/drafts/", ["bang", "deep-draft", "hash", "kept", "outside"]],
	["tools/drafts/", ["bang", "direct", "hash", "kept", "outside"]],
	["SKILL.md\n!tools/kept/SKILL.md", ["kept", "outside"]],
	["\\!literal/\n\\#literal/", ["deep-draft", "direct", "kept", "outside"]],
];

describe("nested skill ignore files", () => {
	let root: string;
	let agentDir: string;
	let skillsDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-skills-ignore-"));
		agentDir = join(root, "agent");
		skillsDir = join(agentDir, "skills");
		vi.stubEnv("HOME", root);
		for (const path of skillPaths) {
			const skillDir = join(skillsDir, path);
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(join(skillDir, "SKILL.md"), "---\ndescription: Test skill\n---\nContent");
		}
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it.each(ignoreCases)("loadSkillsFromDir honors %s", (pattern, expectedNames) => {
		writeFileSync(join(skillsDir, "collection", ".gitignore"), `${pattern}\n`);

		const { skills, diagnostics } = loadSkillsFromDir({ dir: skillsDir, source: "test" });

		expect(diagnostics).toEqual([]);
		expect(skills.map((skill) => skill.name).sort()).toEqual(expectedNames);
	});

	it.each(["team[1]", "#collection", "!collection"])("honors an ignore file in a directory named %s", async (dir) => {
		for (const name of ["drafts/draft-review", "release-review"]) {
			mkdirSync(join(skillsDir, dir, name), { recursive: true });
			writeFileSync(join(skillsDir, dir, name, "SKILL.md"), "---\ndescription: Test skill\n---\nContent");
		}
		writeFileSync(join(skillsDir, dir, ".gitignore"), "drafts/\n");
		const packageManager = new DefaultPackageManager({
			cwd: root,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
		});

		const names = (await packageManager.resolve()).skills.map((skill) => basename(dirname(skill.path)));
		const loaded = loadSkillsFromDir({ dir: skillsDir, source: "test" }).skills.map((skill) => skill.name);

		expect(names).toContain("release-review");
		expect(names).not.toContain("draft-review");
		expect(loaded).toContain("release-review");
		expect(loaded).not.toContain("draft-review");
	});

	it.each(ignoreCases)("DefaultPackageManager honors %s", async (pattern, expectedNames) => {
		writeFileSync(join(skillsDir, "collection", ".gitignore"), `${pattern}\n`);
		const packageManager = new DefaultPackageManager({
			cwd: root,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
		});

		const result = await packageManager.resolve();

		expect(result.skills.map((skill) => basename(dirname(skill.path))).sort()).toEqual(expectedNames);
		expect(result.skills.every((skill) => skill.enabled)).toBe(true);
	});

	it.each(ignoreCases)("DefaultResourceLoader.reload honors %s", async (pattern, expectedNames) => {
		writeFileSync(join(skillsDir, "collection", ".gitignore"), `${pattern}\n`);
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
		});

		await loader.reload();

		const { skills, diagnostics } = loader.getSkills();
		expect(diagnostics).toEqual([]);
		expect(skills.map((skill) => skill.name).sort()).toEqual(expectedNames);
	});
});
