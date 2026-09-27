import { AsyncLocalStorage } from "node:async_hooks";

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean }>;
}

export interface D1DatabaseBinding {
  prepare(query: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
}

export interface EzioCloudWorkerBindings {
  DB?: D1DatabaseBinding;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  [key: string]: unknown;
}

const requestBindings = new AsyncLocalStorage<EzioCloudWorkerBindings>();

export function runWithWorkerBindings<T>(
  bindings: EzioCloudWorkerBindings,
  task: () => T,
): T {
  return requestBindings.run(bindings, task);
}

export function getWorkerBindings(): EzioCloudWorkerBindings | undefined {
  return requestBindings.getStore();
}

export function getRuntimeEnv(name: string): string | undefined {
  const bindingValue = requestBindings.getStore()?.[name];
  if (typeof bindingValue === "string") return bindingValue;
  return process.env[name];
}
