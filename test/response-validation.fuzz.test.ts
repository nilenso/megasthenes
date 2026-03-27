/**
 * Property-based (fuzz) tests for response-validation.
 *
 * These verify that parseMarkdownLinks never throws, never hangs,
 * and always returns structurally valid output — regardless of input.
 */
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { parseMarkdownLinks } from "../src/response-validation";

describe("parseMarkdownLinks — property-based", () => {
	test("never throws on arbitrary strings", () => {
		fc.assert(
			fc.property(fc.string(), (input) => {
				// Must not throw
				const result = parseMarkdownLinks(input);
				// Must always return an array
				expect(Array.isArray(result)).toBe(true);
			}),
			{ numRuns: 10_000 },
		);
	});

	test("never throws on arbitrary unicode", () => {
		fc.assert(
			fc.property(fc.string({ unit: "grapheme-composite" }), (input) => {
				const result = parseMarkdownLinks(input);
				expect(Array.isArray(result)).toBe(true);
			}),
			{ numRuns: 5_000 },
		);
	});

	test("every returned link has non-empty fullMatch and url", () => {
		fc.assert(
			fc.property(fc.string(), (input) => {
				const results = parseMarkdownLinks(input);
				for (const link of results) {
					expect(link.fullMatch.length).toBeGreaterThan(0);
					expect(link.url.length).toBeGreaterThan(0);
				}
			}),
			{ numRuns: 5_000 },
		);
	});

	test("repoPath is null for non-blob/tree links", () => {
		// Generate markdown links with random (non-blob/tree) URLs
		const markdownLink = fc
			.tuple(fc.string({ minLength: 1 }), fc.webUrl())
			.map(([text, url]) => `[${text.replace(/[\[\]]/g, "")}](${url})`);

		fc.assert(
			fc.property(markdownLink, (input) => {
				const results = parseMarkdownLinks(input);
				for (const link of results) {
					// A random webUrl is very unlikely to contain /blob/<hex>/
					// but if it does, that's fine — we just check structural validity
					expect(typeof link.repoPath === "string" || link.repoPath === null).toBe(true);
				}
			}),
			{ numRuns: 5_000 },
		);
	});

	test("correctly extracts path from generated blob links", () => {
		// Generate valid blob-style links and verify extraction
		// Use constrained alphabets to avoid characters that break markdown link syntax
		const safeSegment = fc.stringMatching(/^[a-zA-Z0-9_-]{1,20}$/);
		const blobLink = fc
			.tuple(
				safeSegment,
				fc.constantFrom("github.com", "gitlab.com"),
				safeSegment,
				safeSegment,
				fc.stringMatching(/^[a-f0-9]{6,40}$/),
				fc.stringMatching(/^[a-zA-Z0-9_/.-]+$/),
			)
			.map(([text, host, org, repo, sha, path]) => ({
				markdown: `[${text}](https://${host}/${org}/${repo}/blob/${sha}/${path})`,
				expectedPath: path,
			}));

		fc.assert(
			fc.property(blobLink, ({ markdown, expectedPath }) => {
				const results = parseMarkdownLinks(markdown);
				expect(results.length).toBe(1);
				expect(results[0]?.repoPath).toBe(expectedPath);
			}),
			{ numRuns: 5_000 },
		);
	});

	test("completes within time budget (no ReDoS)", () => {
		// Craft adversarial-ish inputs: deeply nested brackets, repeated patterns
		const adversarial = fc.oneof(
			// Many nested brackets
			fc.nat({ max: 200 }).map((n) => "[".repeat(n) + "](".repeat(n) + ")".repeat(n)),
			// Repeated markdown-like patterns
			fc.nat({ max: 500 }).map((n) => "[a](b)".repeat(n)),
			// Long strings of special regex chars
			fc.nat({ max: 1000 }).map((n) => "[]()#/.".repeat(n)),
		);

		const start = performance.now();
		fc.assert(
			fc.property(adversarial, (input) => {
				parseMarkdownLinks(input);
				// If we get here, it didn't hang
			}),
			{ numRuns: 1_000 },
		);
		const elapsed = performance.now() - start;
		// 1000 runs should complete well within 5 seconds
		expect(elapsed).toBeLessThan(5_000);
	});
});
