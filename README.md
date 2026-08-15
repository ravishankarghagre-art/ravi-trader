# Ravi Traders MCP V4 — OAuth Ready

Read-only Ravi Traders MCP server using Streamable HTTP and OAuth/OIDC resource-server validation.

The server does not issue OAuth tokens. An external OAuth/OIDC provider must issue access tokens and expose discovery/JWKS metadata.

Required provider capabilities: Authorization Code + PKCE, discovery, JWT access tokens, JWKS, refresh tokens/offline_access, and a client-registration method accepted by the MCP host.

Endpoints:
- GET /health
- GET /.well-known/oauth-protected-resource
- GET /.well-known/oauth-protected-resource/mcp
- POST/GET/DELETE /mcp

16 read-only tools are exposed. No payment creation, refunds, Razorpay actions, invoice writes, or database writes.
