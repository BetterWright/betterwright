// Registration shim for the stealth module-resolution hook. Passed to the
// worker's Node process as `--import` so the emitted `stealth-hooks.js`
// is installed before any `playwright-core` import runs. Node requires the
// hook itself to live in a separate module because customization hooks run on
// their own thread.
//
// Only loaded when Runtime.enable stealth is explicitly enabled; a normal run
// never spawns the worker with this import, so the default driver is untouched.
import { register } from "node:module";

register("./stealth-hooks.js", import.meta.url);
