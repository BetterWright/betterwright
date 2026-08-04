declare module "@swizec/loljs" {
  export function parse(source: string): any;
  export const lol: {
    builtIns: Record<string, (...args: any[]) => any>;
    utils: { nextTick?: (callback: () => void) => void };
    new (done?: (value: unknown) => void, paused?: () => void): {
      errors(): unknown[];
      pos(): { line: number; col: number };
      setIo(io: { visible?: (...values: unknown[]) => void; prompt?: (message: string, done: (value: string) => void) => void }): void;
      evaluate(ast: any): void;
    };
  };
}
