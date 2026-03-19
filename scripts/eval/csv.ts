import { readFile } from "node:fs/promises";

// =============================================================================
// Types
// =============================================================================

export interface EvalRow {
	session_id: string;
	repository: string;
	commit_id: string;
	question: string;
	is_answer_complete: string;
	is_evidence_supported: string;
	is_evidence_linked: string;
	is_reasoning_sound: string;
	misc_feedback: string;
	answer: string;
	broken_link_ratio: string;
	tool_calls: string;
	files_read: string;
	inference_time_ms: string;
	input_tokens: string;
	output_tokens: string;
	total_tokens: string;
	cache_read_tokens: string;
	cache_write_tokens: string;
	ask_model: string;
	judge_model: string;
	ask_system_prompt: string;
	judge_prompt: string;
	reasoning_level: string;
}

// =============================================================================
// Constants
// =============================================================================

const REQUIRED_COLUMNS = ["repository", "commit_id", "question"] as const;

const OUTPUT_COLUMNS = [
	"session_id",
	"repository",
	"commit_id",
	"question",
	"is_answer_complete",
	"is_evidence_supported",
	"is_evidence_linked",
	"is_reasoning_sound",
	"misc_feedback",
	"answer",
	"broken_link_ratio",
	"tool_calls",
	"files_read",
	"inference_time_ms",
	"input_tokens",
	"output_tokens",
	"total_tokens",
	"cache_read_tokens",
	"cache_write_tokens",
	"ask_model",
	"judge_model",
	"ask_system_prompt",
	"judge_prompt",
] as const;

// =============================================================================
// Parsing
// =============================================================================

export type ParseResult = { ok: true; rows: EvalRow[] } | { ok: false; error: string };

/**
 * Parse CSV content into rows, correctly handling:
 * - Newlines inside quoted fields
 * - Escaped quotes (doubled "")
 * - Commas inside quoted fields
 */
export function parseCsv(content: string): ParseResult {
	const records = parseCsvRecords(content);
	if (records.length === 0) {
		return { ok: false, error: "CSV file is empty" };
	}

	// Validate header row
	const header = records[0] as string[];
	const missing = REQUIRED_COLUMNS.filter((col) => !header.includes(col));
	const hasSessionId = header.includes("session_id");
	const hasId = header.includes("id");
	if (missing.length > 0) {
		return {
			ok: false,
			error: `Missing required columns: ${missing.join(", ")}\n\nExpected CSV header (at minimum):\n  ${REQUIRED_COLUMNS.join(",")}`,
		};
	}
	if (!hasSessionId && !hasId) {
		return {
			ok: false,
			error: 'Missing identifier column: expected either "session_id" or "id"',
		};
	}

	// Build column index map so column order doesn't matter
	const colIndex = Object.fromEntries(header.map((col, idx) => [col.trim(), idx])) as Record<string, number>;

	if (records.length < 2) {
		return { ok: false, error: "CSV file has a header but no data rows" };
	}

	const rows: EvalRow[] = [];
	for (let i = 1; i < records.length; i++) {
		const fields = records[i] as string[];
		rows.push({
			session_id: hasSessionId ? (fields[colIndex.session_id] ?? "") : (fields[colIndex.id] ?? ""),
			repository: fields[colIndex.repository] ?? "",
			commit_id: fields[colIndex.commit_id] ?? "",
			question: fields[colIndex.question] ?? "",
			answer: "",
			is_answer_complete: "",
			is_evidence_supported: "",
			is_evidence_linked: "",
			is_reasoning_sound: "",
			misc_feedback: "",
			broken_link_ratio: "",
			tool_calls: "",
			files_read: "",
			inference_time_ms: "",
			input_tokens: "",
			output_tokens: "",
			total_tokens: "",
			cache_read_tokens: "",
			cache_write_tokens: "",
			ask_model: "",
			judge_model: "",
			ask_system_prompt: "",
			judge_prompt: "",
		});
	}
	return { ok: true, rows };
}

/** Parse full CSV content into an array of records (each record is an array of field strings) */
function parseCsvRecords(content: string): string[][] {
	const records: string[][] = [];
	let current = "";
	let inQuotes = false;
	let fields: string[] = [];

	for (let i = 0; i < content.length; i++) {
		const ch = content[i] as string;
		if (inQuotes) {
			if (ch === '"') {
				if (i + 1 < content.length && content[i + 1] === '"') {
					current += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				current += ch;
			}
		} else {
			if (ch === '"') {
				inQuotes = true;
			} else if (ch === ",") {
				fields.push(current);
				current = "";
			} else if (ch === "\n" || ch === "\r") {
				// Handle \r\n
				if (ch === "\r" && i + 1 < content.length && content[i + 1] === "\n") {
					i++;
				}
				fields.push(current);
				current = "";
				// Only add non-empty records (skip trailing blank lines)
				if (fields.some((f) => f.length > 0)) {
					records.push(fields);
				}
				fields = [];
			} else {
				current += ch;
			}
		}
	}
	// Handle last record if file doesn't end with newline
	fields.push(current);
	if (fields.some((f) => f.length > 0)) {
		records.push(fields);
	}

	return records;
}

// =============================================================================
// Writing
// =============================================================================

function escapeCsvField(value: string): string {
	if (value.includes(",") || value.includes('"') || value.includes("\n")) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

function rowToCsv(row: EvalRow): string {
	return OUTPUT_COLUMNS.map((col) => escapeCsvField(row[col])).join(",");
}

export async function loadRowsFromCsv(path: string): Promise<EvalRow[]> {
	const csvContent = await readFile(path, "utf-8");
	const parsed = parseCsv(csvContent);
	if (!parsed.ok) {
		throw new Error(parsed.error);
	}
	return parsed.rows;
}

export function writeCsvString(rows: EvalRow[]): string {
	const header = OUTPUT_COLUMNS.join(",");
	return `${[header, ...rows.map(rowToCsv)].join("\n")}\n`;
}
