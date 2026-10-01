// Runs a Cloudflare quick tunnel to the read-only dashboard (VIEWER_PORT), so it has a public https link
// Beast can text to Asher. Each run gets a new random *.trycloudflare.com URL.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

// Real links are random words; api.trycloudflare.com only shows up in cloudflared's error messages.
const URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;
const PID_FILE = path.join(config.dataDir, "tunnel.pid");
const MAX_DELAY_MS = 5 * 60_000;

let url: string | null = null;
let child: ChildProcess | null = null;
let stopping = false;
let delay = 5_000;

/** The current public dashboard link, or null while the tunnel is down. */
export function getDashboardUrl(): string | null {
  return url;
}

export function startTunnel() {
  if (!config.tunnel.enabled || !config.viewerPort) return;
  killStaleTunnel();
  launch();
  const stop = () => {
    stopping = true;
    child?.kill();
    removePidFile();
  };
  process.once("exit", stop);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => (stop(), process.exit(0)));
}

function launch() {
  const proc = spawn(config.tunnel.command, ["tunnel", "--no-autoupdate", "--url", `http://localhost:${config.viewerPort}`], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child = proc;
  let missing = false;

  const onOutput = (chunk: Buffer) => {
    const found = chunk.toString().match(URL_RE)?.[0];
    if (found && found !== url) {
      url = found;
      delay = 5_000;
      console.log(`[tunnel] dashboard link: ${url}`);
    }
  };
  proc.stdout?.on("data", onOutput);
  proc.stderr?.on("data", onOutput);

  proc.on("spawn", () => writePidFile(proc.pid));
  proc.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      missing = true;
      console.warn("[tunnel] cloudflared isn't installed, so there's no dashboard link. Install it with: winget install --id Cloudflare.cloudflared");
    } else {
      console.error("[tunnel] failed to start:", err.message);
    }
  });
  proc.on("exit", (code) => {
    url = null;
    if (child === proc) child = null;
    removePidFile();
    if (stopping || missing) return;
    console.warn(`[tunnel] cloudflared exited (code ${code}), restarting in ${Math.round(delay / 1000)}s`);
    setTimeout(launch, delay).unref();
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  });
}

// ---- leftover process cleanup (a hard-killed server can't stop its child on Windows) ----

function writePidFile(pid: number | undefined) {
  if (!pid) return;
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(pid));
}

function removePidFile() {
  fs.rmSync(PID_FILE, { force: true });
}

/** Kills a cloudflared left running by a previous server that was killed hard. Only if it's really cloudflared. */
function killStaleTunnel() {
  let pid: number;
  try {
    pid = Number(fs.readFileSync(PID_FILE, "utf8"));
  } catch {
    return;
  }
  removePidFile();
  if (!pid || !isCloudflared(pid)) return;
  try {
    process.kill(pid);
    console.log(`[tunnel] stopped a leftover cloudflared (pid ${pid})`);
  } catch {
    // already gone
  }
}

function isCloudflared(pid: number): boolean {
  try {
    const out =
      process.platform === "win32"
        ? execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" })
        : execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
    return /cloudflared/i.test(out);
  } catch {
    return false;
  }
}
