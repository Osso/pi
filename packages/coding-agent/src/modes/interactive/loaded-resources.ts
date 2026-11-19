import { type Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import type { ResourceDiagnostic } from "../../core/resource-loader.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import {
	buildScopeGroups,
	formatContextPath,
	formatDiagnostics,
	formatDisplayPath,
	formatExtensionDisplayPath,
	formatScopeGroups,
	getCompactExtensionLabels,
	getCompactPathLabel,
	getShortPath,
} from "./loaded-resources-format.ts";
import { type ThemeColor, theme } from "./theme/theme.ts";

/** Interface for components that can be expanded/collapsed */
export interface Expandable {
	setExpanded(expanded: boolean): void;
}

export class ExpandableText extends Text implements Expandable {
	private readonly getCollapsedText: () => string;
	private readonly getExpandedText: () => string;

	constructor(
		getCollapsedText: () => string,
		getExpandedText: () => string,
		expanded = false,
		paddingX = 0,
		paddingY = 0,
	) {
		super(expanded ? getExpandedText() : getCollapsedText(), paddingX, paddingY);
		this.getCollapsedText = getCollapsedText;
		this.getExpandedText = getExpandedText;
	}

	setExpanded(expanded: boolean): void {
		this.setText(expanded ? this.getExpandedText() : this.getCollapsedText());
	}
}

export interface LoadedResourcesInput {
	container: Container;
	session: Pick<AgentSession, "extensionRunner" | "getActiveToolNames" | "promptTemplates" | "resourceLoader">;
	cwd: string;
	/** Show the full listing instead of the compact one. */
	expanded: boolean;
	showListing: boolean;
	showDiagnostics: boolean;
	extensionsOverride: Array<{ path: string; sourceInfo?: SourceInfo }> | undefined;
	getBuiltInCommandConflicts: () => ResourceDiagnostic[];
}

/** Renders the startup listing of loaded context files, tools, skills, prompts, extensions and themes, plus their diagnostics. */
export function renderLoadedResources(input: LoadedResourcesInput): void {
	const {
		container,
		session,
		cwd,
		expanded,
		showListing,
		showDiagnostics,
		extensionsOverride,
		getBuiltInCommandConflicts,
	} = input;
	const sectionHeader = (name: string, color: ThemeColor = "mdHeading") => theme.fg(color, `[${name}]`);
	const formatCompactList = (items: string[], options?: { sort?: boolean }): string => {
		const labels = items.map((item) => item.trim()).filter((item) => item.length > 0);
		if (options?.sort !== false) {
			labels.sort((a, b) => a.localeCompare(b));
		}
		return theme.fg("dim", `  ${labels.join(", ")}`);
	};
	const addLoadedSection = (
		name: string,
		collapsedBody: string,
		expandedBody = collapsedBody,
		color: ThemeColor = "mdHeading",
	): void => {
		const section = new ExpandableText(
			() => `${sectionHeader(name, color)}\n${collapsedBody}`,
			() => `${sectionHeader(name, color)}\n${expandedBody}`,
			expanded,
			0,
			0,
		);
		container.addChild(section);
		container.addChild(new Spacer(1));
	};

	const skillsResult = session.resourceLoader.getSkills();
	const promptsResult = session.resourceLoader.getPrompts();
	const themesResult = session.resourceLoader.getThemes();
	const activeToolNames = session.getActiveToolNames();
	const extensions =
		extensionsOverride ??
		session.resourceLoader.getExtensions().extensions.map((extension) => ({
			path: extension.path,
			sourceInfo: extension.sourceInfo,
		}));
	const sourceInfos = new Map<string, SourceInfo>();
	for (const extension of extensions) {
		if (extension.sourceInfo) {
			sourceInfos.set(extension.path, extension.sourceInfo);
		}
	}
	for (const skill of skillsResult.skills) {
		if (skill.sourceInfo) {
			sourceInfos.set(skill.filePath, skill.sourceInfo);
		}
	}
	for (const prompt of promptsResult.prompts) {
		if (prompt.sourceInfo) {
			sourceInfos.set(prompt.filePath, prompt.sourceInfo);
		}
	}
	for (const loadedTheme of themesResult.themes) {
		if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
			sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
		}
	}

	if (showListing) {
		const contextFiles = session.resourceLoader.getAgentsFiles().agentsFiles;
		const rulesFiles = session.resourceLoader.getRulesFiles().rulesFiles;
		if (contextFiles.length > 0 || rulesFiles.length > 0) {
			container.addChild(new Spacer(1));
		}
		if (contextFiles.length > 0) {
			const contextList = contextFiles.map((f) => theme.fg("dim", `  ${formatDisplayPath(f.path)}`)).join("\n");
			const contextCompactList = formatCompactList(
				contextFiles.map((contextFile) => formatContextPath(contextFile.path, cwd)),
				{ sort: false },
			);
			addLoadedSection("Context", contextCompactList, contextList);
		}
		if (rulesFiles.length > 0) {
			const rulesList = rulesFiles.map((f) => theme.fg("dim", `  ${formatDisplayPath(f.path)}`)).join("\n");
			const rulesCompactList = formatCompactList(
				rulesFiles.map((rulesFile) => formatDisplayPath(rulesFile.path)),
				{ sort: false },
			);
			addLoadedSection("User Rules", rulesCompactList, rulesList);
		}

		if (activeToolNames.length > 0) {
			const toolList = formatCompactList(activeToolNames);
			addLoadedSection("Tools", toolList);
		}

		const skills = skillsResult.skills;
		if (skills.length > 0) {
			const groups = buildScopeGroups(
				skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })),
			);
			const skillList = formatScopeGroups(groups, {
				formatPath: (item) => formatDisplayPath(item.path),
				formatPackagePath: (item) => getShortPath(item.path, item.sourceInfo),
			});
			const skillCompactList = formatCompactList(skills.map((skill) => skill.name));
			addLoadedSection("Skills", skillCompactList, skillList);
		}

		const templates = session.promptTemplates;
		if (templates.length > 0) {
			const groups = buildScopeGroups(
				templates.map((template) => ({ path: template.filePath, sourceInfo: template.sourceInfo })),
			);
			const templateByPath = new Map(templates.map((t) => [t.filePath, t]));
			const templateList = formatScopeGroups(groups, {
				formatPath: (item) => {
					const template = templateByPath.get(item.path);
					return template ? `/${template.name}` : formatDisplayPath(item.path);
				},
				formatPackagePath: (item) => {
					const template = templateByPath.get(item.path);
					return template ? `/${template.name}` : formatDisplayPath(item.path);
				},
			});
			const promptCompactList = formatCompactList(templates.map((template) => `/${template.name}`));
			addLoadedSection("Prompts", promptCompactList, templateList);
		}

		if (extensions.length > 0) {
			const groups = buildScopeGroups(extensions);
			const extList = formatScopeGroups(groups, {
				formatPath: (item) => formatExtensionDisplayPath(item.path),
				formatPackagePath: (item) => formatExtensionDisplayPath(getShortPath(item.path, item.sourceInfo)),
			});
			const extensionCompactList = formatCompactList(getCompactExtensionLabels(extensions));
			addLoadedSection("Extensions", extensionCompactList, extList, "mdHeading");
		}

		// Show loaded themes (excluding built-in)
		const loadedThemes = themesResult.themes;
		const customThemes = loadedThemes.flatMap((loadedTheme) =>
			loadedTheme.sourcePath ? [{ loadedTheme, sourcePath: loadedTheme.sourcePath }] : [],
		);
		if (customThemes.length > 0) {
			const groups = buildScopeGroups(
				customThemes.map(({ loadedTheme, sourcePath }) => ({
					path: sourcePath,
					sourceInfo: loadedTheme.sourceInfo,
				})),
			);
			const themeList = formatScopeGroups(groups, {
				formatPath: (item) => formatDisplayPath(item.path),
				formatPackagePath: (item) => getShortPath(item.path, item.sourceInfo),
			});
			const themeCompactList = formatCompactList(
				customThemes.map(
					({ loadedTheme, sourcePath }) =>
						loadedTheme.name ?? getCompactPathLabel(sourcePath, loadedTheme.sourceInfo),
				),
			);
			addLoadedSection("Themes", themeCompactList, themeList);
		}
	}

	if (showDiagnostics) {
		const skillDiagnostics = skillsResult.diagnostics;
		if (skillDiagnostics.length > 0) {
			const warningLines = formatDiagnostics(skillDiagnostics, sourceInfos);
			container.addChild(new Text(`${theme.fg("warning", "[Skill conflicts]")}\n${warningLines}`, 0, 0));
			container.addChild(new Spacer(1));
		}

		const promptDiagnostics = promptsResult.diagnostics;
		if (promptDiagnostics.length > 0) {
			const warningLines = formatDiagnostics(promptDiagnostics, sourceInfos);
			container.addChild(new Text(`${theme.fg("warning", "[Prompt conflicts]")}\n${warningLines}`, 0, 0));
			container.addChild(new Spacer(1));
		}

		const extensionDiagnostics: ResourceDiagnostic[] = [];
		const extensionErrors = session.resourceLoader.getExtensions().errors;
		if (extensionErrors.length > 0) {
			for (const error of extensionErrors) {
				extensionDiagnostics.push({ type: "error", message: error.error, path: error.path });
			}
		}

		const commandDiagnostics = session.extensionRunner.getCommandDiagnostics();
		extensionDiagnostics.push(...commandDiagnostics);
		extensionDiagnostics.push(...getBuiltInCommandConflicts());

		const shortcutDiagnostics = session.extensionRunner.getShortcutDiagnostics();
		extensionDiagnostics.push(...shortcutDiagnostics);

		if (extensionDiagnostics.length > 0) {
			const warningLines = formatDiagnostics(extensionDiagnostics, sourceInfos);
			container.addChild(new Text(`${theme.fg("warning", "[Extension issues]")}\n${warningLines}`, 0, 0));
			container.addChild(new Spacer(1));
		}

		const themeDiagnostics = themesResult.diagnostics;
		if (themeDiagnostics.length > 0) {
			const warningLines = formatDiagnostics(themeDiagnostics, sourceInfos);
			container.addChild(new Text(`${theme.fg("warning", "[Theme conflicts]")}\n${warningLines}`, 0, 0));
			container.addChild(new Spacer(1));
		}
	}
}
