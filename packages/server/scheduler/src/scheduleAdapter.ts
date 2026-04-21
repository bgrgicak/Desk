import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
      const { stdout } = await execFileAsync("bash", [
        "-c",
        `echo "${command}" | at ${time} 2>&1`,
      ]);
      // at outputs: "job N at ..."
      const match = stdout.match(/job\s+(\d+)/);
      if (!match) throw new Error(`Failed to parse at output: ${stdout}`);
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

      // Install updated crontab
      await execFileAsync("bash", ["-c", `echo "${lines.join("\n")}" | crontab -`]);
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
      await execFileAsync("bash", ["-c", `echo "${lines.join("\n")}" | crontab -`]);
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
