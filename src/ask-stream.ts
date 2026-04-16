/**
 * AskStream implementation — the return type of ask().
 *
 * Wraps an async generator of StreamEvent objects and provides a .result()
 * method that reduces them into a TurnResult. The stream starts lazily
 * when consumed (iterated or .result() awaited).
 */

import { TurnResultBuilder } from "./turn-result-builder";
import type { AskStream, StreamEvent, TurnResult } from "./types";

export class AskStreamImpl implements AskStream {
	#producer: () => AsyncGenerator<StreamEvent>;
	#onComplete?: (result: TurnResult) => void;
	#generator: AsyncGenerator<StreamEvent> | null = null;
	#resultPromise: Promise<TurnResult> | null = null;
	#builder = new TurnResultBuilder();
	#done = false;
	/** True once either the iterator or #resolveResult has started draining the generator. */
	#consuming = false;
	#doneResolve!: () => void;
	#donePromise: Promise<void>;

	constructor(producer: () => AsyncGenerator<StreamEvent>, onComplete?: (result: TurnResult) => void) {
		this.#producer = producer;
		this.#onComplete = onComplete;
		this.#donePromise = new Promise<void>((resolve) => {
			this.#doneResolve = resolve;
		});
	}

	#ensureStarted(): AsyncGenerator<StreamEvent> {
		if (!this.#generator) {
			this.#generator = this.#producer();
		}
		return this.#generator;
	}

	async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
		if (this.#consuming) {
			throw new Error("AskStream is already being consumed");
		}
		this.#consuming = true;
		const gen = this.#ensureStarted();

		for await (const event of gen) {
			this.#builder.process(event);
			yield event;
		}

		this.#markDone();
	}

	result(): Promise<TurnResult> {
		if (this.#resultPromise) return this.#resultPromise;

		this.#resultPromise = this.#resolveResult();
		return this.#resultPromise;
	}

	#markDone(): void {
		if (this.#done) return;
		this.#done = true;
		const result = this.#builder.build();
		this.#onComplete?.(result);
		this.#onComplete = undefined;
		this.#doneResolve();
	}

	async #resolveResult(): Promise<TurnResult> {
		if (this.#done) {
			return this.#builder.build();
		}

		// If iteration is already draining the generator, wait for it to finish
		// rather than racing to consume the same events.
		if (this.#consuming) {
			await this.#donePromise;
			return this.#builder.build();
		}

		// Nobody is iterating — drain the stream ourselves
		this.#consuming = true;
		const gen = this.#ensureStarted();
		for await (const event of gen) {
			this.#builder.process(event);
		}
		this.#markDone();

		return this.#builder.build();
	}
}
