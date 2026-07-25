export {};

declare global {
  interface Error {
    code?: string | number;
    pendingCredential?: any;
  }
}
