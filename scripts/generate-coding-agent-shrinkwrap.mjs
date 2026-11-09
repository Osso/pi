#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { outputPathForDependency, populateLockPackages, resolveOutputDependency } from "./coding-agent-lock-paths.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages/coding-agent");
const rootLockfilePath = join(repoRoot, "package-lock.json");
const shrinkwrapPath = join(codingAgentDir, "npm-shrinkwrap.json");
const internalPackagePrefix = "@earendil-works/pi-";
const allowedInstallScriptPackages = new Map([
	["@google/genai@1.52.0", "preinstall is a no-op in the published package"],
	["protobufjs@7.6.5", "postinstall only warns about protobufjs version scheme mismatches"],
]);

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");

for (const arg of args) {
	if (arg !== "--check") {
		console.error(`Unknown argument: ${arg}`);
		process.exit(1);
	}
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function packageDependencies(entry) {
	return {
		...(entry.dependencies ?? {}),
		...(entry.optionalDependencies ?? {}),
	};
}

function sortedObject(object) {
	return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
}

function sortedPackageEntry(entry) {
	const fieldOrder = [
		"name",
		"version",
		"resolved",
		"integrity",
		"license",
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
		"peerDependenciesMeta",
		"bin",
		"engines",
		"os",
		"cpu",
		"libc",
		"optional",
		"hasInstallScript",
		"deprecated",
		"funding",
	];
	const sorted = {};

	for (const field of fieldOrder) {
		if (entry[field] !== undefined) {
			sorted[field] = entry[field];
		}
	}
	for (const [field, value] of Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) {
		if (sorted[field] === undefined) {
			sorted[field] = value;
		}
	}
	return sorted;
}

function copyLockEntry(entry) {
	const copied = { ...entry };
	delete copied.dev;
	delete copied.devOptional;
	delete copied.extraneous;
	delete copied.link;
	return sortedPackageEntry(copied);
}

function copyPackageJsonEntry(packageJson, options) {
	const entry = options.includeName ? { name: packageJson.name, version: packageJson.version } : { version: packageJson.version };

	for (const field of ["license", "dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "bin", "engines", "os", "cpu", "libc"]) {
		if (packageJson[field] !== undefined) {
			entry[field] = packageJson[field];
		}
	}

	return sortedPackageEntry(entry);
}

function packageNameFromLockPath(lockPath) {
	const marker = "node_modules/";
	const index = lockPath.lastIndexOf(marker);
	if (index === -1) {
		return undefined;
	}

	const parts = lockPath.slice(index + marker.length).split("/");
	if (parts[0]?.startsWith("@")) {
		return `${parts[0]}/${parts[1]}`;
	}
	return parts[0];
}

function registryTarballUrl(packageName, version) {
	const tarballName = packageName.startsWith("@") ? packageName.split("/")[1] : packageName;
	return `https://registry.npmjs.org/${packageName}/-/${tarballName}-${version}.tgz`;
}

function isExactVersionSpec(spec) {
	return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(spec);
}

function getInternalWorkspaces(lockPackages) {
	const workspaces = new Map();

	for (const [lockPath, entry] of Object.entries(lockPackages)) {
		if (!lockPath.startsWith("packages/") || lockPath.includes("/node_modules/") || !entry.name || !entry.version) {
			continue;
		}
		if (!entry.name.startsWith(internalPackagePrefix)) {
			continue;
		}

		workspaces.set(entry.name, {
			lockPath,
			packageJson: readJson(join(repoRoot, lockPath, "package.json")),
		});
	}

	return workspaces;
}

function resolveExternalDependency(lockPackages, packageName, fromLockPath) {
	const candidateDirs = [];
	let current = fromLockPath;

	while (current) {
		candidateDirs.push(current);
		const parent = posix.dirname(current);
		if (parent === "." || parent === current) {
			break;
		}
		current = parent;
	}
	candidateDirs.push("");

	const tried = new Set();
	for (const directory of candidateDirs) {
		const candidate = directory ? `${directory}/node_modules/${packageName}` : `node_modules/${packageName}`;
		if (tried.has(candidate)) {
			continue;
		}
		tried.add(candidate);

		const entry = lockPackages[candidate];
		if (entry && !entry.link) {
			return candidate;
		}
	}

	const suffix = `node_modules/${packageName}`;
	const matches = Object.entries(lockPackages)
		.filter(([lockPath, entry]) => !entry.link && (lockPath === suffix || lockPath.endsWith(`/${suffix}`)))
		.map(([lockPath]) => lockPath);

	if (matches.length === 1) {
		return matches[0];
	}

	throw new Error(
		`Cannot resolve ${packageName} from ${fromLockPath || "root"}. ` + (matches.length > 1 ? `Matches: ${matches.join(", ")}` : "No matching lockfile entry found."),
	);
}

function addInternalWorkspace(shrinkwrapPackages, queue, name, workspace, outputPath) {
	const packageJson = workspace.packageJson;
	const entry = copyPackageJsonEntry(packageJson, { includeName: false });
	entry.resolved = registryTarballUrl(name, packageJson.version);

	shrinkwrapPackages[outputPath] = sortedPackageEntry(entry);

	for (const dependencyName of Object.keys(packageDependencies(packageJson))) {
		queue.push({
			name: dependencyName,
			from: workspace.lockPath,
			outputFrom: outputPath,
		});
	}
}

function addExternalPackage(lockPackages, shrinkwrapPackages, emittedOrigins, queue, name, from, outputFrom, workspaceOutputPaths) {
	const lockPath = resolveExternalDependency(lockPackages, name, from);
	const outputPath = outputPathForDependency(name, outputFrom, lockPath, shrinkwrapPackages, emittedOrigins, workspaceOutputPaths);
	if (emittedOrigins.has(outputPath)) {
		return;
	}

	const entry = lockPackages[lockPath];
	shrinkwrapPackages[outputPath] = copyLockEntry(entry);
	emittedOrigins.set(outputPath, lockPath);

	for (const dependencyName of Object.keys(packageDependencies(entry))) {
		queue.push({
			name: dependencyName,
			from: lockPath,
			outputFrom: outputPath,
		});
	}
}

function validatePackageEntries(shrinkwrap, errors, includedPackageNames, seenAllowedInstallScriptPackages) {
	for (const [lockPath, entry] of Object.entries(shrinkwrap.packages)) {
		const packageName = packageNameFromLockPath(lockPath);
		if (packageName) includedPackageNames.add(packageName);
		if (entry.link) errors.push(`${lockPath} is a link entry`);
		if (typeof entry.resolved === "string" && /^(file:|link:|workspace:|\.\.?\/|\/)/.test(entry.resolved)) {
			errors.push(`${lockPath} has a local resolved value: ${entry.resolved}`);
		}
		if (entry.hasInstallScript) {
			validateInstallScriptEntry(lockPath, entry, packageName, errors, seenAllowedInstallScriptPackages);
		}
	}
}

function validateInstallScriptEntry(lockPath, entry, packageName, errors, seenAllowedInstallScriptPackages) {
	if (!packageName || !entry.version) {
		errors.push(`${lockPath || "root"} has install scripts but no package name/version`);
		return;
	}

	const packageId = `${packageName}@${entry.version}`;
	if (allowedInstallScriptPackages.has(packageId)) {
		seenAllowedInstallScriptPackages.add(packageId);
		return;
	}

	errors.push(`${lockPath} has install scripts (${packageId}). Review it and add it to allowedInstallScriptPackages if intentional.`);
}

function validateAllowedInstallScripts(seenAllowedInstallScriptPackages, errors) {
	for (const packageId of allowedInstallScriptPackages.keys()) {
		if (!seenAllowedInstallScriptPackages.has(packageId)) {
			errors.push(`allowed install-script package ${packageId} is no longer present; remove it from the allowlist`);
		}
	}
}

function validateInternalDependencies(internalNames, includedPackageNames, errors) {
	for (const name of internalNames) {
		if (!includedPackageNames.has(name)) {
			errors.push(`internal dependency ${name} is missing`);
		}
	}
}

function validateDependencyVersions(shrinkwrap, errors) {
	for (const [lockPath, entry] of Object.entries(shrinkwrap.packages)) {
		for (const [dependencyName, dependencySpec] of Object.entries(packageDependencies(entry))) {
			let dependencyLockPath;
			try {
				dependencyLockPath = resolveOutputDependency(shrinkwrap.packages, dependencyName, lockPath);
			} catch {
				errors.push(`${lockPath || "root"} dependency ${dependencyName} is missing`);
				continue;
			}

			const dependencyEntry = shrinkwrap.packages[dependencyLockPath];
			if (isExactVersionSpec(dependencySpec) && dependencyEntry.version !== dependencySpec) {
				errors.push(`${lockPath || "root"} dependency ${dependencyName}@${dependencySpec} resolves to ${dependencyEntry.version}`);
			}
		}
	}
}

function validatePlatformDependencies(shrinkwrap, errors) {
	const hasPlatformPackage = Object.values(shrinkwrap.packages).some((entry) => entry.os || entry.cpu || entry.libc);
	if (!hasPlatformPackage) errors.push("no platform-specific optional dependency entries found");
}

function validateShrinkwrap(shrinkwrap, internalNames) {
	const errors = [];
	const includedPackageNames = new Set();
	const seenAllowedInstallScriptPackages = new Set();

	validatePackageEntries(shrinkwrap, errors, includedPackageNames, seenAllowedInstallScriptPackages);
	validateAllowedInstallScripts(seenAllowedInstallScriptPackages, errors);
	validateInternalDependencies(internalNames, includedPackageNames, errors);
	validateDependencyVersions(shrinkwrap, errors);
	validatePlatformDependencies(shrinkwrap, errors);

	if (errors.length > 0) {
		throw new Error(`Generated shrinkwrap failed validation:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
	}
}

function generateShrinkwrap() {
	const rootLock = readJson(rootLockfilePath);
	if (rootLock.lockfileVersion !== 3 || !rootLock.packages) {
		throw new Error("package-lock.json must be lockfileVersion 3 and contain a packages map");
	}

	const lockPackages = rootLock.packages;
	const codingAgentPackage = readJson(join(codingAgentDir, "package.json"));
	const internalWorkspaces = getInternalWorkspaces(lockPackages);
	const shrinkwrapPackages = {
		"": copyPackageJsonEntry(codingAgentPackage, { includeName: true }),
	};
	const workspaceOutputPaths = new Map(
		[...internalWorkspaces.values()].map((workspace) => [
			workspace.lockPath,
			workspace.packageJson.name === codingAgentPackage.name ? "" : `node_modules/${workspace.packageJson.name}`,
		]),
	);
	const internalNames = populateLockPackages({
		lockPackages,
		outputPackages: shrinkwrapPackages,
		internalWorkspaces,
		workspaceOutputPaths,
		rootDependencies: packageDependencies(codingAgentPackage),
		addInternalWorkspace,
		addExternalPackage,
	});

	const shrinkwrap = {
		name: codingAgentPackage.name,
		version: codingAgentPackage.version,
		lockfileVersion: 3,
		requires: true,
		packages: sortedObject(shrinkwrapPackages),
	};

	validateShrinkwrap(shrinkwrap, internalNames);
	return shrinkwrap;
}

try {
	const shrinkwrap = generateShrinkwrap();
	const content = `${JSON.stringify(shrinkwrap, null, "\t")}\n`;

	if (checkOnly) {
		if (!existsSync(shrinkwrapPath)) {
			console.error("packages/coding-agent/npm-shrinkwrap.json is missing.");
			console.error("Run: npm run shrinkwrap:coding-agent");
			process.exit(1);
		}
		const current = readFileSync(shrinkwrapPath, "utf8");
		if (current !== content) {
			console.error("packages/coding-agent/npm-shrinkwrap.json is out of date.");
			console.error("Run: npm run shrinkwrap:coding-agent");
			process.exit(1);
		}
		console.log("packages/coding-agent/npm-shrinkwrap.json is up to date.");
	} else {
		writeFileSync(shrinkwrapPath, content);
		const packageCount = Object.keys(shrinkwrap.packages).length - 1;
		const platformPackageCount = Object.values(shrinkwrap.packages).filter((entry) => entry.os || entry.cpu || entry.libc).length;
		console.log(`Wrote packages/coding-agent/npm-shrinkwrap.json (${packageCount} packages, ${platformPackageCount} platform-specific).`);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
