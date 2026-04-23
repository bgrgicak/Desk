import { useState, useEffect, useCallback } from "react";
import { getToken, restoreToken } from "./api";
import { connectWs } from "./ws";
import { Login } from "./pages/Login";
import { Today } from "./pages/Today";
import { Chat } from "./pages/Chat";
import { Library } from "./pages/Library";
import { LibraryItem } from "./pages/LibraryItem";
import { AgentPage } from "./pages/Agent";
import { Workspace } from "./pages/Workspace";
import { Account } from "./pages/Account";
import { Search } from "./pages/Search";

export type Route =
  | { page: "today" }
  | { page: "chat"; id: string }
  | { page: "library" }
  | { page: "library-item"; id: string }
  | { page: "agent" }
  | { page: "workspace" }
  | { page: "account" }
  | { page: "search" };

function routeToPath(route: Route): string {
  switch (route.page) {
    case "today": return "/";
    case "chat": return `/chat/${route.id}`;
    case "library": return "/library";
    case "library-item": return `/library/${route.id}`;
    case "agent": return "/agent";
    case "workspace": return "/workspace";
    case "account": return "/account";
    case "search": return "/search";
  }
}

function pathToRoute(path: string): Route {
  const segments = path.split("/").filter(Boolean);
  if (segments[0] === "chat" && segments[1]) return { page: "chat", id: segments[1] };
  if (segments[0] === "library" && segments[1]) return { page: "library-item", id: segments[1] };
  if (segments[0] === "library") return { page: "library" };
  if (segments[0] === "agent") return { page: "agent" };
  if (segments[0] === "workspace") return { page: "workspace" };
  if (segments[0] === "account") return { page: "account" };
  if (segments[0] === "search") return { page: "search" };
  return { page: "today" };
}

export function App() {
  const [route, setRoute] = useState<Route>(() => pathToRoute(window.location.pathname));
  const [loggedIn, setLoggedIn] = useState(() => {
    if (restoreToken()) {
      connectWs();
      return true;
    }
    return false;
  });

  const nav = useCallback((r: Route) => {
    setRoute(r);
    window.history.pushState(null, "", routeToPath(r));
  }, []);

  useEffect(() => {
    function onPopState() {
      setRoute(pathToRoute(window.location.pathname));
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  if (!loggedIn || !getToken()) {
    return <Login onLogin={() => setLoggedIn(true)} />;
  }

  return (
    <div>
      <header>
        <h1>Desk</h1>
        <nav>
          <ul>
            <li><button onClick={() => nav({ page: "today" })}>Today</button></li>
            <li><button onClick={() => nav({ page: "library" })}>Library</button></li>
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
        {route.page === "agent" && <AgentPage />}
        {route.page === "workspace" && <Workspace />}
        {route.page === "account" && <Account onLogout={() => setLoggedIn(false)} />}
        {route.page === "search" && <Search nav={nav} />}
      </main>
    </div>
  );
}
