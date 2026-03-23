/**
 * Configuration for ask-forge agent.
 *
 * This file contains all configurable settings for the TypeScript agent.
 */

import type { ThinkingBudgets, ThinkingLevel } from "@mariozechner/pi-ai";

// =============================================================================
// THINKING CONFIGURATION
// =============================================================================

/**
 * Configuration for reasoning/thinking.
 *
 * - ThinkingLevel ("minimal"|"low"|"medium"|"high"|"xhigh"): Works across all providers
 *   via streamSimple(). Each provider translates to its native format.
 * - "adaptive": Model decides effort per-request (Anthropic-only, uses stream() directly).
 */
export interface ThinkingConfig {
	/**
	 * Thinking level.
	 * - ThinkingLevel: Works across all providers via streamSimple().
	 * - "adaptive": Model decides effort per-request (Anthropic-only, uses stream() directly).
	 */
	level: ThinkingLevel | "adaptive";
	/** Custom token budgets per level (for token-based providers like older Claude, Gemini). */
	budgetOverrides?: ThinkingBudgets;
}

export type { ThinkingBudgets, ThinkingLevel };

// =============================================================================
// MODEL CONFIGURATION
// =============================================================================

/** Model provider (e.g., "openrouter", "anthropic") */
export const MODEL_PROVIDER = "openrouter" as const;

/** Model identifier */
export const MODEL_NAME = "anthropic/claude-sonnet-4.6" as const;

/** Maximum tool-use iterations (how many tool calls the agent can make before giving a final answer) */
export const MAX_TOOL_ITERATIONS = 20;

// =============================================================================
// CONTEXT COMPACTION CONFIGURATION
// =============================================================================

/**
 * Default settings for context compaction.
 * When context grows too large, older messages are summarized to stay within limits.
 */
export const COMPACTION_SETTINGS = {
	/** Whether compaction is enabled */
	enabled: true,
	/** Tokens to reserve for LLM response */
	reserveTokens: 16384,
	/** Recent tokens to keep (not summarized) */
	keepRecentTokens: 20000,
	/** Model context window size */
	contextWindow: 200000,
};

export type CompactionSettings = typeof COMPACTION_SETTINGS;

// =============================================================================
// SYSTEM PROMPT
// =============================================================================

// The default system prompt is now built dynamically in src/index.ts via
// buildDefaultSystemPrompt(repoUrl, commitSha) so it can embed permalink URLs.
// See src/index.ts for the canonical prompt text.
