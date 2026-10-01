// Contacts on the free Linq Shared Line. Texts only reach Beast from numbers on this list (max 20), so a
// number has to be added before its owner can text Beast. Uses the same backend calls as `linq contacts`.
import { config } from "./config.js";

const BACKEND = process.env.LINQ_BACKEND_URL || "https://prod.zero-service.linqapp.com";
export const CONTACT_LIMIT = Number(process.env.LINQ_CONTACT_LIMIT ?? 20);

/** "(310) 555-1234", "3105551234", "+1 310 555 1234" -> "+13105551234"; null if it isn't a US number. */
export function toE164(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

async function call(path: string, init: RequestInit = {}): Promise<any> {
  if (!config.linq.apiKey || !config.linq.orgId) throw new Error("LINQ_API_KEY and LINQ_ORG_ID are needed to manage contacts");
  const res = await fetch(`${BACKEND}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${config.linq.apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Linq contacts ${path.split("?")[0]} -> ${res.status}`);
  return res.json();
}

export async function listContacts(): Promise<string[]> {
  if (config.linq.dryRun) return [];
  const data = await call(`/cli/contacts?orgId=${encodeURIComponent(config.linq.orgId)}`);
  return (data.contacts ?? []).map((c: { contactPhone?: string; phone?: string }) => c.contactPhone ?? c.phone ?? "").filter(Boolean);
}

export type AddResult = "added" | "already" | "full";

/** Adds a number so its owner can text Beast. Checks the cap first. */
export async function ensureContact(e164: string): Promise<AddResult> {
  if (config.linq.dryRun) {
    console.log(`[dry-run] would add Linq contact …${e164.slice(-4)}`);
    return "added";
  }
  const contacts = await listContacts();
  if (contacts.includes(e164)) return "already";
  if (contacts.length >= CONTACT_LIMIT) return "full";
  await call("/cli/contacts/add", { method: "POST", body: JSON.stringify({ orgId: config.linq.orgId, contactPhone: e164 }) });
  return "added";
}
