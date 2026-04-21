import { useEffect, useState } from "react";
import { api, setToken } from "../api";
import { disconnectWs } from "../ws";

interface UserProfile {
  id: string;
  username: string;
  email?: string;
  avatarPath?: string;
}

export function Account({ onLogout }: { onLogout: () => void }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [avatarPath, setAvatarPath] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    (async () => {
      const { data } = await api<UserProfile>("/me");
      setUser(data);
      setUsername(data.username);
      setEmail(data.email ?? "");
      setAvatarPath(data.avatarPath ?? "");
    })();
  }, []);

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    const { data } = await api<UserProfile>("/me", {
      method: "PATCH",
      body: { username, email, avatarPath },
    });
    setUser(data);
    setMsg("Profile updated.");
  }

  async function handlePassword(e: React.FormEvent) {
    e.preventDefault();
    await api("/me/password", { method: "POST", body: { newPassword } });
    setNewPassword("");
    setMsg("Password changed.");
  }

  async function handleLogout() {
    await api("/auth/logout", { method: "POST" });
    setToken(null);
    disconnectWs();
    onLogout();
  }

  async function handleDeleteAccount() {
    if (!confirm("Delete your account? This cannot be undone.")) return;
    await api("/me", { method: "DELETE" });
    setToken(null);
    disconnectWs();
    onLogout();
  }

  if (!user) return <p>Loading...</p>;

  return (
    <div>
      <h2>Account</h2>
      {msg && <p role="status">{msg}</p>}
      <form onSubmit={handleUpdate}>
        <div>
          <label>
            Username
            <input value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
        </div>
        <div>
          <label>
            Email
            <input value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
        </div>
        <div>
          <label>
            Avatar path
            <input value={avatarPath} onChange={(e) => setAvatarPath(e.target.value)} />
          </label>
        </div>
        <button type="submit">Save profile</button>
      </form>

      <h3>Change password</h3>
      <form onSubmit={handlePassword}>
        <label>
          New password
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
          />
        </label>
        <button type="submit">Change password</button>
      </form>

      <hr />
      <button onClick={handleLogout}>Log out</button>
      <button onClick={handleDeleteAccount}>Delete account</button>
    </div>
  );
}
