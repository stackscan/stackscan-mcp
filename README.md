# StackScan MCP server

Ask your assistant what a website runs, and who is behind it.

A [Model Context Protocol](https://modelcontextprotocol.io) server for the
[StackScan](https://www.stackscan.com) Tech Lookup API. Point Claude, Cursor, or any
other MCP client at it and you can ask things like:

> What is shopify.com built on?
>
> Who's behind vercel.com? Where are they, what industry, what's their LinkedIn?
>
> How many sites run Klaviyo, and in which countries?

Read-only by design. Nothing here writes to any system of yours.

---

## Install

You need a StackScan account. Sign in, open **API Tokens** in the dashboard, create a
token, and copy your workspace UUID from the same page.

### Claude Desktop

**Settings → Developer → Edit Config**, then add:

```json
{
  "mcpServers": {
    "stackscan": {
      "command": "npx",
      "args": ["-y", "@stackscan/mcp-server"],
      "env": {
        "STACKSCAN_API_TOKEN": "your-token",
        "STACKSCAN_TENANT_ID": "your-workspace-uuid"
      }
    }
  }
}
```

Restart Claude Desktop. The tools appear under the connectors icon.

### Claude Code

```bash
claude mcp add stackscan \
  --env STACKSCAN_API_TOKEN=your-token \
  --env STACKSCAN_TENANT_ID=your-workspace-uuid \
  -- npx -y @stackscan/mcp-server
```

### Cursor, Windsurf, and others

Same shape: `command: npx`, `args: ["-y", "@stackscan/mcp-server"]`, and the two
environment variables. Check your client's own MCP docs for where its config file lives.

---

## Tools

| Tool | What it does | Cost |
|---|---|---|
| `check_credits` | Remaining balance and this month's allocation | free |
| `lookup_company` | The company behind a domain: name, industry, city, country, LinkedIn | 1 credit |
| `lookup_domain_technologies` | Technologies detected on a domain, with categories (`limit`, max 50) | 1 credit |
| `lookup_technology` | How many sites run a technology, and where they are | 1 credit |
| `lookup_companies` | Up to 20 domains in one call, returned as a compact table | 1 credit per domain with data |

A lookup that finds nothing is **not** charged. Neither is `check_credits`.

### Why `lookup_companies` stops at 20

The REST endpoint behind it takes 100 domains per request, and this tool
deliberately does not. A tool result goes straight into the model's context, and a
hundred full company payloads is tens of thousands of tokens, which crowds out the
conversation you are actually having, and the model then has to re-read all of it
to answer anything. Twenty compact rows is a table a model can reason over.

It also refuses rather than truncates. If a batch would cost more than your session
cap allows, it charges nothing and tells you how many you can afford. Quietly
dropping domains would hand back an answer that looks complete and is not.

If you genuinely need hundreds of domains, that is what the
[REST endpoint](https://api.stackscan.com/docs) is for.

---

## Configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `STACKSCAN_API_TOKEN` | yes | none | Dashboard → API Tokens |
| `STACKSCAN_TENANT_ID` | yes | none | Your workspace UUID, same page |
| `STACKSCAN_API_BASE` | no | `https://api.stackscan.com` | Rarely needed |
| `STACKSCAN_SESSION_LOOKUP_CAP` | no | `25` | See below |

### The session cap is a spend cap, and it is deliberate

StackScan's own limit is a **rate** limit: requests per minute. That stops a burst. It
does nothing to stop a patient agent quietly spending an entire credit balance over an
afternoon, which is a failure mode humans clicking buttons do not have.

So this server keeps its own counter: **25 credit-consuming lookups per session** by
default, after which it refuses and says why. Misses and `check_credits` never count
against it, because they are never charged. Every successful result carries a footer
showing lookups remaining and your last known balance, so the model can pace itself
instead of discovering the limit by hitting it.

If you mean to go higher, raise it deliberately (`"STACKSCAN_SESSION_LOOKUP_CAP": "200"`) rather
than finding out afterwards.

---

## Development

```bash
npm install
npm run build
```

`test-stdio.mjs` is a minimal JSON-RPC client that drives the server over a real stdio
pipe, so you can exercise it without an MCP host:

```bash
export STACKSCAN_API_TOKEN=...
export STACKSCAN_TENANT_ID=...
node test-stdio.mjs check_credits lookup_company:stripe.com
```

**Never write to stdout in this server.** stdout is the JSON-RPC channel; anything else
on it corrupts the protocol. Diagnostics go to stderr.

---

## Notes for anyone reading the source

Three things about the upstream API shaped this code and are easy to get wrong:

**A miss is HTTP 200, not 404.** The API answers "no data for that domain" with
`200 {"success": false, "error": "No data available"}`. A client that trusts the status
code reads the absent payload and crashes. Every response goes through one place that
separates a miss from a failure, so only a real failure is reported as an error.

**Cached responses are still charged.** The API's response cache shields its database,
not your wallet: a repeat lookup inside the cache window costs the same credit. That is
why the local balance decrements on every hit instead of trying to guess which calls
were free.

**Two base URLs are live.** The API's home is `api.stackscan.com/v1/...`. The older
`app.stackscan.com/api/v1/...` paths are still served and are deliberately *not*
redirected, because a redirect would drop the body on POST. If your config still names
the old host, this server detects it and keeps using the old path shape, so upgrading
will not break you.

## Links

- [API reference](https://api.stackscan.com/docs)
- [What this is, in plain English](https://www.stackscan.com/mcp)
- [StackScan](https://www.stackscan.com)

## License

MIT. See [LICENSE](LICENSE).

The licence covers this client only, roughly 500 lines that make HTTP requests.
The StackScan data it reaches is a paid service and is not covered by it.
