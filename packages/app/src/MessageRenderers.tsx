import Markdown from "react-markdown";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface OpenCodeEvent { type: string; part?: Record<string, any>; [key: string]: any; }

/** Strip XML-like tool output tags (e.g. <path>, <content>, <entries>),
 *  keeping only their text content. */
export function stripToolTags(text: string): string {
  return text.replace(/<\/?(path|type|content|entries|task_result)[^>]*>/g, "");
}

/** Detect fake-driver boilerplate and strip it to just the prompt echo. */
function cleanFakeDriverOutput(text: string): string | null {
  const m = text.match(
    /^Starting fake sandbox run\.\.\.\s*(?:System prompt:.*?\.\s*)?Processing prompt:\s*(.*?)\.\.\.\s*Fake response generated\.\s*Run complete\.$/s,
  );
  return m ? `[fake driver] ${m[1]}` : null;
}

export function MessageText({ text }: { text: string }) {
  const fake = cleanFakeDriverOutput(text);
  if (fake) return <em style={{ fontSize: "0.85em", color: "#888" }}>{fake}</em>;
  return <Markdown>{stripToolTags(text)}</Markdown>;
}

export function EventsRenderer({ events }: { events: OpenCodeEvent[] }) {
  return (
    <>
      {events.map((ev, i) => {
        switch (ev.type) {
          case "text":
            return <Markdown key={i}>{stripToolTags(ev.part?.text ?? "")}</Markdown>;
          case "tool_use": {
            const tool = ev.part?.tool ?? "tool";
            const status = ev.part?.state?.status ?? "";
            const output = ev.part?.state?.output;
            return (
              <details key={i} style={{ margin: "0.25em 0" }}>
                <summary style={{ cursor: "pointer", fontSize: "0.85em", color: "#666" }}>
                  {tool}{status ? ` — ${status}` : ""}
                </summary>
                {typeof output === "string" && (
                  <Markdown>{stripToolTags(output)}</Markdown>
                )}
              </details>
            );
          }
          case "step_start":
          case "step_finish": {
            if (ev.type === "step_start") return null;
            const tokens = ev.part?.tokens as Record<string, number> | undefined;
            const cost = ev.part?.cost as number | undefined;
            const parts: string[] = [];
            if (tokens?.input != null) parts.push(`in: ${tokens.input}`);
            if (tokens?.output != null) parts.push(`out: ${tokens.output}`);
            if (cost != null) parts.push(`$${cost.toFixed(4)}`);
            if (parts.length === 0) return null;
            return (
              <div key={i} style={{ fontSize: "0.75em", color: "#999" }}>
                {parts.join(" · ")}
              </div>
            );
          }
          default:
            return null;
        }
      })}
    </>
  );
}
