import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ignoredDirectories = new Set([".git", "coverage", "dist", "node_modules"]);
const codingAgentPackageSpecifiers = new Set([
	"@earendil-works/pi-coding-agent",
	"@mariozechner/pi-coding-agent",
]);
const files = [];

function collectTypescriptFiles(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) {
				collectTypescriptFiles(join(directory, entry.name));
			}
			continue;
		}

		if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
			files.push(join(directory, entry.name));
		}
	}
}

function isRelativeJavaScriptSpecifier(specifier) {
	return /^\.\.?\//.test(specifier) && /\.js(?:[?#].*)?$/.test(specifier);
}

function normalizePath(file) {
	return file.replaceAll("\\", "/");
}

function isAutoLoadedExtensionFile(file) {
	const normalized = normalizePath(file);
	return (
		normalized.startsWith(".pi/extensions/") ||
		/^packages\/coding-agent\/extensions\/[^/]+\/src\/.*\.ts$/.test(normalized)
	);
}

function getImportTypeSpecifier(node) {
	if (!ts.isLiteralTypeNode(node.argument)) return undefined;
	if (!ts.isStringLiteralLike(node.argument.literal)) return undefined;
	return node.argument.literal;
}

function importClauseHasRuntimeBindings(importClause) {
	if (!importClause) return true;
	if (importClause.isTypeOnly) return false;
	if (importClause.name) return true;

	const bindings = importClause.namedBindings;
	if (!bindings) return false;
	if (ts.isNamespaceImport(bindings)) return true;

	return bindings.elements.some((element) => !element.isTypeOnly);
}

function importHasRuntimeBindings(node) {
	return ts.isImportDeclaration(node) && importClauseHasRuntimeBindings(node.importClause);
}

function exportHasRuntimeBindings(node) {
	return ts.isExportDeclaration(node) && !node.isTypeOnly;
}

function isDynamicImport(node) {
	return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

const failures = [];

collectTypescriptFiles(".");

for (const file of files.sort()) {
	const sourceText = readFileSync(file, "utf8");
	const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);

	function checkSpecifier(node) {
		if (!isRelativeJavaScriptSpecifier(node.text)) return;
		const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
		failures.push(`${file}:${line + 1}:${character + 1}: ${node.text}`);
	}

	function checkExtensionCodingAgentImport(node, specifier) {
		if (!isAutoLoadedExtensionFile(file)) return;
		if (!codingAgentPackageSpecifiers.has(specifier.text)) return;

		const hasRuntimeImport = importHasRuntimeBindings(node) || exportHasRuntimeBindings(node) || isDynamicImport(node);
		if (!hasRuntimeImport) return;

		const { line, character } = sourceFile.getLineAndCharacterOfPosition(specifier.getStart(sourceFile));
		failures.push(`${file}:${line + 1}:${character + 1}: runtime import from ${specifier.text}`);
	}

	function visit(node) {
		if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
			checkSpecifier(node.moduleSpecifier);
			checkExtensionCodingAgentImport(node, node.moduleSpecifier);
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
			checkSpecifier(node.moduleSpecifier);
			checkExtensionCodingAgentImport(node, node.moduleSpecifier);
		} else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments[0] &&
			ts.isStringLiteralLike(node.arguments[0])
		) {
			checkSpecifier(node.arguments[0]);
			checkExtensionCodingAgentImport(node, node.arguments[0]);
		} else if (ts.isImportTypeNode(node)) {
			const specifier = getImportTypeSpecifier(node);
			if (specifier) checkSpecifier(specifier);
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
}

if (failures.length > 0) {
	console.error("TypeScript import policy violations:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
