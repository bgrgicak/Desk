import { useState } from "react";
import { getToken } from "./api";
import { Login } from "./pages/Login";
import { Today } from "./pages/Today";
import { Chat } from "./pages/Chat";
import { Library } from "./pages/Library";
import { LibraryItem } from "./pages/LibraryItem";
import { Runs } from "./pages/Runs";
import { RunDetail } from "./pages/RunDetail";
import { Scheduled } from "./pages/Scheduled";
import { AgentPage } from "./pages/Agent";
import { Workspace } from "./pages/Workspace";
import { Account } from "./pages/Account";
import { Search } from "./pages/Search";

export type Route =
  | { page: "today" }
  | { page: "chat"; id: string }
  | { page: "library" }
  | { page: "library-item"; id: string }
  | { page: "runs" }
  | { page: "run-detail"; id: string }
  | { page: "scheduled" }
  | { page: "agent" }
  | { page: "workspace" }
  | { page: "account" }
  | { page: "search" };

export function App() {
  const [route, setRoute] = useState<Route>({ page: "today" });
  const [loggedIn, setLoggedIn] = useState(false);

  if (!loggedIn || !getToken()) {
    return <Login onLogin={() => setLoggedIn(true)} />;
  }

  const nav = (r: Route) => setRoute(r);

  return (
    <div>
      <header>
        <h1>Desk</h1>
        <nav>
          <ul>
            <li><button onClick={() => nav({ page: "today" })}>Today</button></li>
            <li><button onClick={() => nav({ page: "library" })}>Library</button></li>
            <li><button onClick={() => nav({ page: "runs" })}>Runs</button></li>
            <li><button onClick={() => nav({ page: "scheduled" })}>Scheduled</button></li>
            <li><button onClick={() => nav({ page: "agent" })}>Agent</button></li>
            <li><button onClick={() => nav({ page: "workspace" })}>Workspace</button></li>
            <li><button onClick={() => nav({ page: "account" })}>Account</button></li>
            <li><button onClick={() => nav({ page: "search" })}>Search</button></li>
          </ul>
        </nav>
      </header>
      <main>
        {route.page === "today" && <Today nav={nav} />}
        {route.page === "chat" && <Chat id={route.id} nav={nav} />}
        {route.page === "library" && <Library nav={nav} />}
        {route.page === "library-item" && <LibraryItem id={route.id} nav={nav} />}
        {route.page === "runs" && <Runs nav={nav} />}
        {route.page === "run-detail" && <RunDetail id={route.id} nav={nav} />}
        {route.page === "scheduled" && <Scheduled />}
        {route.page === "agent" && <AgentPage />}
        {route.page === "workspace" && <Workspace />}
        {route.page === "account" && <Account onLogout={() => setLoggedIn(false)} />}
        {route.page === "search" && <Search nav={nav} />}
      </main>
    </div>
  );
}
