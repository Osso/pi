import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

function createSettingsManager(warnings: { anthropicExtraUsage?: boolean } = {}) {
	return {
		getWarnings: vi.fn().mockReturnValue(warnings),
	};
}

type FakeInteractiveMode = {
	anthropicSubscriptionWarningShown: boolean;
	settingsManager: ReturnType<typeof createSettingsManager>;
	session: {
		modelRegistry: {
			authStorage: { get: ReturnType<typeof vi.fn> };
			getApiKeyForProvider: ReturnType<typeof vi.fn>;
		};
	};
	showWarning: ReturnType<typeof vi.fn>;
};

function getWarningMethod() {
	const prototype = InteractiveMode.prototype as unknown as {
		maybeWarnAboutAnthropicSubscriptionAuth: (
			this: FakeInteractiveMode,
			model: { provider: string },
		) => Promise<void>;
	};
	return prototype.maybeWarnAboutAnthropicSubscriptionAuth;
}

describe("InteractiveMode.maybeWarnAboutAnthropicSubscriptionAuth", () => {
	test("warns once when Anthropic subscription auth is detected", async () => {
		const fakeThis: FakeInteractiveMode = {
			anthropicSubscriptionWarningShown: false,
			settingsManager: createSettingsManager(),
			session: {
				modelRegistry: {
					authStorage: {
						get: vi.fn().mockReturnValue(undefined),
					},
					getApiKeyForProvider: vi.fn().mockResolvedValue("sk-ant-oat01-test"),
				},
			},
			showWarning: vi.fn(),
		};

		await getWarningMethod().call(fakeThis, {
			provider: "anthropic",
		});
		await getWarningMethod().call(fakeThis, {
			provider: "anthropic",
		});

		expect(fakeThis.showWarning).toHaveBeenCalledTimes(1);
		expect(fakeThis.session.modelRegistry.getApiKeyForProvider).toHaveBeenCalledTimes(1);
	});

	test("warns when Anthropic OAuth is stored even if token refresh lookup would fail", async () => {
		const fakeThis: FakeInteractiveMode = {
			anthropicSubscriptionWarningShown: false,
			settingsManager: createSettingsManager(),
			session: {
				modelRegistry: {
					authStorage: {
						get: vi.fn().mockReturnValue({ type: "oauth" }),
					},
					getApiKeyForProvider: vi.fn().mockResolvedValue(undefined),
				},
			},
			showWarning: vi.fn(),
		};

		await getWarningMethod().call(fakeThis, {
			provider: "anthropic",
		});

		expect(fakeThis.showWarning).toHaveBeenCalledTimes(1);
		expect(fakeThis.session.modelRegistry.getApiKeyForProvider).not.toHaveBeenCalled();
	});

	test("does not warn for non-Anthropic models", async () => {
		const fakeThis: FakeInteractiveMode = {
			anthropicSubscriptionWarningShown: false,
			settingsManager: createSettingsManager(),
			session: {
				modelRegistry: {
					authStorage: {
						get: vi.fn(),
					},
					getApiKeyForProvider: vi.fn(),
				},
			},
			showWarning: vi.fn(),
		};

		await getWarningMethod().call(fakeThis, {
			provider: "openai",
		});

		expect(fakeThis.showWarning).not.toHaveBeenCalled();
		expect(fakeThis.session.modelRegistry.getApiKeyForProvider).not.toHaveBeenCalled();
	});

	test("does not warn when Anthropic extra usage warning is disabled", async () => {
		const fakeThis: FakeInteractiveMode = {
			anthropicSubscriptionWarningShown: false,
			settingsManager: createSettingsManager({ anthropicExtraUsage: false }),
			session: {
				modelRegistry: {
					authStorage: {
						get: vi.fn(),
					},
					getApiKeyForProvider: vi.fn(),
				},
			},
			showWarning: vi.fn(),
		};

		await getWarningMethod().call(fakeThis, {
			provider: "anthropic",
		});

		expect(fakeThis.showWarning).not.toHaveBeenCalled();
		expect(fakeThis.session.modelRegistry.authStorage.get).not.toHaveBeenCalled();
		expect(fakeThis.session.modelRegistry.getApiKeyForProvider).not.toHaveBeenCalled();
	});
});
