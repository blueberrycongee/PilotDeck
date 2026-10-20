# Web access security

The web server and Vite development server listen on `127.0.0.1` by default.
Password-free mode is available only on a loopback listener. It also checks the
connection's peer address, HTTP Host, and browser Origin; proxy-forwarded addresses
do not establish local trust. A remote site cannot bootstrap a local session.

Local clients obtain a session token from `/api/auth/status`. The response is not
cacheable. Both `/ws` and `/shell` require a valid token, including in local mode.
The UI obtains this token automatically before opening sockets. Setting
`VITE_IS_PLATFORM` does not bypass server authentication. External `/api/agent`
requests require an active API key created in the UI, including hosted/platform
deployments; migrate proxy clients to forward that key before upgrading.

To serve another device, set `HOST=0.0.0.0` (or a specific network address) and
`PILOTDECK_DISABLE_LOCAL_AUTH=0`. Network listeners require the normal setup/login
flow. Explicitly disabling authentication on a network listener is a startup
error. Docker's network listener also uses login. Use an account with a known
password before switching an existing local installation to network access;
the automatically created local account has a random password. Existing saved
`webui.runtime.host` values are preserved: for a local-only installation that
previously saved `0.0.0.0`, change that value to `127.0.0.1` (or set `HOST`)
to retain password-free local access. Do not expose the old local account on a
network listener without establishing its login credentials first.

Browser requests must originate from the same host and port as the request.
Authenticated deployments needing another frontend origin can specify exact,
comma-separated origins in `PILOTDECK_ALLOWED_ORIGINS`, for example
`https://dashboard.example.com`. This setting does not expand password-free local
access. Reverse proxies should preserve the public Host header. If `API_KEY` is
configured, WebSocket clients must also supply `X-API-Key`, as HTTP API clients do.
The browser WebSocket API cannot set arbitrary headers: a deployment using this
extra gate needs a trusted same-origin reverse proxy to inject that header for
both HTTP and WebSocket requests. Direct browser clients should use the normal
account/session-token flow instead.

## File-backed feature boundaries

TaskMaster PRD access is limited to registered projects and their
`.taskmaster/docs` directory. Supported filenames are a single `.txt` or `.md`
name; project registration must exist before these routes can be used.

Custom commands are loaded only from `commands` and `skills` under the configured
PilotDeck home, or `.pilotdeck/commands` and `.pilotdeck/skills` in registered
projects. Arbitrary absolute Markdown paths are no longer accepted. Move external
commands into one of these directories and register their project first.

Canonical path checks apply to existing files and the ancestors of new files.
They are an application boundary, not an operating-system sandbox against a local
process concurrently replacing filesystem entries. This change does not claim a
complete security audit or filesystem race protection.
