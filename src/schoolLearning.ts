// Runs school discovery once per school (even if two students from it arrive at once) and tells the owner,
// in their next brief, what Beast learned.
import { discoverSchool, getSchool, needsDiscovery } from "./schoolDiscovery.js";
import * as global from "./globalStore.js";
import * as store from "./store.js";
import { withUser } from "./userContext.js";

const inFlight = new Map<string, Promise<void>>();

export function learnSchool(school: string | null, hints: { canvasHost?: string | null } = {}): Promise<void> {
  if (!school || !needsDiscovery(school)) return Promise.resolve();
  let p = inFlight.get(school);
  if (!p) {
    p = (async () => {
      const isNew = !getSchool(school);
      const profile = await discoverSchool(school, hints);
      const owner = global.owner();
      if (!owner || !isNew) return;
      const note = profile
        ? `learned a new school: ${profile.name} (${profile.termSystem}, canvas ${profile.canvasHost ?? "unknown"}, schedule lookup ${profile.scheduleOfClasses ? "works" : "not found, canvas only"})`
        : `couldnt learn a new school: ${school}. beast will run on canvas alone there`;
      withUser(owner.id, () => store.holdNotice(note));
    })().finally(() => inFlight.delete(school));
    inFlight.set(school, p);
  }
  return p;
}
