// JSON documents on disk with an in-memory copy. Every change is a synchronous read-modify-write on the
// in-memory object followed by an atomic save (temp file + rename), so on Node's single thread two writers
// can't interleave and lose each other's update, and a crash never leaves a half-written file.
import fs from "node:fs";
import path from "node:path";

export class JsonDoc<T extends object> {
  readonly data: T;

  constructor(
    readonly file: string,
    init: () => T,
    upgrade: (loaded: T) => T = (d) => d,
  ) {
    this.data = load(file, init, upgrade);
  }

  /** Apply a change and persist it. Keep `fn` synchronous: nothing may await between read and save. */
  update<R>(fn: (d: T) => R): R {
    const result = fn(this.data);
    if (result instanceof Promise) throw new Error("JsonDoc.update callbacks must be synchronous");
    this.save();
    return result;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

function load<T>(file: string, init: () => T, upgrade: (d: T) => T): T {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return init();
  }
  // A corrupt file is a real problem: fail loudly instead of silently starting empty and overwriting it.
  return upgrade({ ...init(), ...JSON.parse(raw) });
}
