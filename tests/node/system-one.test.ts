import assert from "node:assert/strict";
import { test } from "node:test";
import { BetterWright } from "../../dist/src/index.js";
import {
  decideAction,
  extraCandidatesFromSnapshot,
  fallbackTargets,
  fingerprintCandidate,
  interpretDecision,
  observedLooksLikeLogin,
  parseObserved,
  runFollowIntent,
  systemOneApiKey,
  systemOneMissingKeyError,
} from "../../dist/src/system-one.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function candidate(partial) {
  return {
    id: "opt_00",
    target: { role: "button", name: "Download", exact: true },
    actions: ["click"],
    role: "button",
    name: "Download",
    context: "",
    frame: "",
    disabled: false,
    value: "",
    options: [],
    dialog: false,
    ...partial,
  };
}

function answers(partial) {
  return {
    page_state: { type: "choice", choice: "listing", confidence: 1, probabilities: { listing: 1 } },
    target: {
      type: "choice",
      choice: "opt_00",
      confidence: 0.9,
      probabilities: { opt_00: 0.9, none: 0.1 },
    },
    dropdown_option: { type: "choice", choice: "not_applicable", confidence: 1, probabilities: { not_applicable: 1 } },
    item_present: { type: "noul", noul: 0.1 },
    ...partial,
  };
}

test("systemOneApiKey prefers the BetterWright-prefixed name", () => {
  assert.equal(systemOneApiKey({ TYPESAFE_API_KEY: "a", BETTERWRIGHT_TYPESAFE_API_KEY: "b" }), "b");
  assert.equal(systemOneApiKey({ TYPESAFE_API_KEY: "a" }), "a");
  assert.equal(systemOneApiKey({}), "");
});

test("fallbackTargets retries Next without a trailing arrow", () => {
  const targets = fallbackTargets({ role: "link", name: "Next →", exact: true });
  assert.deepEqual(targets[0], { role: "link", name: "Next →", exact: true });
  assert.ok(targets.some((target) => target.name === "Next" && target.exact === true));
  assert.ok(targets.some((target) => target.name === "Next" && target.exact === false));
});

test("fallbackTargets also tries the name before a parenthetical", () => {
  const targets = fallbackTargets({ role: "link", name: "C (programming language)", exact: true });
  assert.ok(targets.some((target) => target.name === "C" && target.exact === true));
});

test("snapshot extras prefer aria refs", () => {
  const extras = extraCandidatesFromSnapshot('- link "Mercury (planet)" [ref=e12]\n- button "Save" [ref=e9]', 2);
  assert.equal(extras[0].id, "opt_02");
  assert.deepEqual(extras[0].target, { ref: "e12" });
  assert.equal(extras[0].name, "Mercury (planet)");
});

test("directory candidates keep dialog and frame metadata", () => {
  const observed = parseObserved({
    url: "http://127.0.0.1/billing",
    title: "Settings",
    oracle: "Idle",
    snapshotText: "",
    dialogs: [],
    directory: {
      protocol: "betterwright-ui/1",
      truncated: false,
      evidence: [],
      controls: [
        { target: { role: "button", name: "Save", exact: true, frameName: "billing" }, actions: ["click"], dialog: false },
        { target: { role: "button", name: "Sign in", exact: true }, actions: ["click"], dialog: true },
      ],
    },
  });
  assert.equal(observed.candidates[0].frame, "billing");
  assert.equal(observed.candidates[1].dialog, true);
  assert.equal(observed.candidates[1].name, "Sign in");
});

test("open sign-in dialogs count as a login wall", () => {
  assert.equal(observedLooksLikeLogin(parseObserved({
    url: "/", title: "", oracle: "", snapshotText: "", directory: { controls: [] },
    dialogs: [{ role: "dialog", text: "Sign in to continue" }],
  })), true);
  assert.equal(observedLooksLikeLogin(parseObserved({
    url: "/", title: "", oracle: "", snapshotText: "", directory: { controls: [] },
    dialogs: [{ role: "dialog", text: "Reject all cookies" }],
  })), false);
});

test("pagination may continue below the confidence floor when the item is missing", () => {
  const next = candidate({ id: "opt_03", name: "Next", role: "link", target: { role: "link", name: "Next", exact: true }, actions: ["click"] });
  const decision = interpretDecision(answers({
    target: { type: "choice", choice: "opt_03", confidence: 0.38, probabilities: { opt_03: 0.51, none: 0.47 } },
    item_present: { type: "noul", noul: 0.17 },
  }), [next]);
  const choice = decideAction(decision, {
    url: "/invoices?page=2", title: "Invoices", oracle: "", evidence: [], snapshotText: "", dialogs: [], candidates: [next], truncated: false,
  }, { intent: "Download the August invoice" }, []);
  assert.equal(choice.action, "click");
});

test("the same control on the same URL is a loop, not a success", () => {
  const download = candidate({ context: "INV-1007" });
  const decision = interpretDecision(answers({
    item_present: { type: "noul", noul: 0.9 },
  }), [download]);
  const choice = decideAction(decision, {
    url: "/invoices", title: "", oracle: "No download yet", evidence: [], snapshotText: "", dialogs: [], candidates: [download], truncated: false,
  }, { intent: "Download INV-1007" }, [{ fingerprint: fingerprintCandidate(download), url: "/invoices" }]);
  assert.equal(choice.action, "abstain");
  assert.equal(choice.reason, "loop");
});

test("sign-in targets are blocked unless authentication is allowed", () => {
  const signin = candidate({ id: "opt_01", name: "Sign in", dialog: true });
  const decision = interpretDecision(answers({
    target: { type: "choice", choice: "opt_01", confidence: 0.99, probabilities: { opt_01: 0.99 } },
  }), [signin]);
  const choice = decideAction(decision, {
    url: "/payroll", title: "", oracle: "", evidence: [], snapshotText: "", dialogs: [], candidates: [signin], truncated: false,
  }, { intent: "Export payroll" }, []);
  assert.equal(choice.reason, "login");
});

test("destructive targets are blocked unless the intent names them", () => {
  const remove = candidate({ name: "Delete account" });
  const decision = interpretDecision(answers({}), [remove]);
  const blocked = decideAction(decision, {
    url: "/", title: "", oracle: "", evidence: [], snapshotText: "", dialogs: [], candidates: [remove], truncated: false,
  }, { intent: "Cancel the subscription" }, []);
  assert.equal(blocked.reason, "blocked");
  const allowed = decideAction(decision, {
    url: "/", title: "", oracle: "", evidence: [], snapshotText: "", dialogs: [], candidates: [remove], truncated: false,
  }, { intent: "Delete account for this user" }, []);
  assert.equal(allowed.action, "click");
});

test("runFollowIntent stops when expect is already visible", async () => {
  let asks = 0;
  const result = await runFollowIntent({
    observe: async () => ({ url: "/done", title: "Done", oracle: "Order submitted", directory: { controls: [] }, snapshotText: "", dialogs: [] }),
    act: async () => ({ ok: true }),
    ask: async () => {
      asks += 1;
      return { answers: answers({}) };
    },
    wait: async () => {},
  }, { intent: "Submit the order", expect: "Order submitted" });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "completed");
  assert.equal(asks, 0);
  assert.equal(result.steps.length, 0);
});

test("runFollowIntent stops on a login dialog after the first action", async () => {
  let observes = 0;
  const result = await runFollowIntent({
    observe: async () => {
      observes += 1;
      if (observes === 1) {
        return {
          url: "/payroll", title: "Payroll", oracle: "Idle", dialogs: [],
          directory: { controls: [{ target: { role: "button", name: "Export payroll CSV", exact: true }, actions: ["click"] }] },
        };
      }
      return {
        url: "/payroll", title: "Payroll", oracle: "Idle",
        dialogs: [{ role: "dialog", text: "Sign in to continue" }],
        directory: { controls: [
          { target: { role: "button", name: "Export payroll CSV", exact: true }, actions: ["click"] },
          { target: { role: "button", name: "Sign in", exact: true }, actions: ["click"], dialog: true },
        ] },
      };
    },
    act: async () => ({ ok: true }),
    ask: async () => ({ answers: answers({}) }),
    wait: async () => {},
  }, { intent: "Export the payroll CSV if it can be done without authenticating." });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "login");
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].action, "click");
  assert.equal(result.steps[1].reason, "login");
});

test("runFollowIntent does not click the same target twice", async () => {
  const result = await runFollowIntent({
    observe: async () => ({
      url: "/shop", title: "Shop", oracle: "Cart TRP-BLUE-10", dialogs: [],
      directory: { controls: [{ target: { role: "button", name: "Add to cart", exact: true }, actions: ["click"], context: "Trail Runner Pro Blue · size 10" }] },
    }),
    act: async () => ({ ok: true }),
    ask: async () => ({ answers: answers({ item_present: { type: "noul", noul: 0.8 } }) }),
    wait: async () => {},
  }, { intent: "Add the blue size 10 Trail Runner Pro", maxSteps: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "loop");
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].action, "click");
  assert.equal(result.steps[1].action, "abstain");
});

test("followIntent without a key does not start the worker", async () => {
  const previous = {
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
    BETTERWRIGHT_TYPESAFE_API_KEY: process.env.BETTERWRIGHT_TYPESAFE_API_KEY,
  };
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.BETTERWRIGHT_TYPESAFE_API_KEY;
  const bw = new BetterWright({ home: makeTempDir("betterwright-system-one-") });
  try {
    const result = await bw.followIntent({ intent: "Click save" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unresolved");
    assert.equal(result.error, systemOneMissingKeyError());
  } finally {
    await bw.close();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
