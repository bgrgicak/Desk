/**
 * Parses natural-language schedule strings into `at` time specs or cron expressions.
 *
 * Scheduled (one-shot) examples:
 *   "in 2 minutes"        -> "now + 2 minutes"
 *   "in 1 hour"           -> "now + 1 hour"
 *   "tomorrow at 9"       -> "9:00 tomorrow"
 *   "tomorrow at 9am"     -> "9:00 AM tomorrow"
 *   "4pm"                 -> "4:00 PM"
 *   "at 14:30"            -> "14:30"
 *   Raw at-syntax passes through.
 *
 * Recurring examples:
 *   "every 5 minutes"           -> "* /5 * * * *"
 *   "every hour"                -> "0 * * * *"
 *   "every day at 9"            -> "0 9 * * *"
 *   "every monday at 9"         -> "0 9 * * 1"
 *   "every weekday at 8:30"     -> "30 8 * * 1-5"
 *   Raw cron expressions pass through.
 */

export interface ParseResult {
  spec: string;
  error?: string;
}

const DAY_MAP: Record<string, string> = {
  sunday: "0", sun: "0",
  monday: "1", mon: "1",
  tuesday: "2", tue: "2",
  wednesday: "3", wed: "3",
  thursday: "4", thu: "4",
  friday: "5", fri: "5",
  saturday: "6", sat: "6",
};

function parseTime(s: string): { hour: number; minute: number } | null {
  // "9" "14" "9am" "9pm" "9:30" "9:30am" "14:30"
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3]?.toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function looksLikeCron(s: string): boolean {
  return /^[0-9*\/,-]+\s+[0-9*\/,-]+\s+[0-9*\/,-]+\s+[0-9*\/,-]+\s+[0-9*\/,-]+$/.test(s.trim());
}

function looksLikeAtSpec(s: string): boolean {
  // Starts with "now", a time like "4:00", or a date-like pattern
  return /^(now\s|noon|midnight|\d{1,2}:\d{2}|\d{4}-)/i.test(s.trim());
}

export function parseScheduled(input: string): ParseResult {
  const s = input.trim();
  if (!s) return { spec: "", error: "Schedule is required" };

  // Pass through raw at-syntax
  if (looksLikeAtSpec(s)) return { spec: s };

  // "in N minutes/hours/days"
  const inMatch = s.match(/^in\s+(\d+)\s+(minutes?|hours?|days?|weeks?)$/i);
  if (inMatch) {
    const n = inMatch[1];
    const unit = inMatch[2].toLowerCase().replace(/s$/, "");
    const atUnit = unit === "minute" ? "minutes" : unit === "hour" ? "hours" : unit === "day" ? "days" : "weeks";
    return { spec: `now + ${n} ${atUnit}` };
  }

  // "tomorrow at 9" / "tomorrow at 9am" / "tomorrow at 14:30"
  const tomorrowMatch = s.match(/^tomorrow\s+at\s+(.+)$/i);
  if (tomorrowMatch) {
    const t = parseTime(tomorrowMatch[1]);
    if (t) {
      const hh = t.hour.toString().padStart(2, "0");
      const mm = t.minute.toString().padStart(2, "0");
      return { spec: `${hh}:${mm} tomorrow` };
    }
  }

  // "at 9" / "at 9am" / "at 14:30"
  const atMatch = s.match(/^at\s+(.+)$/i);
  if (atMatch) {
    const t = parseTime(atMatch[1]);
    if (t) {
      const hh = t.hour.toString().padStart(2, "0");
      const mm = t.minute.toString().padStart(2, "0");
      return { spec: `${hh}:${mm}` };
    }
  }

  // Bare time: "4pm", "9:30am"
  const bareTime = parseTime(s);
  if (bareTime) {
    const hh = bareTime.hour.toString().padStart(2, "0");
    const mm = bareTime.minute.toString().padStart(2, "0");
    return { spec: `${hh}:${mm}` };
  }

  // Fall through: pass as-is to at (let it fail server-side if invalid)
  return { spec: s };
}

export function parseRecurring(input: string): ParseResult {
  const s = input.trim();
  if (!s) return { spec: "", error: "Schedule is required" };

  // Pass through raw cron
  if (looksLikeCron(s)) return { spec: s };

  // "every N minutes/hours"
  const everyN = s.match(/^every\s+(\d+)\s+(minutes?|hours?)$/i);
  if (everyN) {
    const n = parseInt(everyN[1], 10);
    const unit = everyN[2].toLowerCase().replace(/s$/, "");
    if (unit === "minute") return { spec: `*/${n} * * * *` };
    if (unit === "hour") return { spec: `0 */${n} * * *` };
  }

  // "every minute"
  if (/^every\s+minute$/i.test(s)) return { spec: "* * * * *" };

  // "every hour"
  if (/^every\s+hour$/i.test(s)) return { spec: "0 * * * *" };

  // "every day at TIME"
  const everyDayAt = s.match(/^every\s+day\s+at\s+(.+)$/i);
  if (everyDayAt) {
    const t = parseTime(everyDayAt[1]);
    if (t) return { spec: `${t.minute} ${t.hour} * * *` };
  }

  // "every weekday at TIME"
  const everyWeekdayAt = s.match(/^every\s+weekday\s+at\s+(.+)$/i);
  if (everyWeekdayAt) {
    const t = parseTime(everyWeekdayAt[1]);
    if (t) return { spec: `${t.minute} ${t.hour} * * 1-5` };
  }

  // "every <day> at TIME"
  const everyDayNameAt = s.match(/^every\s+(\w+)\s+at\s+(.+)$/i);
  if (everyDayNameAt) {
    const dayNum = DAY_MAP[everyDayNameAt[1].toLowerCase()];
    const t = parseTime(everyDayNameAt[2]);
    if (dayNum !== undefined && t) return { spec: `${t.minute} ${t.hour} * * ${dayNum}` };
  }

  // "every <day>" (no time, defaults to midnight)
  const everyDayName = s.match(/^every\s+(\w+)$/i);
  if (everyDayName) {
    const dayNum = DAY_MAP[everyDayName[1].toLowerCase()];
    if (dayNum !== undefined) return { spec: `0 0 * * ${dayNum}` };
  }

  return { spec: s, error: `Couldn't parse "${s}". Use cron syntax like "*/5 * * * *" or natural language like "every monday at 9".` };
}

export function parseSchedule(mode: "scheduled" | "recurring", input: string): ParseResult {
  return mode === "scheduled" ? parseScheduled(input) : parseRecurring(input);
}
