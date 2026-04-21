/**
 * Context compaction for megasthenes.
 * Inspired by pi coding agent's compaction approach.
 *
 * When context gets too large, we:
 * 1. Serialize older messages to text
 * 2. Generate a summary using an LLM
 * 3. Replace older messages with a summary message
 */
import { type Api, completeSimple, type Message, type Model } from "@mariozechner/pi-ai";
import { COMPACTION_SETTINGS, type CompactionSettings } from "./config";

export type { CompactionSettings };

type AnyModel = Model<Api>;

export function getCompactionSettings(): CompactionSettings {
	return { ...COMPACTION_SETTINGS };
}

interface TokenEstimateIndex {
	perMessage: number[];
	// prefixSums has length messages.length + 1 where prefixSums[i] is the
	// token total for messages.slice(0, i). This makes slice sums [start, end)
	// a simple subtraction and keeps empty ranges representable.
	prefixSums: number[];
	total: number;
}

// Messages are treated as immutable during compaction, so object identity is a safe cache key.
const messageTokenEstimateCache = new WeakMap<Message, number>();

// =============================================================================
// Token Estimation
// =============================================================================

/**
 * Estimate token count for a message using chars/4 heuristic.
 * This is conservative (overestimates tokens).
 */
export function estimateTokens(message: Message): number {
	let chars = 0;

	switch (message.role) {
		case "user": {
			const content = message.content;
			if (typeof content === "string") {
				chars = content.length;
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "text" && "text" in block) {
						chars += block.text.length;
					}
				}
			}
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			for (const block of message.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + JSON.stringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "toolResult": {
			for (const block of message.content) {
				if (block.type === "text" && "text" in block) {
					chars += block.text.length;
				}
				if (block.type === "image") {
					chars += 4800; // Estimate images as ~1200 tokens
				}
			}
			return Math.ceil(chars / 4);
		}
	}

	return 0;
}

function estimateTokensCached(message: Message): number {
	const cached = messageTokenEstimateCache.get(message);
	if (cached !== undefined) {
		return cached;
	}

	const tokens = estimateTokens(message);
	messageTokenEstimateCache.set(message, tokens);
	return tokens;
}

function buildTokenEstimateIndex(messages: Message[]): TokenEstimateIndex {
	const perMessage: number[] = [];
	const prefixSums = [0];
	let total = 0;

	for (const message of messages) {
		const tokens = estimateTokensCached(message);
		perMessage.push(tokens);
		total += tokens;
		prefixSums.push(total);
	}

	return { perMessage, prefixSums, total };
}

function sumIndexedTokens(tokenIndex: TokenEstimateIndex, start: number, end: number): number {
	// prefix sums use [start, end) semantics, matching Array.prototype.slice.
	const startSum = tokenIndex.prefixSums[start];
	const endSum = tokenIndex.prefixSums[end];
	if (startSum === undefined || endSum === undefined) {
		throw new Error(`Invalid token index range: ${start}-${end}`);
	}
	return endSum - startSum;
}

/**
 * Estimate total context tokens from messages.
 */
export function estimateContextTokens(messages: Message[]): number {
	return buildTokenEstimateIndex(messages).total;
}

/**
 * Check if compaction should trigger based on context usage.
 */
export function shouldCompact(contextTokens: number, settings: CompactionSettings = COMPACTION_SETTINGS): boolean {
	if (!settings.enabled) return false;
	return contextTokens > settings.contextWindow - settings.reserveTokens;
}

// =============================================================================
// Message Serialization
// =============================================================================

/**
 * Serialize messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					textParts.push(block.text);
				} else if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					const args = block.arguments;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}

			if (thinkingParts.length > 0) {
				parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
			}
			if (textParts.length > 0) {
				parts.push(`[Assistant]: ${textParts.join("\n")}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			const content = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			if (content) {
				// Truncate very long tool results
				const truncated = content.length > 2000 ? `${content.slice(0, 2000)}... [truncated]` : content;
				parts.push(`[Tool result]: ${truncated}`);
			}
		}
	}

	return parts.join("\n\n");
}

// =============================================================================
// File Operations Tracking
// =============================================================================

interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

function extractFileOpsFromMessage(message: Message, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;

	for (const block of message.content) {
		if (block.type !== "toolCall") continue;

		const args = block.arguments as Record<string, unknown>;
		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		switch (block.name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];

	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}

	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// =============================================================================
// Cut Point Detection
// =============================================================================

interface CutPointResult {
	/** Index of first message to keep */
	firstKeptIndex: number;
	/** Messages to summarize (complete turns before cut point) */
	messagesToSummarize: Message[];
	/** Messages from turn prefix to summarize (if split turn) */
	turnPrefixMessages: Message[];
	/** Messages to keep */
	messagesToKeep: Message[];
	/** Whether we're cutting in the middle of a turn */
	isSplitTurn: boolean;
	/** Index of user message that starts the split turn (-1 if not splitting) */
	turnStartIndex: number;
}

/**
 * Find valid cut points: user messages and assistant messages.
 * Never cut at tool results (they must follow their tool call).
 */
function findValidCutPoints(messages: Message[]): number[] {
	const cutPoints: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg) continue;
		const role = msg.role;
		if (role === "user" || role === "assistant") {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * Find the user message that starts the turn containing the given index.
 * Returns -1 if no turn start found.
 */
function findTurnStartIndex(messages: Message[], entryIndex: number): number {
	for (let i = entryIndex; i >= 0; i--) {
		const msg = messages[i];
		if (msg && msg.role === "user") {
			return i;
		}
	}
	return -1;
}

/**
 * Find the cut point that keeps approximately `keepRecentTokens`.
 * Can cut at user OR assistant messages. When cutting at an assistant message,
 * we're splitting a turn and need to summarize the turn prefix separately.
 */
function findCutPointFromIndex(
	messages: Message[],
	settings: CompactionSettings,
	tokenIndex: TokenEstimateIndex,
): CutPointResult {
	const { keepRecentTokens } = settings;

	const cutPoints = findValidCutPoints(messages);

	if (cutPoints.length === 0) {
		return {
			firstKeptIndex: 0,
			messagesToSummarize: [],
			turnPrefixMessages: [],
			messagesToKeep: messages,
			isSplitTurn: false,
			turnStartIndex: -1,
		};
	}

	// Find user message indices for turn boundary detection
	const userMessageIndices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg && msg.role === "user") {
			userMessageIndices.push(i);
		}
	}

	if (userMessageIndices.length <= 1) {
		// Only one user message - check if we can split the turn
		if (cutPoints.length <= 1) {
			return {
				firstKeptIndex: 0,
				messagesToSummarize: [],
				turnPrefixMessages: [],
				messagesToKeep: messages,
				isSplitTurn: false,
				turnStartIndex: -1,
			};
		}
		// We can potentially split within the single turn
	}

	// Reuse indexed token estimates so cut-point selection does not rescan messages.
	let accumulatedTokens = 0;
	let cutIndex = 0;

	for (let i = messages.length - 1; i >= 0; i--) {
		accumulatedTokens += tokenIndex.perMessage[i] ?? 0;

		if (accumulatedTokens >= keepRecentTokens) {
			// Find nearest valid cut point at or after this index
			for (const cp of cutPoints) {
				if (cp >= i) {
					cutIndex = cp;
					break;
				}
			}
			break;
		}
	}

	// Don't summarize if cut point is at the beginning
	if (cutIndex === 0) {
		return {
			firstKeptIndex: 0,
			messagesToSummarize: [],
			turnPrefixMessages: [],
			messagesToKeep: messages,
			isSplitTurn: false,
			turnStartIndex: -1,
		};
	}

	// Determine if this is a split turn (cut point is not a user message)
	const cutMessage = messages[cutIndex];
	const isUserMessage = cutMessage?.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(messages, cutIndex);
	const isSplitTurn = !isUserMessage && turnStartIndex !== -1;

	if (isSplitTurn) {
		// Split turn: summarize complete turns + turn prefix separately
		const historyEnd = turnStartIndex;
		return {
			firstKeptIndex: cutIndex,
			messagesToSummarize: messages.slice(0, historyEnd),
			turnPrefixMessages: messages.slice(turnStartIndex, cutIndex),
			messagesToKeep: messages.slice(cutIndex),
			isSplitTurn: true,
			turnStartIndex,
		};
	}

	return {
		firstKeptIndex: cutIndex,
		messagesToSummarize: messages.slice(0, cutIndex),
		turnPrefixMessages: [],
		messagesToKeep: messages.slice(cutIndex),
		isSplitTurn: false,
		turnStartIndex: -1,
	};
}

export function findCutPoint(messages: Message[], settings: CompactionSettings = COMPACTION_SETTINGS): CutPointResult {
	return findCutPointFromIndex(messages, settings, buildTokenEstimateIndex(messages));
}

// Expose internals so regression tests can lock down refactor invariants directly.
export const compactionTestInternals = {
	buildTokenEstimateIndex,
	findCutPointFromIndex,
	sumIndexedTokens,
};

// =============================================================================
// Summary Generation
// =============================================================================

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

export interface CompactionResult {
	/** The generated summary text */
	summary: string;
	/** Messages to keep (recent context) */
	keptMessages: Message[];
	/** Index of first kept message (maps to DB ordinal) */
	firstKeptIndex: number;
	/** Token count before compaction */
	tokensBefore: number;
	/** Estimated token count after compaction */
	tokensAfter: number;
	/** Files that were read during the summarized conversation */
	readFiles: string[];
	/** Files that were modified during the summarized conversation */
	modifiedFiles: string[];
}

/**
 * Generate a summary of messages using an LLM.
 */
async function generateSummary(
	model: AnyModel,
	messages: Message[],
	previousSummary?: string,
	_signal?: AbortSignal,
	_maxTokens = 4096,
): Promise<string> {
	const conversationText = serializeConversation(messages);

	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
		promptText += UPDATE_SUMMARIZATION_PROMPT;
	} else {
		promptText += SUMMARIZATION_PROMPT;
	}

	const response = await completeSimple(model, {
		systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
		messages: [{ role: "user", content: promptText, timestamp: Date.now() }],
	});

	if (response.stopReason === "error" || !response.content || response.content.length === 0) {
		throw new Error(`Summarization API error: ${response.errorMessage ?? "unknown error"}`);
	}

	const text = response.content
		.filter((b) => b.type === "text")
		.map((b) => (b as { type: "text"; text: string }).text)
		.join("");

	return text || "";
}

/**
 * Generate a summary for a turn prefix (when splitting a turn).
 */
async function generateTurnPrefixSummary(model: AnyModel, messages: Message[], _signal?: AbortSignal): Promise<string> {
	const conversationText = serializeConversation(messages);
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;

	const response = await completeSimple(model, {
		systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
		messages: [{ role: "user", content: promptText, timestamp: Date.now() }],
	});

	if (response.stopReason === "error" || !response.content || response.content.length === 0) {
		throw new Error(`Turn prefix summarization API error: ${response.errorMessage ?? "unknown error"}`);
	}

	const text = response.content
		.filter((b) => b.type === "text")
		.map((b) => (b as { type: "text"; text: string }).text)
		.join("");

	return text || "";
}

function createSummaryWrapperMessage(summary: string): Message {
	return {
		role: "user",
		content: `[CONTEXT SUMMARY - Previous conversation was compacted]\n\n${summary}\n\n[END CONTEXT SUMMARY - Continue from here]`,
		timestamp: Date.now(),
	};
}

async function compactWithTokenIndex(
	model: AnyModel,
	messages: Message[],
	previousSummary: string | undefined,
	signal: AbortSignal | undefined,
	tokenIndex: TokenEstimateIndex,
	settings: CompactionSettings,
): Promise<CompactionResult> {
	const tokensBefore = tokenIndex.total;
	const cutPoint = findCutPointFromIndex(messages, settings, tokenIndex);

	if (cutPoint.messagesToSummarize.length === 0 && cutPoint.turnPrefixMessages.length === 0) {
		// Nothing to compact
		return {
			summary: previousSummary || "",
			keptMessages: messages,
			firstKeptIndex: 0,
			tokensBefore,
			tokensAfter: tokensBefore,
			readFiles: [],
			modifiedFiles: [],
		};
	}

	// Extract file operations from all messages being summarized.
	const fileOps = createFileOps();
	for (const msg of cutPoint.messagesToSummarize) {
		extractFileOpsFromMessage(msg, fileOps);
	}
	for (const msg of cutPoint.turnPrefixMessages) {
		extractFileOpsFromMessage(msg, fileOps);
	}
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);

	// Generate summary/summaries.
	let summary: string;

	if (cutPoint.isSplitTurn && cutPoint.turnPrefixMessages.length > 0) {
		// Split turn: generate both summaries in parallel and merge.
		const [historyResult, turnPrefixResult] = await Promise.all([
			cutPoint.messagesToSummarize.length > 0
				? generateSummary(model, cutPoint.messagesToSummarize, previousSummary, signal)
				: Promise.resolve(previousSummary || "No prior history."),
			generateTurnPrefixSummary(model, cutPoint.turnPrefixMessages, signal),
		]);

		// Merge into single summary.
		summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
	} else {
		// Normal case: just generate history summary.
		summary = await generateSummary(model, cutPoint.messagesToSummarize, previousSummary, signal);
	}

	// Append file operations to summary.
	summary += formatFileOperations(readFiles, modifiedFiles);

	const keptTokens = sumIndexedTokens(tokenIndex, cutPoint.firstKeptIndex, messages.length);
	const summaryMessage = createSummaryWrapperMessage(summary);
	const tokensAfter = estimateTokensCached(summaryMessage) + keptTokens;

	return {
		summary,
		keptMessages: cutPoint.messagesToKeep,
		firstKeptIndex: cutPoint.firstKeptIndex,
		tokensBefore,
		tokensAfter,
		readFiles,
		modifiedFiles,
	};
}

/**
 * Perform compaction on messages.
 * Returns the summary and the messages to keep.
 */
export async function compact(
	model: AnyModel,
	messages: Message[],
	previousSummary?: string,
	signal?: AbortSignal,
	settings?: Partial<CompactionSettings>,
): Promise<CompactionResult> {
	const resolved = { ...COMPACTION_SETTINGS, ...settings };
	return compactWithTokenIndex(model, messages, previousSummary, signal, buildTokenEstimateIndex(messages), resolved);
}

export interface MaybeCompactResult {
	messages: Message[];
	summary?: string;
	wasCompacted: boolean;
	/** Ordinal of first kept message (for DB persistence) */
	firstKeptOrdinal: number;
	tokensBefore: number;
	tokensAfter: number;
	readFiles: string[];
	modifiedFiles: string[];
}

/**
 * Check if messages need compaction and perform it if necessary.
 * Returns the (possibly compacted) messages ready for the next ask.
 */
export async function maybeCompact(
	model: AnyModel,
	messages: Message[],
	previousSummary?: string,
	signal?: AbortSignal,
	settings?: Partial<CompactionSettings>,
): Promise<MaybeCompactResult> {
	const resolved: CompactionSettings = { ...COMPACTION_SETTINGS, ...settings };
	const tokenIndex = buildTokenEstimateIndex(messages);
	const contextTokens = tokenIndex.total;

	if (!shouldCompact(contextTokens, resolved)) {
		return {
			messages,
			summary: previousSummary,
			wasCompacted: false,
			firstKeptOrdinal: 0,
			tokensBefore: contextTokens,
			tokensAfter: contextTokens,
			readFiles: [],
			modifiedFiles: [],
		};
	}

	const result = await compactWithTokenIndex(model, messages, previousSummary, signal, tokenIndex, resolved);
	const compactedMessages = [createSummaryWrapperMessage(result.summary), ...result.keptMessages];

	return {
		messages: compactedMessages,
		summary: result.summary,
		wasCompacted: true,
		firstKeptOrdinal: result.firstKeptIndex,
		tokensBefore: result.tokensBefore,
		tokensAfter: result.tokensAfter,
		readFiles: result.readFiles,
		modifiedFiles: result.modifiedFiles,
	};
}
