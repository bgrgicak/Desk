import { useEffect, useState } from "react";
import { api } from "../api";
import { useApi } from "../store";

interface Agent {
  id: string;
  name: string;
  instructions: string;
  model: string;
}

export function AgentPage() {
  const { data: agents } = useApi<Agent[]>("/agents");
  const agent = agents?.[0] ?? null;
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [model, setModel] = useState("");
  const [saved, setSaved] = useState<Agent | null>(null);

  const displayAgent = saved ?? agent;

  useEffect(() => {
    if (displayAgent) {
      setName(displayAgent.name);
      setInstructions(displayAgent.instructions ?? "");
      setModel(displayAgent.model ?? "");
    }
  }, [displayAgent?.id]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!displayAgent) return;
    const { data } = await api<Agent>(`/agents/${displayAgent.id}`, {
      method: "PATCH",
      body: { name, instructions, model },
    });
    setSaved(data);
  }

  if (!displayAgent) return <p>Loading...</p>;

  return (
    <div>
      <h2>Agent: {displayAgent.name}</h2>
      <form onSubmit={handleSave}>
        <div>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>
        <div>
          <label>
            Instructions
            <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          </label>
        </div>
        <div>
          <label>
            Model
            <input value={model} onChange={(e) => setModel(e.target.value)} />
          </label>
        </div>
        <button type="submit">Save agent</button>
      </form>
    </div>
  );
}
