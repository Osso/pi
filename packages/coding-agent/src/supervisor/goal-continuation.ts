/**
 * The generic goal continuation sent by the goal extension and chosen by Supervisor reviews.
 * It repeats the ask_questions rule so questions and blockers reach the Supervisor and the user's
 * question list instead of being buried in transcript text.
 */
export const GENERIC_GOAL_CONTINUATION =
	"Continue working toward the active goal. Ask questions and report blockers with ask_questions, not in plain text.";
