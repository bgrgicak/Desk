import { useState } from "react";
import { api, setToken } from "../api";
import { useApi } from "../store";
import { cacheClearAll, cacheInvalidate } from "../store";
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
      <Providers />

      <hr />
      <button onClick={handleLogout}>Log out</button>
      <button onClick={handleDeleteAccount}>Delete account</button>
    </div>
  );
}

interface ProvidersResponse {
  providers: Record<string, string | null>;
}

function Providers() {
  const { data } = useApi<ProvidersResponse>("/me/providers");
  const [draftName, setDraftName] = useState("");
  const [draftValue, setDraftValue] = useState("");
  const [msg, setMsg] = useState("");
  const dispatch = useDispatch();

  async function handleSet(name: string, value: string) {
    if (!value.trim()) return;
    const res = await api<ProvidersResponse>("/me/providers", {
      method: "PUT",
      body: { providers: { [name]: value } },
    });
    if (res.status >= 400) {
      setMsg("Could not save key.");
      return;
    }
    dispatch(cacheInvalidate("/me/providers"));
    setMsg(`${name} saved.`);
    setDraftName("");
    setDraftValue("");
  }

  async function handleClear(name: string) {
    if (!confirm(`Delete ${name}?`)) return;
    await api("/me/providers", {
      method: "PUT",
      body: { providers: { [name]: null } },
    });
    dispatch(cacheInvalidate("/me/providers"));
    setMsg(`${name} cleared.`);
  }

  const providers = data?.providers ?? {};
  const names = Object.keys(providers).sort();

  return (
    <div>
      <h3>AI provider keys</h3>
      {msg && <p role="status">{msg}</p>}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Value</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {names.map((name) => (
            <tr key={name}>
              <td>{name}</td>
              <td>{providers[name] ?? <em>not set</em>}</td>
              <td>
                <ProviderRowActions
                  name={name}
                  hasValue={providers[name] !== null}
                  onSet={(v) => handleSet(name, v)}
                  onClear={() => handleClear(name)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4>Set a different key</h4>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleSet(draftName, draftValue);
        }}
      >
        <label>
          Name
          <input value={draftName} onChange={(e) => setDraftName(e.target.value)} />
        </label>
        <label>
          Value
          <input
            type="password"
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
          />
        </label>
        <button type="submit">Set key</button>
      </form>
    </div>
  );
}

function ProviderRowActions({
  hasValue,
  onSet,
  onClear,
}: {
  name: string;
  hasValue: boolean;
  onSet: (v: string) => void;
  onClear: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");

  if (editing) {
    return (
      <span>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          type="button"
          onClick={() => {
            onSet(value);
            setValue("");
            setEditing(false);
          }}
        >
          Save
        </button>
        <button type="button" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </span>
    );
  }
  return (
    <span>
      <button type="button" onClick={() => setEditing(true)}>
        {hasValue ? "Update" : "Set"}
      </button>
      {hasValue && (
        <button type="button" onClick={onClear}>
          Clear
        </button>
      )}
    </span>
  );
}
