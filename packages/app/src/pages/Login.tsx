import { useState } from "react";
import { api, setToken } from "../api";
import { connectWs } from "../ws";

export function Login({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const { status, data } = await api<{ token: string }>("/auth/login", {
      method: "POST",
      body: { username, password },
    });
    if (status === 200 && data.token) {
      setToken(data.token);
      connectWs();
      onLogin();
    } else {
      setError("Invalid username or password");
    }
  }

  return (
    <div>
      <h1>Login</h1>
      {error && <p role="alert">{error}</p>}
      <form onSubmit={handleSubmit}>
        <div>
          <label>
            Username
            <input
              type="text"
              name="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </label>
        </div>
        <div>
          <label>
            Password
            <input
              type="password"
              name="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
        </div>
        <button type="submit">Log in</button>
      </form>
    </div>
  );
}
