export type AutoReviewerPromptInput = {
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
	cwd: string;
};

export type AutoReviewerDecision =
	| {
			behavior: "allow";
	  }
	| {
			behavior: "deny";
			message: string;
	  };

export function buildAutoReviewerPrompt(_input: AutoReviewerPromptInput): string {
	throw new Error("Not implemented");
}

export function parseAutoReviewerDecision(_rawResponse: unknown): AutoReviewerDecision | undefined {
	throw new Error("Not implemented");
}
