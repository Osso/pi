import { randomUUID } from "node:crypto";
import { Container, type Focusable, Input, Key, matchesKey, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { getAgentDir } from "../config.ts";
import type { AgentSessionEvent } from "../core/agent-session.ts";
import { ResidentConsoleClient, type ResidentConsoleService } from "../core/resident-console-transport.ts";
import {
	isDuplicateTurnAssistantMessage,
	isDuplicateTurnGuardMessage,
} from "../core/runtime-message-markers.ts";
import { getControlDbPath } from "../core/session-control-db.ts";
import { type SessionEntry, sessionEntryToContextMessages } from "../core/session-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { AssistantMessageComponent } from "../modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../modes/interactive/components/user-message.ts";
import { theme } from "../modes/interactive/theme/theme.ts";
import { createStartupTui, startStartupTui } from "./startup-ui.ts";

export interface ResidentConsoleCommand {
	service: ResidentConsoleService;
	initialPrompt?: string;
}

export function parseResidentConsoleArgs(args: string[]): ResidentConsoleCommand | undefined {
	const service = args[0] === "--supervisor" ? "supervisor" : args[0] === "--architect" ? "architect" : undefined;
	if (!service) return undefined;
	const promptParts = args.slice(1);
	if (promptParts.some((part) => part.startsWith("-"))) {
		throw new Error(`--${service} cannot be combined with normal Pi CLI flags`);
	}
	const initialPrompt = promptParts.join(" ").trim() || undefined;
	return { service, ...(initialPrompt ? { initialPrompt } : {}) };
}

export async function runResidentConsoleCommand(command: ResidentConsoleCommand): Promise<void> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error(`--${command.service} requires an interactive terminal`);
	}
	const agentDir = getAgentDir();
	const socketPath = `${getControlDbPath()}.${command.service}-console.sock`;
	const client = await ResidentConsoleClient.connect<SessionEntry, AgentSessionEvent>({
		socketPath,
		service: command.service,
	});
	const settingsManager = SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false });
	const ui = await createStartupTui(settingsManager);
	const consoleUi = new ResidentConsoleUi(ui, client, command.service);
	ui.addChild(consoleUi);
	ui.setFocus(consoleUi);
	startStartupTui(ui, settingsManager);
	try {
		if (command.initialPrompt) await consoleUi.submit(command.initialPrompt);
		await consoleUi.waitUntilClosed();
	} finally {
		ui.stop();
		await client.close();
	}
}

export class ResidentConsoleUi extends Container implements Focusable {
	readonly input = new Input();
	private _focused = false;
	private readonly chat = new Container();
	private readonly status = new Text("", 1, 0);
	private readonly client: ResidentConsoleClient<SessionEntry, AgentSessionEvent>;
	private readonly ui: TUI;
	private streamingAssistant?: AssistantMessageComponent;
	private resolveClosed?: () => void;
	private closed = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		ui: TUI,
		client: ResidentConsoleClient<SessionEntry, AgentSessionEvent>,
		service: ResidentConsoleService,
	) {
		super();
		this.ui = ui;
		this.client = client;
		this.addChild(new Text(theme.fg("accent", `${service} resident console`), 1, 0));
		this.addChild(new Text(theme.fg("dim", `${client.snapshot.cwd} · pid ${client.snapshot.generation}`), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.chat);
		this.addChild(this.status);
		this.addChild(new Spacer(1));
		this.addChild(this.input);
		for (const entry of client.snapshot.branch) this.appendEntry(entry);
		this.input.onSubmit = (value) => void this.submit(value);
		client.onEvent(({ event }) => this.handleEvent(event));
		client.onDisconnect((error) => {
			this.status.setText(theme.fg("error", error?.message ?? "Resident service disconnected"));
			this.close();
		});
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrl("d"))) {
			this.close();
			return;
		}
		this.input.handleInput(data);
	}

	async submit(value: string): Promise<void> {
		const text = value.trim();
		if (!text) return;
		this.input.setValue("");
		this.status.setText(theme.fg("muted", "Queued…"));
		this.ui.requestRender();
		try {
			await this.client.prompt(randomUUID(), text);
			this.status.setText(theme.fg("muted", "Working…"));
		} catch (error) {
			this.status.setText(theme.fg("error", error instanceof Error ? error.message : String(error)));
		}
		this.ui.requestRender();
	}

	waitUntilClosed(): Promise<void> {
		if (this.closed) return Promise.resolve();
		return new Promise((resolve) => {
			this.resolveClosed = resolve;
		});
	}

	private handleEvent(event: AgentSessionEvent): void {
		if (event.type === "entry_appended") this.appendEntry(event.entry);
		if (event.type === "agent_start") this.status.setText(theme.fg("muted", "Working…"));
		if (event.type === "agent_end") this.status.setText("");
		if (event.type === "message_start") this.startMessage(event.message, event.runtimeMessageMarker);
		if (event.type === "message_update" && event.message.role === "assistant") {
			this.streamingAssistant?.updateContent(event.message);
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			if (isDuplicateTurnAssistantMessage(event.message, event.runtimeMessageMarker)) {
				if (this.streamingAssistant) this.chat.removeChild(this.streamingAssistant);
				this.streamingAssistant = undefined;
			} else {
				this.streamingAssistant?.updateContent(event.message);
				this.streamingAssistant = undefined;
			}
		}
		this.ui.requestRender();
	}

	private startMessage(
		message: Extract<AgentSessionEvent, { type: "message_start" }>["message"],
		runtimeMessageMarker?: Extract<AgentSessionEvent, { type: "message_start" }>["runtimeMessageMarker"],
	): void {
		if (message.role === "user") {
			if (isDuplicateTurnGuardMessage(message, runtimeMessageMarker)) return;
			this.chat.addChild(new UserMessageComponent(readTextContent(message.content)));
			return;
		}
		if (message.role !== "assistant") return;
		this.streamingAssistant = new AssistantMessageComponent(message);
		this.chat.addChild(this.streamingAssistant);
	}

	private appendEntry(entry: SessionEntry): void {
		for (const message of sessionEntryToContextMessages(entry)) {
			if (message.role === "assistant") {
				this.chat.addChild(new AssistantMessageComponent(message));
				continue;
			}
			if (message.role === "user") {
				this.chat.addChild(new UserMessageComponent(readTextContent(message.content)));
				continue;
			}
			const content = "content" in message ? message.content : message;
			this.chat.addChild(new Text(readTextContent(content), 1, 0));
		}
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.resolveClosed?.();
	}
}

function readTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => {
			return typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part;
		})
		.map((part) => part.text)
		.join("\n");
}
