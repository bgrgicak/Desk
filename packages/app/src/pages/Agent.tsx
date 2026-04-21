import { useEffect, useState } from "react";
import { api } from "../api";

interface Agent {
  id: string;
  name: string;
  instructions: string;
  model: string;
}

export function AgentPage() {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [model, setModel] = useState("");

  useEffect(() => {
    (async () => {
      const { data } = await api<Agent[]>("/agents");
      if (data.length) {
        const a = data[0];
        setAgent(a);
        setName(a.name);
        setInstructions(a.instructions ?? "");
        setModel(a.model ?? "");
      }
    })();
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!agent) return;
    const { data } = await api<Agent>(`/agents/${agent.id}`, {
      method: "PATCH",
      body: { name, instructions, model },
    });
    setAgent(data);
  }

  if (!agent) return <p>Loading...</p>;

  return (
    <div>
      <h2>Agent: {agent.name}</h2>
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
