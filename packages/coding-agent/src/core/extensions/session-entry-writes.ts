import type { SessionManager } from "../session-manager.ts";

/** Preserve the full setup API, but detach caller-owned entry data on writes. */
export function createSessionSetupWriteView(session: SessionManager): SessionManager {
	const writes = {
		appendMessage: (...args: Parameters<SessionManager["appendMessage"]>) =>
			session.appendMessage(...structuredClone(args)),
		appendCustomEntry: (...args: Parameters<SessionManager["appendCustomEntry"]>) =>
			session.appendCustomEntry(...structuredClone(args)),
		appendCustomMessageEntry: (...args: Parameters<SessionManager["appendCustomMessageEntry"]>) =>
			session.appendCustomMessageEntry(...structuredClone(args)),
		appendCompaction: (...args: Parameters<SessionManager["appendCompaction"]>) =>
			session.appendCompaction(...structuredClone(args)),
		branchWithSummary: (...args: Parameters<SessionManager["branchWithSummary"]>) =>
			session.branchWithSummary(...structuredClone(args)),
	};
	return new Proxy(session, {
		get(target, property) {
			if (Object.hasOwn(writes, property)) return Reflect.get(writes, property);
			const value: unknown = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
