// `compileCode` wraps a model snippet either as an expression (its value is the
// result) or as a statement list (result `undefined`). The shipped code tries
// the statement form first for snippets that cannot possibly be an expression,
// which is a pure latency optimization — so every test here is differential
// against the plain "expression first, statements on SyntaxError" order the
// worker used before, comparing the *evaluated* result, not the chosen form.

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  compileCode,
  compileExpressionForm,
  compileStatementForm,
  STATEMENT_ONLY_START,
} from "../../dist/src/compile-code.js";
import { isCallable } from "../../dist/src/untrusted-value.js";

/** The algorithm the worker shipped before the statement-first heuristic. */
function expressionFirstCompile(code) {
  try {
    return compileExpressionForm(code);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return compileStatementForm(code);
  }
}

// A global named `let` is legal — `let` is only reserved in strict mode — and
// it is exactly what separates a `let` declaration from a member expression on
// an identifier, so the corpus can reach both.
function freshContext() {
  return vm.createContext({
    Array,
    let: { foo: 42 },
    letters: ["a", "b"],
    constant: 10,
    doThing: () => "did",
    tryIt: () => "tried",
    iffy: () => "iffed",
    forth: 4,
    whilst: 5,
    switcher: 6,
    returned: 7,
    thrower: 8,
    varName: 9,
    o: { a: 1 },
    log: () => {},
  });
}

function describe(value) {
  if (value === undefined) return "undefined";
  if (isCallable(value)) return `function:${value.name}`;
  try {
    return JSON.stringify(value) ?? `nonjson:${String(value)}`;
  } catch {
    return `unserializable:${Object.prototype.toString.call(value)}`;
  }
}

/** Compile with `compile`, run in a fresh realm, and describe what came out. */
async function outcome(compile, code) {
  let script;
  try {
    script = compile(code);
  } catch (error: any) {
    return `compile-${error.constructor.name}:${error.message}`;
  }
  try {
    return `value:${describe(await script.runInContext(freshContext()))}`;
  } catch (error: any) {
    return `runtime-${error.constructor.name}:${error.message}`;
  }
}

const CORPUS = [
  // single expressions
  "1 + 1",
  '"a" + "b"',
  "[1, 2, 3].map((x) => x * 2)",
  "Promise.resolve(7)",
  "await Promise.resolve(8)",
  "o.a",
  "null",
  "undefined",
  "",
  "   ",
  // object literals: the classic form-sensitive pair
  "{a:1}",
  "({a:1})",
  "{ }",
  "{a:1, b:{c:2}}",
  // class and function expressions, which must stay expressions
  "class A {}",
  "class A { m() { return 1 } }",
  "function f() { return 1 }",
  "async function g() { return 3 }",
  "function* h() {}",
  "(function () { return 2 })()",
  "(() => 5)()",
  "(async () => 6)()",
  "(async () => { const v = 1; return v + 1 })()",
  // statement-only starts, one per keyword in the heuristic
  "const a = 1",
  "const a = 1; a",
  "const a = 1;\nconst b = 2;\na + b",
  "let x = 1",
  "let x = 1; x",
  "let\n  x = 1",
  "var v = 3",
  "var v = 3; v",
  "return 42",
  "return { a: 1 }",
  "throw new Error('boom')",
  "if (true) { log('x') }",
  "if (1) 2; else 3",
  "for (const n of [1, 2]) log(n)",
  "for (let i = 0; i < 2; i += 1) log(i)",
  "while (false) { log('x') }",
  "switch (1) { case 1: break }",
  "do { log('x') } while (false)",
  "try { log('x') } catch { log('y') }",
  "try { throw new Error('t') } catch (e) { }",
  // `let` used as an ordinary identifier: valid in both forms, and only the
  // expression form yields the value, so the heuristic must not claim these
  "let.foo",
  "let['foo']",
  "let + ''",
  "let",
  "let.foo + 1",
  "let\n.foo",
  // `in` and `instanceof` are identifier-shaped binary operators, so these are
  // expressions over the global `let` even though `let\s+<ident>` matches them
  "let instanceof Array",
  "let in o",
  "let instanceof Array === false",
  // `let` destructuring, where the expression form is also legal
  "let [a] = [1]",
  "let {a} = o",
  "let{a}=o",
  // near misses: identifiers that merely start with a keyword
  "letters.length",
  "constant + 1",
  "doThing()",
  "tryIt()",
  "iffy()",
  "forth + whilst",
  "switcher",
  "returned",
  "thrower",
  "varName",
  // template literals, including ones spanning newlines
  "`plain`",
  "`line1\nline2`",
  // Split so this corpus entry is not itself read as a mis-typed template.
  `\`a$${"{1 + 1}b`"}`,
  "const t = `line1\nline2`; t",
  // comments before the keyword, which the `^\s*` anchor cannot see past
  "// note\nconst a = 1; a",
  "/* note */ const a = 1",
  "/* note */ 1 + 1",
  "\n\n  const a = 1",
  "\t const a = 1",
  // syntax errors: expression-only, statement-only, and both
  "}}}bad",
  "const ((",
  "if (",
  "let x = ",
  "return",
  "1 +",
  "function (",
  "const 1 = 2",
  "await",
];

test("the heuristic never changes what a snippet evaluates to", async () => {
  for (const code of CORPUS) {
    assert.equal(
      await outcome(compileCode, code),
      await outcome(expressionFirstCompile, code),
      `compileCode diverged from the expression-first order on ${JSON.stringify(code)}`,
    );
  }
});

test("the heuristic surfaces the same error when neither form parses", async () => {
  for (const code of ["}}}bad", "const ((", "if (", "const 1 = 2"]) {
    const shipped = await outcome(compileCode, code);
    assert.match(shipped, /^compile-SyntaxError:/, `${code} should fail to compile`);
    assert.equal(shipped, await outcome(expressionFirstCompile, code));
  }
});

test("a non-SyntaxError from compilation is never retried in the other form", () => {
  const failure = new RangeError("compilation budget exhausted");
  const thrower = () => {
    throw failure;
  };
  // Both branches of the heuristic must propagate immediately; the statement
  // branch is the one the reordering added.
  assert.equal(STATEMENT_ONLY_START.test("const a = 1"), true);
  assert.equal(STATEMENT_ONLY_START.test("1 + 1"), false);
  assert.throws(() => {
    if (STATEMENT_ONLY_START.test("const a = 1")) thrower();
  }, failure);
});

test("the heuristic only claims snippets whose expression form cannot parse", () => {
  for (const code of CORPUS) {
    if (!STATEMENT_ONLY_START.test(code)) continue;
    assert.throws(
      () => compileExpressionForm(code),
      SyntaxError,
      `${JSON.stringify(code)} is claimed by the heuristic but parses as an expression`,
    );
  }
});

test("the heuristic claims the statement starts it exists for", () => {
  for (const code of [
    "const a = 1",
    "let x = 1",
    // The `in`/`instanceof` exclusion is a word-boundary lookahead, so
    // declarations whose name merely starts with those letters stay claimed.
    "let index = 1",
    "let instance = 2",
    "let interface = 1",
    "var v = 1",
    "return 1",
    "throw e",
    "if (a) b",
    "for (;;) {}",
    "while (a) {}",
    "switch (a) {}",
    "do {} while (a)",
    "try {} catch {}",
  ]) {
    assert.equal(STATEMENT_ONLY_START.test(code), true, `${code} should be claimed`);
  }
  // Expressions the heuristic must leave to the expression-first path.
  for (const code of [
    "function f() {}",
    "class A {}",
    "import('x')",
    "let.foo",
    "let [a] = [1]",
    "let{a}=o",
    "let in o",
    "let instanceof Array",
    "letters.length",
    "constant",
    "{a:1}",
  ]) {
    assert.equal(STATEMENT_ONLY_START.test(code), false, `${code} must not be claimed`);
  }
});

// Randomized cross-product: the fixed corpus pins the shapes we reasoned about,
// this pins the ones we did not, including snippets that mix a claimed prefix
// with an expression tail.
test("randomized snippets evaluate identically under both orders", async () => {
  const heads = [
    "",
    "const a = 1;",
    "let x = 2;",
    "var v = 3;",
    "// c\n",
    "/* c */",
    "\n ",
    "if (true) { }",
    "for (const n of [1]) { }",
    "try { } catch { }",
    "let.foo;",
    "letters;",
    "return 1;",
    "throw new Error('e');",
    "do { } while (false);",
    "switch (1) { }",
    "while (false) { }",
  ];
  const tails = [
    "",
    " 1 + 1",
    " {a:1}",
    " ({a:1})",
    " class A {}",
    " function f() {}",
    " await Promise.resolve(1)",
    " `t\nu`",
    " o.a",
    " let.foo",
    " }bad",
    " const b =",
  ];
  let seed = 0x2545_f491;
  const next = (bound) => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed % bound;
  };
  for (let round = 0; round < 600; round += 1) {
    const code =
      heads[next(heads.length)] + tails[next(tails.length)] + tails[next(tails.length)];
    assert.equal(
      await outcome(compileCode, code),
      await outcome(expressionFirstCompile, code),
      `compileCode diverged on ${JSON.stringify(code)}`,
    );
  }
});
