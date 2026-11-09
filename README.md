# ONES MCP Server

Portable MCP server (TypeScript / Node.js, Stdio) for **ONES Wiki** and **ONES Project / Issues** (`https://ones.yourcompany.com` or custom ONES URL), featuring browser-based 2FA login, 3-tier automatic Bearer token refresh, Markdown ↔ Wiki conversion, subtree page reading, and document extraction (`.pdf`, `.docx`, `.xlsx`, `.md`, `.txt`, images).

## Requirements
- Node.js `>= 20`
- Google Chrome or Microsoft Edge installed locally (for interactive 2FA login)

## Setup on a New Machine (Copy Source / Git Clone)

```bash
cd ones-mcp-server
npm install
npm run build

# 1. Log in once via Chrome/Edge (pass your company's ONES URL, e.g. https://ones.yourcompany.com)
node dist/cli.js login https://ones.yourcompany.com

# 2. Verify live read endpoints on ONES
node dist/cli.js doctor

# 3. Register in Antigravity / Cursor / Claude
node dist/cli.js install-config antigravity
# or: cursor | claude | all
```

Your session token and browser profile live strictly in `~/.ones-mcp/` (`0600` permissions) — never inside this source folder, so you can safely copy or zip the project directory to teammates' machines.

## Environment Variables (Optional)
- `ONES_BASE_URL`: Base URL of your ONES instance (e.g. `https://ones.yourcompany.com`)
- `ONES_TEAM_UUID`: Override default team UUID
- `ONES_BROWSER_PATH`: Custom path to Chrome/Edge executable
- `ONES_MAX_READ_BYTES`: Max document read limit in bytes (default `15728640`)
- `ONES_LOG_LEVEL`: `debug | info | warn | error` (writes strictly to `stderr`)
