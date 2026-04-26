import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Runs `cmd args...` with `input` on stdin and no shell in between.
 * `spawn` (unlike bash `-c "echo '...' | cmd"`) never expands `$(...)` or
 * backticks in the payload, which matters for us: the at-job script
 * contains `$(cat /etc/desk-server/internal-token)` and must be stored
 * verbatim so the token is read at fire time, not at scheduling time.
 */
function runWithStdin(
  cmd: string,
  args: string[],
  input: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const detail = (stderr || stdout).trim() || `exit ${code}`;
        reject(new Error(`${cmd} ${args.join(" ")} failed: ${detail}`));
      }
    });
    child.stdin.end(input);
  });
}

/**
 * Converts a timespec accepted by our callers into the argv tokens we pass
 * to `at`. ISO 8601 timestamps get formatted as `-t CCYYMMDDhhmm.SS` (the
 * deterministic form, interpreted by `at` in local time); anything else
 * (e.g. "now", "now + 30 minutes") is forwarded as-is so the existing
 * relative-time syntax keeps working.
 */
function atTimeArgs(time: string): string[] {
  if (/^\d{4}-\d{2}-\d{2}T/.test(time)) {
    const d = new Date(time);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`Invalid ISO time for at: ${time}`);
    }
    const pad = (n: number) => n.toString().padStart(2, "0");
    const ts =
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
      `${pad(d.getHours())}${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
    return ["-t", ts];
  }
  // "now + 30 minutes" → ["now", "+", "30", "minutes"]. `at` concatenates
  // argv into its timespec.
  return time.trim().split(/\s+/);
}

export interface ScheduleAdapter {
  scheduleAt(command: string, time: string): Promise<string>; // returns at job ID
  removeAt(atJobId: string): Promise<void>;
  listAt(): Promise<Array<{ id: string; time: string }>>;
  installCron(jobId: string, cronExpr: string, command: string): Promise<void>;
  removeCron(jobId: string): Promise<void>;
  listCron(): Promise<Array<{ jobId: string; cronExpr: string; command: string }>>;
}

/**
 * Creates the appropriate schedule adapter based on environment.
 */
export function createAdapter(): ScheduleAdapter {
  if (process.env.DESK_SCHEDULE_ADAPTER === "memory") {
    return createMemoryAdapter();
  }
  return createRealAdapter();
}

// ---- Memory adapter (for unit tests) ----

interface MemoryAtJob {
  id: string;
  command: string;
  time: string;
}

interface MemoryCronJob {
  jobId: string;
  cronExpr: string;
  command: string;
}

export function createMemoryAdapter(): ScheduleAdapter {
  const atJobs = new Map<string, MemoryAtJob>();
  const cronJobs = new Map<string, MemoryCronJob>();
  let atCounter = 1;

  return {
    async scheduleAt(command, time) {
      const id = String(atCounter++);
      atJobs.set(id, { id, command, time });
      return id;
    },

    async removeAt(atJobId) {
      atJobs.delete(atJobId);
    },

    async listAt() {
      return Array.from(atJobs.values()).map(({ id, time }) => ({ id, time }));
    },

    async installCron(jobId, cronExpr, command) {
      cronJobs.set(jobId, { jobId, cronExpr, command });
    },

    async removeCron(jobId) {
      cronJobs.delete(jobId);
    },

    async listCron() {
      return Array.from(cronJobs.values());
    },
  };
}

// ---- Real adapter (shells out to at/crontab) ----

function createRealAdapter(): ScheduleAdapter {
  return {
    async scheduleAt(command, time) {
      const { stdout, stderr } = await runWithStdin(
        "at",
        atTimeArgs(time),
        command + "\n",
      );
      // `at` writes "job N at ..." to stderr on most distributions.
      const combined = stderr + stdout;
      const match = combined.match(/job\s+(\d+)/);
      if (!match) throw new Error(`Failed to parse at output: ${combined}`);
      return match[1];
    },

    async removeAt(atJobId) {
      await execFileAsync("atrm", [atJobId]);
    },

    async listAt() {
      try {
        const { stdout } = await execFileAsync("atq");
        return stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const parts = line.split("\t");
            return { id: parts[0].trim(), time: parts[1]?.trim() ?? "" };
          });
      } catch {
        return [];
      }
    },

    async installCron(jobId, cronExpr, command) {
      const marker = `# desk-job:${jobId}`;
      const line = `${cronExpr} ${command} ${marker}`;

      // Get current crontab
      let existing = "";
      try {
        const { stdout } = await execFileAsync("crontab", ["-l"]);
        existing = stdout;
      } catch {
        // No existing crontab
      }

      // Remove any existing line for this job
      const lines = existing.split("\n").filter((l) => !l.includes(marker));
      lines.push(line);

      await runWithStdin("crontab", ["-"], lines.join("\n") + "\n");
    },

    async removeCron(jobId) {
      const marker = `# desk-job:${jobId}`;

      let existing = "";
      try {
        const { stdout } = await execFileAsync("crontab", ["-l"]);
        existing = stdout;
      } catch {
        return;
      }

      const lines = existing.split("\n").filter((l) => !l.includes(marker));
      await runWithStdin("crontab", ["-"], lines.join("\n") + "\n");
    },

    async listCron() {
      let existing = "";
      try {
        const { stdout } = await execFileAsync("crontab", ["-l"]);
        existing = stdout;
      } catch {
        return [];
      }

      return existing
        .split("\n")
        .filter((l) => l.includes("# desk-job:"))
        .map((line) => {
          const markerMatch = line.match(/# desk-job:(\S+)/);
          const jobId = markerMatch ? markerMatch[1] : "";
          // Parse cron expr (first 5 fields) and command (rest before marker)
          const parts = line.split(/\s+/);
          const cronExpr = parts.slice(0, 5).join(" ");
          const markerIdx = line.indexOf("# desk-job:");
          const command = line.slice(cronExpr.length, markerIdx).trim();
          return { jobId, cronExpr, command };
        });
    },
  };
}
