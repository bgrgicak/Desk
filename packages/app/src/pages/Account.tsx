import { useState } from "react";
import { api, setToken } from "../api";
import { useApi } from "../store";
import { cacheClearAll } from "../store";
import { useDispatch } from "react-redux";
import { disconnectWs } from "../ws";

interface UserProfile {
  id: string;
  username: string;
  email?: string;
  avatarPath?: string;
}

export function Account({ onLogout }: { onLogout: () => void }) {
  const { data: user } = useApi<UserProfile>("/me");
  const dispatch = useDispatch();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [avatarPath, setAvatarPath] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [msg, setMsg] = useState("");
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [initialized, setInitialized] = useState(false);

  const displayUser = profile ?? user;

  // Sync form fields once when cached data arrives
  if (displayUser && !initialized) {
    setUsername(displayUser.username);
    setEmail(displayUser.email ?? "");
    setAvatarPath(displayUser.avatarPath ?? "");
    setInitialized(true);
  }

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    const { data } = await api<UserProfile>("/me", {
      method: "PATCH",
      body: { username, email, avatarPath },
    });
    setProfile(data);
    setMsg("Profile updated.");
  }

  async function handlePassword(e: React.FormEvent) {
    e.preventDefault();
    const res = await api("/me/password", {
      method: "POST",
      body: { currentPassword, newPassword },
    });
    if (res.status === 401) {
      setMsg("Current password is incorrect.");
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setMsg("Password changed.");
  }

  async function handleLogout() {
    await api("/auth/logout", { method: "POST" });
    setToken(null);
    dispatch(cacheClearAll());
    disconnectWs();
    onLogout();
  }

  async function handleDeleteAccount() {
    if (!confirm("Delete your account? This cannot be undone.")) return;
    await api("/me", { method: "DELETE" });
    setToken(null);
    dispatch(cacheClearAll());
    disconnectWs();
    onLogout();
  }

  if (!displayUser) return <p>Loading...</p>;

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
          Current password
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
        </label>
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
