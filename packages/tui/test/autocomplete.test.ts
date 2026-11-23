import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it, test } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";

const resolveFdPath = (): string | null => {
	const command = process.platform === "win32" ? "where" : "which";
	const result = spawnSync(command, ["fd"], { encoding: "utf-8" });
	if (result.status !== 0 || !result.stdout) {
		return null;
	}

	const firstLine = result.stdout.split(/\r?\n/).find(Boolean);
	return firstLine ? firstLine.trim() : null;
};

type FolderStructure = {
	dirs?: string[];
	files?: Record<string, string>;
};

const setupFolder = (baseDir: string, structure: FolderStructure = {}): void => {
	const dirs = structure.dirs ?? [];
	const files = structure.files ?? {};

	dirs.forEach((dir) => {
		mkdirSync(join(baseDir, dir), { recursive: true });
	});
	Object.entries(files).forEach(([filePath, contents]) => {
		const fullPath = join(baseDir, filePath);
		mkdirSync(dirname(fullPath), { recursive: true });
		writeFileSync(fullPath, contents);
	});
};

const fdPath = resolveFdPath();
const isFdInstalled = Boolean(fdPath);

const requireFdPath = (): string => {
	if (!fdPath) {
		throw new Error("fd is not available");
	}
	return fdPath;
};

const getSuggestions = (
	provider: CombinedAutocompleteProvider,
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	force: boolean = false,
) => provider.getSuggestions(lines, cursorLine, cursorCol, { signal: new AbortController().signal, force });

describe("CombinedAutocompleteProvider", () => {
	describe("slash commands after leading whitespace", () => {
		it("completes command names and keeps the whitespace", async () => {
			const provider = new CombinedAutocompleteProvider([{ name: "model" }], process.cwd());
			for (const [line, expected] of [
				[" /", " /model "],
				["  /mod", "  /model "],
				["\t/mod", "\t/model "],
			] as const) {
				const result = await getSuggestions(provider, [line], 0, line.length);
				assert.ok(result);
				assert.equal(result.prefix, line.trimStart());
				assert.deepStrictEqual(
					result.items.map((item) => item.value),
					["model"],
				);
				const item = result.items[0];
				assert.ok(item);
				const applied = provider.applyCompletion([line], 0, line.length, item, result.prefix);
				assert.equal(applied.lines[0], expected);
				assert.equal(applied.cursorCol, expected.length);
			}
		});

		it("replaces the whole command name when the cursor is inside it", async () => {
			const provider = new CombinedAutocompleteProvider([{ name: "model" }], process.cwd());
			for (const [line, cursorCol, expected] of [
				["/model sonnet", 4, "/model sonnet"],
				["/mod sonnet", 4, "/model sonnet"],
				["/model", 4, "/model "],
			] as const) {
				const result = await getSuggestions(provider, [line], 0, cursorCol);
				assert.ok(result);
				const item = result.items.find((candidate) => candidate.value === "model");
				assert.ok(item);
				const applied = provider.applyCompletion([line], 0, cursorCol, item, result.prefix);
				assert.equal(applied.lines[0], expected);
				assert.equal(applied.cursorCol, "/model ".length);
			}
		});

		it("completes command arguments", async () => {
			const getArgumentCompletions = (prefix: string) => {
				assert.equal(prefix, "son");
				return [{ value: "sonnet", label: "sonnet" }];
			};
			const provider = new CombinedAutocompleteProvider([{ name: "model", getArgumentCompletions }], process.cwd());
			const line = "  /model son";
			const result = await getSuggestions(provider, [line], 0, line.length);
			assert.ok(result);
			assert.equal(result.prefix, "son");
			const item = result.items[0];
			assert.ok(item);
			const applied = provider.applyCompletion([line], 0, line.length, item, result.prefix);
			assert.equal(applied.lines[0], "  /model sonnet");
		});
	});

	describe("extractPathPrefix", () => {
		it("extracts / from 'hey /' when forced", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["hey /"];
			const cursorLine = 0;
			const cursorCol = 5; // After the "/"

			const result = await getSuggestions(provider, lines, cursorLine, cursorCol, true);

			assert.notEqual(result, null, "Should return suggestions for root directory");
			if (result) {
				assert.strictEqual(result.prefix, "/", "Prefix should be '/'");
			}
		});

		it("extracts /A from '/A' when forced", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["/A"];
			const cursorLine = 0;
			const cursorCol = 2; // After the "A"

			const result = await getSuggestions(provider, lines, cursorLine, cursorCol, true);

			console.log("Result:", result);
			// This might return null if /A doesn't match anything, which is fine
			// We're mainly testing that the prefix extraction works
			if (result) {
				assert.strictEqual(result.prefix, "/A", "Prefix should be '/A'");
			}
		});

		it("does not trigger for slash commands", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["/model"];
			const cursorLine = 0;
			const cursorCol = 6; // After "model"

			const result = await getSuggestions(provider, lines, cursorLine, cursorCol, true);

			console.log("Result:", result);
			assert.strictEqual(result, null, "Should not trigger for slash commands");
		});

		it("allows forced completion of an empty slash command argument", () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");

			assert.strictEqual(provider.shouldTriggerFileCompletion(["/model "], 0, "/model ".length), true);
			assert.strictEqual(provider.shouldTriggerFileCompletion(["/model"], 0, "/model".length), false);
		});

		it("uses slash command argument completions when forced", async () => {
			const provider = new CombinedAutocompleteProvider(
				[
					{
						name: "cd",
						getArgumentCompletions: () => [{ value: "src/", label: "src/" }],
					},
				],
				"/tmp",
			);
			const line = "/cd s";

			const result = await getSuggestions(provider, [line], 0, line.length, true);

			assert.deepStrictEqual(result, { items: [{ value: "src/", label: "src/" }], prefix: "s" });
		});

		it("does not fall back to file completion when command argument completions are empty", async () => {
			const baseDir = mkdtempSync(join(tmpdir(), "pi-autocomplete-cd-"));
			try {
				writeFileSync(join(baseDir, "src.txt"), "not a directory");
				const provider = new CombinedAutocompleteProvider(
					[
						{
							name: "cd",
							getArgumentCompletions: () => [],
						},
					],
					baseDir,
				);
				const line = "/cd s";

				const result = await getSuggestions(provider, [line], 0, line.length, true);

				assert.strictEqual(result, null);
			} finally {
				rmSync(baseDir, { recursive: true, force: true });
			}
		});

		it("triggers for absolute paths after slash command argument", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["/command /"];
			const cursorLine = 0;
			const cursorCol = 10; // After the second "/"

			const result = await getSuggestions(provider, lines, cursorLine, cursorCol, true);

			console.log("Result:", result);
			assert.notEqual(result, null, "Should trigger for absolute paths in command arguments");
			if (result) {
				assert.strictEqual(result.prefix, "/", "Prefix should be '/'");
			}
		});
	});

	describe("fd @ file suggestions", { skip: !isFdInstalled }, () => {
		let rootDir = "";
		let baseDir = "";
		let outsideDir = "";

		beforeEach(() => {
			rootDir = mkdtempSync(join(tmpdir(), "pi-autocomplete-root-"));
			baseDir = join(rootDir, "cwd");
			outsideDir = join(rootDir, "outside");
			mkdirSync(baseDir, { recursive: true });
			mkdirSync(outsideDir, { recursive: true });
		});

		afterEach(() => {
			rmSync(rootDir, { recursive: true, force: true });
		});

		test("returns all files and folders for empty @ query", async () => {
			setupFolder(baseDir, {
				dirs: ["src"],
				files: {
					"README.md": "readme",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value).sort();
			assert.deepStrictEqual(values, ["@README.md", "@src/"].sort());
		});

		test("matches a query that starts with a dash", async () => {
			setupFolder(baseDir, {
				files: {
					"-draft.md": "draft",
					"notes.md": "notes",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@-draft";
			const result = await getSuggestions(provider, [line], 0, line.length);

			assert.deepStrictEqual(
				result?.items.map((item) => item.value),
				["@-draft.md"],
			);
		});

		test("matches file with extension in query", async () => {
			setupFolder(baseDir, {
				files: {
					"file.txt": "content",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@file.txt";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes("@file.txt"));
		});

		// #10972
		test("matches regex metacharacters in queries literally", async () => {
			setupFolder(baseDir, {
				files: {
					"pages/[id].tsx": "x",
					"pages/index.tsx": "x",
					"pages/(group).ts": "x",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			for (const [line, expected] of [
				["@pages/[", "@pages/[id].tsx"],
				["@pages/(", "@pages/(group).ts"],
				["@[id", "@pages/[id].tsx"],
			] as const) {
				const result = await getSuggestions(provider, [line], 0, line.length);
				assert.deepStrictEqual(
					result?.items.map((item) => item.value),
					[expected],
					line,
				);
			}
		});

		test("applies the project .gitignore to directory-scoped @ queries", async () => {
			setupFolder(baseDir, {
				files: {
					".gitignore": "*.log\n/build\n",
					"sub/x.log": "x",
					"sub/y.ts": "x",
					"sub/build/z.ts": "x",
					"build/b.ts": "x",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			for (const [line, expected] of [
				["@sub/", ["@sub/build/", "@sub/build/z.ts", "@sub/y.ts"]],
				["@sub/x", []],
				["@sub/z", ["@sub/build/z.ts"]],
			] as const) {
				const result = await getSuggestions(provider, [line], 0, line.length);
				assert.deepStrictEqual((result?.items ?? []).map((item) => item.value).sort(), [...expected], line);
			}
		});

		test("filters are case insensitive", async () => {
			setupFolder(baseDir, {
				dirs: ["src"],
				files: {
					"README.md": "readme",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@re";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value).sort();
			assert.deepStrictEqual(values, ["@README.md"]);
		});

		test("matches a mixed-case query case-insensitively", async () => {
			setupFolder(baseDir, { files: { "README.md": "readme" } });

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const result = await getSuggestions(provider, ["@Read"], 0, "@Read".length);

			assert.deepStrictEqual(
				result?.items.map((item) => item.value),
				["@README.md"],
			);
		});

		test("ranks directories before files", async () => {
			setupFolder(baseDir, {
				dirs: ["src"],
				files: {
					"src.txt": "text",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@src";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const firstValue = result?.items[0]?.value;
			const hasSrcFile = result?.items?.some((item) => item.value === "@src.txt");
			assert.strictEqual(firstValue, "@src/");
			assert.ok(hasSrcFile);
		});

		test("returns nested file paths", async () => {
			setupFolder(baseDir, {
				files: {
					"src/index.ts": "export {};\n",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@index";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes("@src/index.ts"));
		});

		test("matches deeply nested paths", async () => {
			setupFolder(baseDir, {
				files: {
					"packages/tui/src/autocomplete.ts": "export {};",
					"packages/ai/src/autocomplete.ts": "export {};",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@tui/src/auto";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes("@packages/tui/src/autocomplete.ts"));
			assert.ok(!values?.includes("@packages/ai/src/autocomplete.ts"));
		});

		test("matches directory in middle of path with --full-path", async () => {
			setupFolder(baseDir, {
				files: {
					"src/components/Button.tsx": "export {};",
					"src/utils/helpers.ts": "export {};",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@components/";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes("@src/components/Button.tsx"));
			assert.ok(!values?.includes("@src/utils/helpers.ts"));
		});

		test("scopes fuzzy search to relative directories and searches recursively", async () => {
			setupFolder(outsideDir, {
				files: {
					"nested/alpha.ts": "export {};",
					"nested/deeper/also-alpha.ts": "export {};",
					"nested/deeper/zzz.ts": "export {};",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@../outside/a";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes("@../outside/nested/alpha.ts"));
			assert.ok(values?.includes("@../outside/nested/deeper/also-alpha.ts"));
			assert.ok(!values?.includes("@../outside/nested/deeper/zzz.ts"));
		});

		test("recognizes @ after opening wrappers like ( and backticks", async () => {
			setupFolder(baseDir, { files: { "README.md": "readme" } });
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			for (const before of ["(", "see (", "[", "`", "<", "{"]) {
				const line = `${before}@REA`;
				const result = await getSuggestions(provider, [line], 0, line.length);
				assert.ok(result, line);
				assert.strictEqual(result.prefix, "@REA");
				const item = result.items[0];
				assert.ok(item);
				const applied = provider.applyCompletion([line], 0, line.length, item, result.prefix);
				assert.strictEqual(applied.lines[0], `${before}@README.md `);
			}
			const embedded = "foo(@REA";
			assert.strictEqual(await getSuggestions(provider, [embedded], 0, embedded.length), null);
		});
		test("recognizes @ after CJK punctuation without consuming the preceding text", async () => {
			setupFolder(baseDir, { files: { "README.md": "readme" } });
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			for (const before of ["查看，", "\u3000", ..."，．：；！？（）［］｛｝“”‘’…—。、「」『』《》【】"]) {
				for (const force of [false, true]) {
					const line = `${before}@REA`;
					const result = await getSuggestions(provider, [line], 0, line.length, force);
					assert.ok(result, line);
					assert.strictEqual(result.prefix, "@REA");
					assert.deepStrictEqual(
						result.items.map((item) => item.value),
						["@README.md"],
					);
					const item = result.items[0];
					assert.ok(item);
					const applied = provider.applyCompletion([line], 0, line.length, item, result.prefix);
					assert.strictEqual(applied.lines[0], `${before}@README.md `);
					assert.strictEqual(applied.cursorCol, applied.lines[0]?.length);
				}
			}
		});
		test("quotes paths with spaces for @ suggestions", async () => {
			setupFolder(baseDir, {
				dirs: ["my folder"],
				files: {
					"my folder/test.txt": "content",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@my";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes('@"my folder/"'));
		});

		test("excludes .git contents when the query names .git explicitly", async () => {
			setupFolder(baseDir, { dirs: [".git"], files: { ".git/config": "[core]" } });

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const result = await getSuggestions(provider, ["@.git/"], 0, "@.git/".length);

			assert.deepStrictEqual(result?.items.map((item) => item.value) ?? [], []);
		});

		test("includes hidden paths but excludes .git", async () => {
			setupFolder(baseDir, {
				dirs: [".pi", ".github", ".git"],
				files: {
					".pi/config.json": "{}",
					".github/workflows/ci.yml": "name: ci",
					".git/config": "[core]",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value) ?? [];
			assert.ok(values.includes("@.pi/"));
			assert.ok(values.includes("@.github/"));
			assert.ok(!values.some((value) => value === "@.git" || value.startsWith("@.git/")));
		});

		test("follows symlinked directories for fuzzy @ search", async () => {
			setupFolder(baseDir, {
				files: {
					"dir/some_file.txt": "real",
				},
			});
			setupFolder(outsideDir, {
				files: {
					"some_file.txt": "symlinked",
				},
			});
			symlinkSync("../outside", join(baseDir, "symlinked_dir"));

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@some";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value) ?? [];
			assert.ok(values.includes("@dir/some_file.txt"));
			assert.ok(values.includes("@symlinked_dir/some_file.txt"));
		});

		test("returns symlinked directories when matching their name", async () => {
			setupFolder(outsideDir, {
				files: {
					"nested/file.txt": "symlinked",
				},
			});
			symlinkSync("../outside", join(baseDir, "symlinked_dir"));

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@symlinked";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value) ?? [];
			assert.ok(values.includes("@symlinked_dir/"));
		});

		test("returns symlinked files without requiring type l", async () => {
			setupFolder(baseDir, {
				files: {
					"original.txt": "content",
				},
			});
			const linkPath = join(baseDir, "link.txt");
			symlinkSync("original.txt", linkPath);

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "@link";
			const result = await getSuggestions(provider, [line], 0, line.length);

			const values = result?.items.map((item) => item.value) ?? [];
			assert.ok(values.includes("@link.txt"));
		});

		test("returns the same @ suggestions when the cwd path contains the query", async () => {
			const normalBaseDir = join(rootDir, "cwd-normal");
			const queryInPathBaseDir = join(rootDir, "cwd-plan-repro");
			mkdirSync(normalBaseDir, { recursive: true });
			mkdirSync(queryInPathBaseDir, { recursive: true });

			const structure = {
				dirs: ["packages/coding-agent/examples/extensions/plan-mode"],
				files: {
					"packages/coding-agent/examples/extensions/plan-mode/README.md": "readme",
					"packages/tui/docs/plan.md": "plan",
				},
			};
			setupFolder(normalBaseDir, structure);
			setupFolder(queryInPathBaseDir, structure);

			const query = "@plan";
			const normalProvider = new CombinedAutocompleteProvider([], normalBaseDir, requireFdPath());
			const queryInPathProvider = new CombinedAutocompleteProvider([], queryInPathBaseDir, requireFdPath());

			const normalResult = await getSuggestions(normalProvider, [query], 0, query.length);
			const queryInPathResult = await getSuggestions(queryInPathProvider, [query], 0, query.length);

			const normalize = (result: Awaited<ReturnType<typeof getSuggestions>>) =>
				(result?.items ?? []).map((item) => `${item.label} :: ${item.description ?? ""}`).sort();

			assert.deepStrictEqual(normalize(queryInPathResult), normalize(normalResult));
			assert.ok(
				normalize(normalResult).includes("plan-mode/ :: packages/coding-agent/examples/extensions/plan-mode"),
			);
			assert.ok(normalize(normalResult).includes("plan.md :: packages/tui/docs/plan.md"));
		});

		test("continues autocomplete inside quoted @ paths", async () => {
			setupFolder(baseDir, {
				files: {
					"my folder/test.txt": "content",
					"my folder/other.txt": "content",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = '@"my folder/"';
			const result = await getSuggestions(provider, [line], 0, line.length - 1);

			assert.notEqual(result, null, "Should return suggestions for quoted folder path");
			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes('@"my folder/test.txt"'));
			assert.ok(values?.includes('@"my folder/other.txt"'));
		});

		test("applies quoted @ completion without duplicating closing quote", async () => {
			setupFolder(baseDir, {
				files: {
					"my folder/test.txt": "content",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = '@"my folder/te"';
			const cursorCol = line.length - 1;
			const result = await getSuggestions(provider, [line], 0, cursorCol);

			assert.notEqual(result, null, "Should return suggestions for quoted @ path");
			const item = result?.items.find((entry) => entry.value === '@"my folder/test.txt"');
			assert.ok(item && result, "Should find test.txt suggestion");

			const applied = provider.applyCompletion([line], 0, cursorCol, item, result.prefix);
			assert.strictEqual(applied.lines[0], '@"my folder/test.txt" ');
		});

		test("replaces the rest of the @ path when the cursor is inside the filename", async () => {
			setupFolder(baseDir, { files: { "my folder/test.txt": "content", "src/main.ts": "x" } });
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			for (const [line, cursorCol, value, expected] of [
				['@"my folder/test.txt"', 14, '@"my folder/test.txt"', '@"my folder/test.txt" '],
				["@src/main.ts", 7, "@src/main.ts", "@src/main.ts "],
			] as const) {
				const result = await getSuggestions(provider, [line], 0, cursorCol);
				const item = result?.items.find((entry) => entry.value === value);
				assert.ok(item && result, `Should suggest ${value}`);

				const applied = provider.applyCompletion([line], 0, cursorCol, item, result.prefix);

				assert.strictEqual(applied.lines[0], expected);
			}
		});

		test("replaces the rest of an @ path that ends at CJK punctuation", async () => {
			setupFolder(baseDir, { files: { "说明.md": "content" } });
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			const line = "查看，@说明.md，后文";
			const cursorCol = "查看，@说".length;
			const result = await getSuggestions(provider, [line], 0, cursorCol);
			const item = result?.items.find((entry) => entry.value === "@说明.md");
			assert.ok(item && result, "Should suggest @说明.md");

			const applied = provider.applyCompletion([line], 0, cursorCol, item, result.prefix);

			assert.strictEqual(applied.lines[0], "查看，@说明.md ，后文");
		});
	});

	describe("dot-slash path completion", () => {
		let baseDir = "";

		beforeEach(() => {
			baseDir = mkdtempSync(join(tmpdir(), "pi-autocomplete-"));
		});

		afterEach(() => {
			rmSync(baseDir, { recursive: true, force: true });
		});

		test("preserves ./ prefix when completing paths", async () => {
			setupFolder(baseDir, {
				files: {
					"update.sh": "#!/bin/bash",
					"utils.ts": "export {};",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "./up";
			const result = await getSuggestions(provider, [line], 0, line.length, true);

			assert.notEqual(result, null, "Should return suggestions for ./ path");
			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes("./update.sh"), `Expected ./update.sh in ${JSON.stringify(values)}`);
		});

		test("preserves ./ prefix for directory completions", async () => {
			setupFolder(baseDir, {
				dirs: ["src"],
				files: {
					"src/index.ts": "export {};",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "./sr";
			const result = await getSuggestions(provider, [line], 0, line.length, true);

			assert.notEqual(result, null, "Should return suggestions for ./ directory path");
			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes("./src/"), `Expected ./src/ in ${JSON.stringify(values)}`);
		});
	});

	describe("quoted path completion", () => {
		let baseDir = "";

		beforeEach(() => {
			baseDir = mkdtempSync(join(tmpdir(), "pi-autocomplete-"));
		});

		afterEach(() => {
			rmSync(baseDir, { recursive: true, force: true });
		});

		test("completes paths after opening wrappers like ( [ { < and backticks", async () => {
			setupFolder(baseDir, { files: { "src/main.ts": "x" } });
			const provider = new CombinedAutocompleteProvider([], baseDir);
			for (const wrapper of ["(", "[", "{", "<", "`", "((", "(`"]) {
				for (const prefix of ["src/ma", "./src/ma"]) {
					const before = `see ${wrapper}`;
					const line = `${before}${prefix}`;
					const result = await getSuggestions(provider, [line], 0, line.length, true);
					assert.ok(result, line);
					assert.strictEqual(result.prefix, prefix);
					const value = prefix.replace("src/ma", "src/main.ts");
					assert.deepStrictEqual(
						result.items.map((item) => item.value),
						[value],
					);
					const item = result.items[0];
					assert.ok(item);
					const applied = provider.applyCompletion([line], 0, line.length, item, result.prefix);
					assert.strictEqual(applied.lines[0], `${before}${value}`);
				}
			}
		});
		test("completes quoted paths after opening wrappers", async () => {
			setupFolder(baseDir, { files: { "my dir/main.ts": "x" } });
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = 'see ("my dir/ma';
			const result = await getSuggestions(provider, [line], 0, line.length, true);
			assert.ok(result);
			assert.strictEqual(result.prefix, '"my dir/ma');
			assert.deepStrictEqual(
				result.items.map((item) => item.value),
				['"my dir/main.ts"'],
			);
		});
		test("keeps wrappers that are closed inside the path", async () => {
			setupFolder(baseDir, { files: { "[slug]/page.tsx": "x", "(group)/layout.tsx": "x" } });
			const provider = new CombinedAutocompleteProvider([], baseDir);
			for (const [prefix, value] of [
				["[slug]/pa", "[slug]/page.tsx"],
				["(group)/la", "(group)/layout.tsx"],
				["./[slug]/pa", "./[slug]/page.tsx"],
			]) {
				const line = `see ${prefix}`;
				const result = await getSuggestions(provider, [line], 0, line.length, true);
				assert.ok(result, line);
				assert.strictEqual(result.prefix, prefix);
				assert.deepStrictEqual(
					result.items.map((item) => item.value),
					[value],
				);
			}
		});
		test("completes Chinese path prefixes after whitespace or CJK punctuation on Tab", async () => {
			setupFolder(baseDir, { files: { "说明.md": "file", "文档/说明.md": "nested file" } });
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const completions = [
				{ prefix: "说", value: "说明.md" },
				{ prefix: "文", value: "文档/" },
				{ prefix: "文档/说", value: "文档/说明.md" },
				{ prefix: "./文档/说", value: "./文档/说明.md" },
			];
			if (process.platform !== "win32") {
				completions.push({ prefix: `${baseDir}/文档/说`, value: `${baseDir}/文档/说明.md` });
			}
			for (const separator of " \t\u3000\u00a0，：；。！？（「《") {
				for (const { prefix, value } of completions) {
					const before = `查看𠮷${separator}`;
					const line = `${before}${prefix} 后文`;
					const cursorCol = before.length + prefix.length;
					const result = await getSuggestions(provider, [line], 0, cursorCol, true);
					assert.ok(result, line);
					assert.strictEqual(result.prefix, prefix);
					assert.deepStrictEqual(
						result.items.map((item) => item.value),
						[value],
					);
					const item = result.items[0];
					assert.ok(item);
					const applied = provider.applyCompletion([line], 0, cursorCol, item, result.prefix);
					assert.strictEqual(applied.lines[0], `${before}${value} 后文`);
					assert.strictEqual(applied.cursorCol, before.length + value.length);
				}
			}
		});
		test("handles an empty prefix after whitespace or CJK punctuation consistently", async () => {
			setupFolder(baseDir, { files: { "说明.md": "text" } });
			const provider = new CombinedAutocompleteProvider([], baseDir);
			for (const separator of [" ", "\t", "\u3000", "，", "。"]) {
				for (const force of [false, true]) {
					const line = `查看${separator}`;
					const result = await getSuggestions(provider, [line], 0, line.length, force);
					assert.ok(result, line);
					assert.strictEqual(result.prefix, "");
					assert.deepStrictEqual(
						result.items.map((item) => item.value),
						["说明.md"],
					);
				}
			}
			assert.strictEqual(await getSuggestions(provider, [""], 0, 0), null);
		});
		test("quotes paths with spaces for direct completion", async () => {
			setupFolder(baseDir, {
				dirs: ["my folder"],
				files: {
					"my folder/test.txt": "content",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "my";
			const result = await getSuggestions(provider, [line], 0, line.length, true);

			assert.notEqual(result, null, "Should return suggestions for path completion");
			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes('"my folder/"'));
		});

		test("lists quoted directories before files", async () => {
			setupFolder(baseDir, {
				dirs: ["z folder"],
				files: { "a-file.txt": "content" },
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const result = await getSuggestions(provider, [""], 0, 0, true);

			assert.deepStrictEqual(
				result?.items.map((item) => item.value),
				['"z folder/"', "a-file.txt"],
			);
		});

		test("continues completion inside quoted paths", async () => {
			setupFolder(baseDir, {
				files: {
					"my folder/test.txt": "content",
					"my folder/other.txt": "content",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = '"my folder/"';
			const result = await getSuggestions(provider, [line], 0, line.length - 1, true);

			assert.notEqual(result, null, "Should return suggestions for quoted folder path");
			const values = result?.items.map((item) => item.value);
			assert.ok(values?.includes('"my folder/test.txt"'));
			assert.ok(values?.includes('"my folder/other.txt"'));
		});

		test("applies quoted completion without duplicating closing quote", async () => {
			setupFolder(baseDir, {
				files: {
					"my folder/test.txt": "content",
				},
			});

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = '"my folder/te"';
			const cursorCol = line.length - 1;
			const result = await getSuggestions(provider, [line], 0, cursorCol, true);

			assert.notEqual(result, null, "Should return suggestions for quoted path");
			const item = result?.items.find((entry) => entry.value === '"my folder/test.txt"');
			assert.ok(item && result, "Should find test.txt suggestion");

			const applied = provider.applyCompletion([line], 0, cursorCol, item, result.prefix);
			assert.strictEqual(applied.lines[0], '"my folder/test.txt"');
		});
	});
});
