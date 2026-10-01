// Which user's data the current code path may touch. Every webhook, poller, cron and API path runs
// inside withUser(); reading user data without one throws instead of silently picking someone.
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage<string>();

export function withUser<R>(userId: string, fn: () => R): R {
  return als.run(userId, fn);
}

export function currentUserId(): string {
  const id = als.getStore();
  if (!id) throw new Error("user data accessed without a user context (wrap the call in withUser)");
  return id;
}

export function hasUserContext(): boolean {
  return als.getStore() !== undefined;
}
