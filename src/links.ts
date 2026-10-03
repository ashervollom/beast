// Public links Beast texts: dashboards, invites, connect pages, calendar feeds.
import { config } from "./config.js";
import type { User } from "./globalStore.js";
import { getDashboardUrl } from "./tunnel.js";

/** The public base URL: WEB_URL in the cloud, otherwise the tunnel. Null while neither is up. */
export function publicBase(): string | null {
  return config.webUrl || getDashboardUrl();
}

const at = (p: string) => {
  const base = publicBase();
  return base ? `${base}${p}` : null;
};

export const dashboardUrl = (u: User) => at(`/dashboard/${u.dashboardSlug}`);
export const calendarUrl = (u: User) => at(`/cal/${u.calendarSlug}.ics`);
export const inviteUrl = (code: string) => at(`/join/${code}`);
export const connectUrl = (token: string) => at(`/connect/${token}`);

/** Private link paths that must never be posted in a group chat (old /v/ links included). */
export const PRIVATE_LINK = /(?:https?|webcal):\/\/\S+\/(?:dashboard|v|cal|connect)\/\S+/gi;
