# Web access security

The web server and Vite development server listen on `127.0.0.1` by default.
Password-free mode is available only on a loopback listener. It also checks the
connection's peer address, HTTP Host, and browser Origin; proxy-forwarded addresses
do not establish local trust. A remote site cannot bootstrap a local session.

Local clients obtain a session token from `/api/auth/status`. The response is not
cacheable. Both `/ws` and `/shell` require a valid token, including in local mode.
The UI obtains this token automatically before opening sockets. Setting
`VITE_IS_PLATFORM` does not bypass server authentication.

To serve another device, set `HOST=0.0.0.0` (or a specific network address) and
`PILOTDECK_DISABLE_LOCAL_AUTH=0`. Network listeners require the normal setup/login
flow. Explicitly disabling authentication on a network listener is a startup
error. Docker's network listener also uses login. Use an account with a known
password before switching an existing local installation to network access;
the automatically created local account has a random password.

Browser requests must originate from the same host and port as the request.
Authenticated deployments needing another frontend origin can specify exact,
comma-separated origins in `PILOTDECK_ALLOWED_ORIGINS`, for example
`https://dashboard.example.com`. This setting does not expand password-free local
access. Reverse proxies should preserve the public Host header. If `API_KEY` is
configured, WebSocket clients must also supply `X-API-Key`, as HTTP API clients do.
