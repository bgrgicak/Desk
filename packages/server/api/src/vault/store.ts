import * as fs from "node:fs/promises";
import * as path from "node:path";
import kdbxweb from "kdbxweb";
import { argon2dAsync, argon2idAsync } from "@noble/hashes/argon2";
import { VaultLockedError } from "@roomy-ai/shared";

/**
 * Per-user encrypted secrets vault, backed by a KDBX 4 file on disk and
 * an in-memory master password.
 *
 * - KDBX path: `${vaultsDir}/{userId}.kdbx`
 * - The master is held only as a Buffer in process memory, keyed by userId.
 * - On lock (logout, restart) the Buffer is zero-filled and dropped.
 * - Argon2 KDF runs in pure JS via @noble/hashes — no native deps.
 *
 * Public API used by route handlers:
 *   status / setup / unlock / lock / lockAll
 *   list / get / upsert
 */

let argon2Initialized = false;
function ensureArgon2(): void {
  if (argon2Initialized) return;
  argon2Initialized = true;
  kdbxweb.CryptoEngine.setArgon2Impl(async (
    password,
    salt,
    memory,
    iterations,
    length,
    parallelism,
    type,
    version,
  ) => {
    // KeePass passes memory in KB; @noble/hashes also wants KB. version
    // is 0x10 (1.0) or 0x13 (1.3); both libraries use the same encoding.
    const opts = {
      t: iterations,
      m: memory,
      p: parallelism,
      dkLen: length,
      version: version as 0x10 | 0x13,
    };
    const pw = new Uint8Array(password);
    const slt = new Uint8Array(salt);
    const fn = type === kdbxweb.CryptoEngine.Argon2TypeArgon2d ? argon2dAsync : argon2idAsync;
    const out = await fn(pw, slt, opts);
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  });
}

export { VaultLockedError };

/** Wrong master password on unlock. */
export class VaultPasswordError extends Error {
  readonly code = "VAULT_BAD_PASSWORD";
  constructor(msg = "Wrong vault password") {
    super(msg);
  }
}

export interface SecretEntry {
  /** KDBX Title — the addressable name of the secret. */
  title: string;
  /** KDBX UserName, optional. */
  username?: string;
  /** KDBX Password (the secret value itself). */
  password: string;
  /** KDBX URL, optional. */
  url?: string;
  /** KDBX Notes, optional. */
  notes?: string;
  /** Custom string fields beyond the five standard ones. */
  fields?: Record<string, string>;
}

/** Metadata-only view (no plaintext); returned by list endpoints. */
export interface SecretSummary {
  title: string;
  username?: string;
  url?: string;
  hasNotes: boolean;
  fieldNames: string[];
  updatedAt: string;
}

interface UnlockedEntry {
  /** Master password as raw bytes. Zero-filled when the vault is locked. */
  master: Buffer;
  /** Cached unlocked KDBX, kept in memory while master is held. */
  db: kdbxweb.Kdbx;
  /** Per-user lock used to serialize writes (avoids racey save() interleaves). */
  writeLock: Promise<void>;
}

const STANDARD_FIELDS = new Set(["Title", "UserName", "Password", "URL", "Notes"]);

export class VaultStore {
  private readonly vaultsDir: string;
  /** userId -> unlocked vault state. Absence ⇒ locked. */
  private readonly unlocked = new Map<string, UnlockedEntry>();

  constructor(vaultsDir: string) {
    this.vaultsDir = vaultsDir;
    ensureArgon2();
  }

  private vaultPath(userId: string): string {
    // userId is server-issued (see generateId in @roomy-ai/shared) and
    // matches /^[a-z]+_[A-Za-z0-9_-]+$/. No path-traversal risk, but
    // sanity-check anyway.
    if (!/^[A-Za-z0-9_-]+$/.test(userId)) {
      throw new Error(`Invalid userId for vault path: ${userId}`);
    }
    return path.join(this.vaultsDir, `${userId}.kdbx`);
  }

  async status(userId: string): Promise<{ exists: boolean; locked: boolean }> {
    const p = this.vaultPath(userId);
    let exists = false;
    try {
      await fs.access(p);
      exists = true;
    } catch {
      exists = false;
    }
    return { exists, locked: !this.unlocked.has(userId) };
  }

  /** Creates a fresh KDBX for the user. Fails if one already exists. */
  async setup(userId: string, password: string): Promise<void> {
    const p = this.vaultPath(userId);
    try {
      await fs.access(p);
      // access() succeeded — file exists
      throw new Error("Vault already exists");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === undefined) throw err; // re-throw "Vault already exists" and other non-fs errors
      if (code !== "ENOENT") throw err;  // unexpected fs error (EACCES, etc.) — don't overwrite
      // ENOENT: file doesn't exist — proceed to create
    }

    await fs.mkdir(this.vaultsDir, { recursive: true });

    const credentials = new kdbxweb.Credentials(
      kdbxweb.ProtectedValue.fromString(password),
      null,
    );
    const db = kdbxweb.Kdbx.create(credentials, "Roomy");
    const buf = await db.save();
    await fs.writeFile(p, Buffer.from(buf), { mode: 0o600 });

    const master = Buffer.from(password, "utf8");
    this.unlocked.set(userId, { master, db, writeLock: Promise.resolve() });
  }

  /** Unlocks an existing vault. Throws VaultPasswordError on bad password. */
  async unlock(userId: string, password: string): Promise<void> {
    const p = this.vaultPath(userId);
    let raw: Buffer;
    try {
      raw = await fs.readFile(p);
    } catch {
      throw new Error("Vault does not exist");
    }
    const credentials = new kdbxweb.Credentials(
      kdbxweb.ProtectedValue.fromString(password),
      null,
    );
    let db: kdbxweb.Kdbx;
    try {
      db = await kdbxweb.Kdbx.load(toArrayBuffer(raw), credentials);
    } catch {
      throw new VaultPasswordError();
    }
    const master = Buffer.from(password, "utf8");
    this.unlocked.set(userId, { master, db, writeLock: Promise.resolve() });
  }

  /** Locks one user's vault, zeroing the master and dropping the cached DB. */
  lock(userId: string): void {
    const entry = this.unlocked.get(userId);
    if (!entry) return;
    entry.master.fill(0);
    this.unlocked.delete(userId);
  }

  /** Locks every vault. Used on server shutdown. */
  lockAll(): void {
    for (const userId of [...this.unlocked.keys()]) {
      this.lock(userId);
    }
  }

  /**
   * Locks the vault and deletes its on-disk KDBX file. Used by the
   * signup endpoint to roll back a partial account creation when a
   * later step fails — the unwanted vault must not survive past the
   * failed signup, or the next attempt with the same username would
   * land on a vault we don't have the password to.
   */
  async destroy(userId: string): Promise<void> {
    this.lock(userId);
    const p = this.vaultPath(userId);
    await fs.rm(p, { force: true });
  }

  isLocked(userId: string): boolean {
    return !this.unlocked.has(userId);
  }

  list(userId: string): SecretSummary[] {
    const entry = this.requireUnlocked(userId);
    const out: SecretSummary[] = [];
    for (const e of iterEntries(entry.db.getDefaultGroup())) {
      out.push(toSummary(e));
    }
    out.sort((a, b) => a.title.localeCompare(b.title));
    return out;
  }

  get(userId: string, title: string): SecretEntry | null {
    const entry = this.requireUnlocked(userId);
    const found = findEntry(entry.db.getDefaultGroup(), title);
    if (!found) return null;
    return toSecretEntry(found);
  }

  /** Removes the entry with the given title. No-op if it doesn't exist. */
  async delete(userId: string, title: string): Promise<void> {
    const entry = this.requireUnlocked(userId);
    await this.runExclusive(userId, async () => {
      const group = entry.db.getDefaultGroup();
      const kEntry = findEntry(group, title);
      if (!kEntry) return;
      // Remove directly from the parent group's entries array rather than
      // using db.remove(), which moves the entry to the recycle bin sub-group
      // where iterEntries would still find it.
      const parent = kEntry.parentGroup ?? group;
      const idx = parent.entries.indexOf(kEntry);
      if (idx >= 0) parent.entries.splice(idx, 1);
      await this.persist(userId);
    });
  }

  /**
   * Upsert: creates the entry if no row with the given title exists,
   * otherwise overwrites every field of the existing one.
   */
  async upsert(userId: string, secret: SecretEntry): Promise<void> {
    const entry = this.requireUnlocked(userId);
    if (!secret.title || typeof secret.title !== "string") {
      throw new Error("Missing title");
    }
    await this.runExclusive(userId, async () => {
      const group = entry.db.getDefaultGroup();
      let kEntry = findEntry(group, secret.title);
      if (!kEntry) {
        kEntry = entry.db.createEntry(group);
      } else {
        // Clear non-standard fields on overwrite so the new payload is
        // authoritative; standard fields get overwritten below.
        for (const key of [...kEntry.fields.keys()]) {
          if (!STANDARD_FIELDS.has(key)) kEntry.fields.delete(key);
        }
      }
      kEntry.fields.set("Title", secret.title);
      kEntry.fields.set("UserName", secret.username ?? "");
      kEntry.fields.set(
        "Password",
        kdbxweb.ProtectedValue.fromString(secret.password ?? ""),
      );
      kEntry.fields.set("URL", secret.url ?? "");
      kEntry.fields.set("Notes", secret.notes ?? "");
      if (secret.fields) {
        for (const [k, v] of Object.entries(secret.fields)) {
          if (STANDARD_FIELDS.has(k)) continue;
          kEntry.fields.set(k, v);
        }
      }
      kEntry.times.update();
      await this.persist(userId);
    });
  }

  private requireUnlocked(userId: string): UnlockedEntry {
    const entry = this.unlocked.get(userId);
    if (!entry) throw new VaultLockedError();
    return entry;
  }

  /**
   * Per-user write serialization. KDBX save rewrites the entire file;
   * concurrent saves would race on disk and could corrupt the latest
   * write.
   */
  private async runExclusive<T>(
    userId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const entry = this.requireUnlocked(userId);
    const prev = entry.writeLock;
    let release!: () => void;
    entry.writeLock = new Promise<void>((r) => {
      release = r;
    });
    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  }

  private async persist(userId: string): Promise<void> {
    const entry = this.requireUnlocked(userId);
    const buf = await entry.db.save();
    await fs.writeFile(this.vaultPath(userId), Buffer.from(buf), { mode: 0o600 });
  }
}

function* iterEntries(group: kdbxweb.KdbxGroup): IterableIterator<kdbxweb.KdbxEntry> {
  for (const e of group.entries) yield e;
  for (const sub of group.groups) yield* iterEntries(sub);
}

function findEntry(group: kdbxweb.KdbxGroup, title: string): kdbxweb.KdbxEntry | undefined {
  for (const e of iterEntries(group)) {
    if (fieldString(e, "Title") === title) return e;
  }
  return undefined;
}

function fieldString(entry: kdbxweb.KdbxEntry, key: string): string {
  const v = entry.fields.get(key);
  if (v == null) return "";
  if (typeof v === "string") return v;
  return v.getText();
}

function toSummary(entry: kdbxweb.KdbxEntry): SecretSummary {
  const fieldNames: string[] = [];
  for (const key of entry.fields.keys()) {
    if (!STANDARD_FIELDS.has(key)) fieldNames.push(key);
  }
  fieldNames.sort();
  const notes = fieldString(entry, "Notes");
  return {
    title: fieldString(entry, "Title"),
    username: fieldString(entry, "UserName") || undefined,
    url: fieldString(entry, "URL") || undefined,
    hasNotes: notes.length > 0,
    fieldNames,
    updatedAt: (entry.times.lastModTime ?? new Date()).toISOString(),
  };
}

function toSecretEntry(entry: kdbxweb.KdbxEntry): SecretEntry {
  const fields: Record<string, string> = {};
  for (const [key, value] of entry.fields) {
    if (STANDARD_FIELDS.has(key)) continue;
    fields[key] = typeof value === "string" ? value : value.getText();
  }
  const out: SecretEntry = {
    title: fieldString(entry, "Title"),
    password: fieldString(entry, "Password"),
  };
  const username = fieldString(entry, "UserName");
  if (username) out.username = username;
  const url = fieldString(entry, "URL");
  if (url) out.url = url;
  const notes = fieldString(entry, "Notes");
  if (notes) out.notes = notes;
  if (Object.keys(fields).length > 0) out.fields = fields;
  return out;
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}
