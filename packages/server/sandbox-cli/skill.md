# Desk CLI

The `desk` command lets you interact with the host Desk application from inside the sandbox. All commands communicate with the Desk Tool API over a pre-configured connection.

## Environment

The environment variables `DESK_TOOL_TOKEN` and `DESK_TOOL_SOCKET` are pre-set in the sandbox. You must not alter or echo them. Never include the token value in any output.

## Output format

- Success: JSON on stdout, exit code 0.
- Failure: JSON `{"code": "...", "message": "..."}` on stderr, non-zero exit code.

## desk file read

Tool: `file.read`

Read the content of a file by its workspace-relative path.

```
desk file read <path>
```

Example:

```
desk file read notes/hello.md
```

Returns the file content and MIME type.

## desk file write

Tool: `file.write`

Write a file from stdin. The content is read from standard input.

```
desk file write --workspace <id> --name <str> --mime <str> [--chat <id>] < input.txt
```

Example:

```
echo "Hello" | desk file write --workspace ws_abc --name hello.txt --mime text/plain
```

Warning: this writes to real user storage. Be deliberate about what you write.

## desk library list

Tool: `library.list`

List files in a workspace library.

```
desk library list --workspace <id> [--cursor <str>] [--limit <n>]
```

Example:

```
desk library list --workspace ws_abc --limit 10
```

## desk library get

Tool: `library.get`

Get metadata for a library file by its workspace-relative path.

```
desk library get <path>
```

Example:

```
desk library get library/report.pdf
```

## desk chat send-message

Tool: `chat.send_message`

Send a text message to a chat.

```
desk chat send-message --chat <id> <content>
```

Example:

```
desk chat send-message --chat ch_abc "Here is my analysis."
```

Warning: this sends a visible message to the user. Make sure the content is relevant and complete.

## desk chat attach-artifact

Tool: `chat.attach_artifact`

Attach a file as an artifact to a chat, by its workspace-relative path.

```
desk chat attach-artifact --chat <id> --path <path>
```

Example:

```
desk chat attach-artifact --chat cht_abc --path artifacts/report.md
```

## desk web fetch

Tool: `web.fetch`

Fetch a URL. Optionally specify method, headers, and a body file.

```
desk web fetch <url> [--method <m>] [--header k=v]... [--body-file <path>]
```

Example:

```
desk web fetch https://example.com/api --method POST --header Content-Type=application/json --body-file request.json
```

The response includes status, headers, and base64-encoded body.
