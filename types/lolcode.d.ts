export interface LolcodeIo {
  visible?: (text: string) => void;
  prompt?: (message: string) => Promise<string>;
}

export interface LolcodeOptions {
  argv?: string[];
  cliEntry?: string;
  cwd?: string;
  io?: LolcodeIo;
  host?: Record<string, (...args: unknown[]) => unknown>;
}

export function runLolcode(source: string, options?: LolcodeOptions): Promise<unknown>;
export function runLolcodeModule(name: string, options?: LolcodeOptions): Promise<unknown>;
export function runLolcodeCli(argv?: string[], options?: LolcodeOptions): Promise<number>;
