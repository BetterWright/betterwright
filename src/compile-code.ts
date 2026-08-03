// Wrapping model code for the sandbox realm. A snippet is either an expression
// whose value is the result, or a statement list that returns nothing, and the
// only way to tell them apart is to try to parse each form.
//
// Contract this module has to keep, because callers see the difference:
//   - Whichever form the plain "expression first, statements on SyntaxError"
//     order would have compiled is the form that runs. Picking the other form
//     for a snippet both forms accept would silently swap a snippet's value for
//     `undefined`.
//   - When neither form parses, the statement-form SyntaxError is the one that
//     surfaces — that is the message callers have always been shown.
//   - A non-SyntaxError (a resource limit, say) propagates immediately instead
//     of being retried in the other form.
//
// The heuristic below only reorders the two attempts, so a miss costs the same
// double compile as before and never changes the outcome.

import vm from "node:vm";

/**
 * Leading tokens after which the expression wrapper is *guaranteed* to be a
 * parse error, so the statement form can be tried first.
 *
 * All the listed keywords are reserved words, which no expression may start
 * with. `let` is not reserved in sloppy mode — `let.x`, `let(1)`, `let + 1` and
 * `let [a] = o` are all valid expressions — so it qualifies only when followed
 * by an identifier start, the one shape where `(let foo …)` cannot parse.
 *
 * `in` and `instanceof` are the exception to that: they are the only binary
 * operators spelled as identifier-shaped words, so `let in o` and
 * `let instanceof X` parse as expressions over a global named `let` and must be
 * left to the expression-first path — claiming them would swap their value for
 * `undefined`.
 *
 * `function`, `class` and `import` are excluded on purpose: they are valid
 * expressions whose completion value callers read.
 */
export const STATEMENT_ONLY_START =
  /^\s*(?:(?:const|var|return|throw|if|for|while|switch|do|try)\b|let\s+(?!(?:in|instanceof)\b)[$_\p{ID_Start}])/u;

export function compileExpressionForm(code) {
  return new vm.Script(`(async () => (${code}\n))()`, {
    filename: "browser-playwright-expression.js",
  });
}

export function compileStatementForm(code) {
  return new vm.Script(`(async () => {\n${code}\n})()`, {
    filename: "browser-playwright-statements.js",
  });
}

/** Compile a model snippet into the async wrapper the realm runs. */
export function compileCode(code) {
  if (STATEMENT_ONLY_START.test(code)) {
    let statementError;
    try {
      return compileStatementForm(code);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      statementError = error;
    }
    try {
      return compileExpressionForm(code);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw statementError;
    }
  }
  try {
    return compileExpressionForm(code);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return compileStatementForm(code);
  }
}
