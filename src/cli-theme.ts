// The CLI's one theme: BetterWright orange on a quiet terminal.
//
// Color is applied at the output sink, never inside the strings a function
// builds or returns. Tests inject their own `log` and assert on plain text;
// `--json` pipes into parsers; NO_COLOR and non-TTY streams must see exactly
// the bytes they always did. Painting at the last moment keeps all of that
// true with one rule instead of a hundred call-site decisions.
//
// The palette is deliberately small. Orange is the brand: the wordmark,
// success marks, command names, and prompt markers. Red and yellow keep their
// universal meanings (failure, attention) so a problem never has to compete
// with the theme for the reader's eye.

// Truecolor BetterWright orange, with the closest xterm-256 fallback.
const ORANGE_TRUECOLOR = "38;2;255;135;35";
const ORANGE_256 = "38;5;208";

function colorEnabled(stream, env) {
  if (String(env.FORCE_COLOR ?? "") === "0") return false;
  if (env.FORCE_COLOR) return true;
  if (env.NO_COLOR) return false;
  if (env.TERM === "dumb") return false;
  return Boolean(stream?.isTTY);
}

function truecolorEnabled(env) {
  return /truecolor|24bit/i.test(String(env.COLORTERM ?? ""));
}

/** Everything a command needs to paint output. All identity when `on` is false. */
export interface CliPaint {
  on: boolean;
  accent: (text: string) => string;
  accentBold: (text: string) => string;
  heading: (text: string) => string;
  bold: (text: string) => string;
  dim: (text: string) => string;
  red: (text: string) => string;
  yellow: (text: string) => string;
  /** Paint one already-built output line: status glyphs, `commands`, menu numbers. */
  status: (line: string) => string;
  /** Paint a block of help text: wordmark, headings, flags, command names. */
  help: (text: string) => string;
}

const IDENTITY = (text) => String(text);

// One leading glyph per line, colored by what it means. `·` and the fix arrow
// stay dim: they are narration, not results.
const GLYPH_STYLES = [
  { pattern: /^(\s*)(✓)( |$)/, color: "accent" },
  { pattern: /^(\s*)(✗)( |$)/, color: "red" },
  { pattern: /^(\s*)(!)( |$)/, color: "yellow" },
  { pattern: /^(\s*)([·▸▶?])( |$)/, color: "accent" },
  { pattern: /^(\s*)(→)( |$)/, color: "dim" },
] as const;

function paintStatusLine(line, paint) {
  let painted = String(line);
  for (const { pattern, color } of GLYPH_STYLES) {
    const match = painted.match(pattern);
    if (!match) continue;
    painted = `${match[1]}${paint[color](match[2])}${painted.slice(match[1].length + match[2].length)}`;
    break;
  }
  // Interactive menu rows: "   3) Steel (steel)".
  painted = painted.replace(/^(\s+)(\d+\))( )/, (_, lead, number, gap) => `${lead}${paint.accent(number)}${gap}`);
  // `betterwright doctor` and friends, quoted mid-sentence.
  painted = painted.replace(/`([^`]+)`/g, (_, command) => `\`${paint.accent(command)}\``);
  return painted;
}

function paintHelpLine(line, paint) {
  // The wordmark line at the top of the main usage text.
  if (/^betterwright — /.test(line)) {
    return `${paint.accentBold("betterwright")}${paint.dim(line.slice("betterwright".length))}`;
  }
  if (/^(Usage|Shell note):/.test(line)) {
    const label = line.slice(0, line.indexOf(":") + 1);
    return `${paint.dim(label)}${line.slice(label.length)}`;
  }
  // Bare section headings: "Commands:", "Options:", "Categories: …".
  if (/^[A-Z][A-Za-z ]*:/.test(line)) {
    const label = line.slice(0, line.indexOf(":") + 1);
    return `${paint.bold(label)}${paintStatusLine(line.slice(label.length), paint)}`;
  }
  // Flag rows: "  --browser <value>      set the default…".
  const flagRow = line.match(/^(\s+)(--[\w-]+(?:, --[\w-]+)*)/);
  if (flagRow) {
    return `${flagRow[1]}${paint.accent(flagRow[2])}${paintStatusLine(line.slice(flagRow[1].length + flagRow[2].length), paint)}`;
  }
  // Command rows: "  configure  choose the browser backend…" (two-space
  // indent, a short lowercase name, at least two spaces of padding after).
  const commandRow = line.match(/^( {2})([a-z][a-z-]{1,14})( {2,})/);
  if (commandRow) {
    return `${commandRow[1]}${paint.accent(commandRow[2])}${line.slice(commandRow[1].length + commandRow[2].length)}`;
  }
  return paintStatusLine(line, paint);
}

/**
 * The paint set for one stream. Colors turn on only for a TTY without
 * NO_COLOR (FORCE_COLOR overrides both ways), so piped, redirected, and
 * test-captured output is always plain text.
 */
export function cliPaint({ stream = process.stdout, env = process.env }: any = {}): CliPaint {
  if (!colorEnabled(stream, env)) {
    return {
      on: false,
      accent: IDENTITY,
      accentBold: IDENTITY,
      heading: IDENTITY,
      bold: IDENTITY,
      dim: IDENTITY,
      red: IDENTITY,
      yellow: IDENTITY,
      status: IDENTITY,
      help: IDENTITY,
    };
  }
  const orange = truecolorEnabled(env) ? ORANGE_TRUECOLOR : ORANGE_256;
  const wrap = (code) => (text) => `\x1b[${code}m${text}\x1b[0m`;
  const paint: CliPaint = {
    on: true,
    accent: wrap(orange),
    accentBold: wrap(`1;${orange}`),
    heading: wrap(`1;${orange}`),
    bold: wrap("1"),
    dim: wrap("2"),
    red: wrap("31"),
    yellow: wrap("33"),
    status: (line) => paintStatusLine(line, paint),
    help: (text) =>
      String(text)
        .split("\n")
        .map((line) => paintHelpLine(line, paint))
        .join("\n"),
  };
  return paint;
}

/** A console.log that paints status glyphs, for commands' default sinks. */
export function paintedLog(paint: CliPaint) {
  return (line = "") => console.log(paint.status(line));
}

/** The stderr twin: glyphs and quoting painted, nothing else. */
export function paintedError(paint: CliPaint) {
  return (line = "") => console.error(paint.status(line));
}
