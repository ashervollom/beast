// The user whose data the current code path is working with (see userContext.ts).
import { getUser, type User } from "./globalStore.js";
import { currentUserId } from "./userContext.js";

export function currentUser(): User {
  const user = getUser(currentUserId());
  if (!user) throw new Error("current user no longer exists");
  return user;
}
