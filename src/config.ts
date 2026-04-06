/**
 * Configuration for megasthenes agent.
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
 * - Effort-based (cross-provider): Set an effort level, mapped to each provider's native
 *   format by pi-ai's streamSimple() (e.g., reasoning.effort for OpenAI, thinking for Anthropic/Google).
 * - Adaptive (Anthropic 4.6 only): Model decides when/how much to think.
 *   Uses pi-ai's stream() with thinkingEnabled.
 */
export type ThinkingConfig =
	| {
			/** Model decides when/how much to think (Anthropic 4.6 models only). Uses stream(). */
			type: "adaptive";
			/** Optional effort guidance for adaptive mode (defaults to "high" in the Anthropic API). */
			effort?: ThinkingLevel;
	  }
	| {
			type?: undefined;
			/** Effort level. Mapped to each provider's native format by streamSimple(). */
			effort: ThinkingLevel;
			/** Custom token budgets per level (for token-based providers like older Claude, Gemini). */
			budgetOverrides?: ThinkingBudgets;
	  };

export type { ThinkingBudgets, ThinkingLevel };

// =============================================================================
// MODEL CONFIGURATION
// =============================================================================

/** Model provider (e.g., "openrouter", "anthropic") */
export const MODEL_PROVIDER = "anthropic" as const;

/** Model identifier */
export const MODEL_NAME = "claude-sonnet-4-6" as const;

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
