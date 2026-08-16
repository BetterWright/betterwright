// Mirrors src/untrusted-value.ts: the named contract for values that crossed
// a trust boundary (page-derived data, model-authored tool arguments,
// persisted JSON, dynamic protocol payloads).

/**
 * A value that crossed a trust boundary. Structurally it admits every
 * JavaScript value — hostile input has no structure to assume — but unlike a
 * bare `unknown` it names the contract: narrow it before relying on any
 * shape. (`NonNullable<unknown>` is `{}`, the one non-nullish type `unknown`
 * assigns to without a cast.)
 */
export type UntrustedValue = NonNullable<unknown> | null | undefined;

/**
 * An untrusted value known to be callable. Parameters are `never` so nothing
 * can be passed to it without the caller first establishing a real signature;
 * its result is as untrusted as the function was.
 */
export type UntrustedFunction = (...args: never[]) => UntrustedValue;
