// Registration shim for the stealth module-resolution hook. Passed to the
// worker's Node process as `--import` so the resolve hook in `stealth-hooks.mjs`
// is installed before any `playwright-core` import runs (including the one
// inside the cloakbrowser wrapper). Node requires the hook itself to live in a
// separate module because customization hooks run on their own thread.
//
// Only loaded when Runtime.enable stealth is explicitly enabled; a normal run
// never spawns the worker with this import, so the default driver is untouched.
import { register } from "node:module";

register("./stealth-hooks.mjs", import.meta.url);
