# roomy-mcp-bridge

Pi extension that bridges arbitrary MCP servers into pi's tool registry.

## Config

The extension reads `<workspace>/.agents/mcp.json` on `session_start`:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "playwright-mcp",
      "args": ["--browser", "firefox"],
      "env": { "DISPLAY": ":99" }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/agent"],
      "enabled": true
    }
  }
}
```

- `enabled: false` skips a server.
- Servers communicate via stdio JSON-RPC (MCP 2024-11-05 protocol).
- Each server's tools are registered as pi tools named `<server>__<tool>`.

## Failure mode

A misconfigured / crashing server is logged to stderr and skipped — pi
itself and other servers keep running. Browser-goal chats that need
Playwright will fail at tool-call time if `playwright` isn't configured
or fails to start; the agent sees a clear `MCP tool error` message.

## Why bare JSON-RPC instead of @modelcontextprotocol/sdk

The MCP wire format is small enough (3 method calls: initialize,
tools/list, tools/call) that the dep cost wasn't worth it. Avoids
chasing the SDK's release cadence and keeps the bridge to one file.
