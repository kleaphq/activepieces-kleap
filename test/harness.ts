/* Minimal fake Activepieces execution context: enough for actions (run), polling triggers
 * (onEnable / run / test) and dropdown option loaders, without an Activepieces server. */
import { kleap } from '../src/index';

export const piece = kleap;

export function memoryStore() {
  const data = new Map<string, unknown>();
  return {
    data,
    async put<T>(key: string, value: T) {
      // The real store is JSON-backed: round-trip to catch non-serialisable values.
      data.set(key, JSON.parse(JSON.stringify(value)));
      return value;
    },
    async get<T>(key: string) {
      return (data.has(key) ? data.get(key) : null) as T | null;
    },
    async delete(key: string) {
      data.delete(key);
    },
  };
}

export function makeContext(apiKey: string, propsValue: Record<string, unknown>, store = memoryStore()) {
  return {
    auth: { type: 'SECRET_TEXT', secret_text: apiKey },
    propsValue,
    store,
    files: {
      async write({ fileName }: { fileName: string; data: Buffer }) {
        return `memory://${fileName}`;
      },
    },
    server: { apiUrl: 'http://localhost:3000/api/', publicUrl: 'http://localhost:4200/', token: 'test' },
    flows: { current: { id: 'flow_test', version: { id: 'flowv_test' } } },
    run: { id: 'run_test' },
    step: { name: 'step_1' },
    project: { id: 'project_test', externalId: async () => undefined },
    connections: { get: async () => null },
    tags: { add: async () => undefined },
    executionType: 'BEGIN',
    setSchedule: () => undefined,
    output: { update: async () => undefined },
  };
}

type AnyFn = (ctx: unknown) => Promise<unknown>;

export async function runAction(name: string, apiKey: string, propsValue: Record<string, unknown>) {
  const action = piece.getAction(name);
  if (!action) throw new Error(`No action ${name}`);
  return (action.run as unknown as AnyFn)(makeContext(apiKey, propsValue)) as Promise<any>;
}

export function trigger(name: string) {
  const t = piece.getTrigger(name);
  if (!t) throw new Error(`No trigger ${name}`);
  return t as unknown as { onEnable: AnyFn; onDisable: AnyFn; run: AnyFn; test: AnyFn };
}

/** Calls a Dropdown's option loader the way the builder does. */
export async function dropdownOptions(
  actionName: string,
  propName: string,
  apiKey: string | undefined,
  input: Record<string, unknown> = {},
  searchValue?: string,
) {
  const action = piece.getAction(actionName) ?? piece.getTrigger(actionName);
  const prop = (action as any).props[propName];
  const auth = apiKey ? { type: 'SECRET_TEXT', secret_text: apiKey } : undefined;
  return prop.options({ ...input, auth }, { searchValue, server: {}, project: { id: 'p' }, flows: {} });
}

export async function validateAuth(apiKey: string) {
  const auth = piece.auth as unknown as { validate: (p: { auth: string; server: unknown }) => Promise<any> };
  return auth.validate({ auth: apiKey, server: { apiUrl: '', publicUrl: '' } });
}
