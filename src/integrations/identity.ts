import { AsyncLocalStorage } from "node:async_hooks";

export type RequestIdentity = {
  userId: string;
};

const identities = new AsyncLocalStorage<RequestIdentity>();

export function runWithRequestIdentity<T>(identity: RequestIdentity | undefined, callback: () => T): T {
  return identity ? identities.run(identity, callback) : callback();
}

export function currentRequestIdentity(): RequestIdentity | undefined {
  return identities.getStore();
}
