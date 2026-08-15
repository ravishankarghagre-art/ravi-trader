# Ravi Traders MCP V4 — Mobile Setup Guide (OAuth)

## Goal
Connect Ravi Traders to ChatGPT using OAuth. Architecture:

ChatGPT -> OAuth 2.1 + PKCE -> OAuth/OIDC provider -> Ravi Traders MCP on Render -> Supabase

The MCP server is a Resource Server. It does not issue OAuth tokens.

## 1. Keep Supabase unchanged

Do not change RLS, roles, keys, tables, or data for this setup. Keep the Supabase service-role key only in Render Environment Variables.

## 2. OAuth provider requirements

Use an OAuth/OIDC provider that supports:
- Authorization Code + PKCE
- OAuth/OIDC discovery
- JWT access tokens
- JWKS
- refresh tokens
- `offline_access` (or equivalent)
- client registration compatible with the MCP host (CIMD or DCR)

ChatGPT's current MCP guidance says refresh tokens are important for maintaining connectivity and recommends `offline_access` for OIDC providers.

## 3. Create the OAuth application

Create an OAuth/OIDC application using Authorization Code + PKCE. Add the redirect/callback URL requested by ChatGPT's OAuth authorization screen. Do not invent a callback URL.

Request scopes such as:

`openid profile offline_access ravi_traders:read`

If your provider uses a different refresh scope, use its equivalent.

## 4. Configure the access-token audience

Configure the provider to issue an access token for:

`https://ravi-trader.onrender.com/mcp`

That value must match `OAUTH_AUDIENCE` in Render.

## 5. Upload V4 to GitHub

Replace the old MCP files with:

ravi-trader/
├── .env.example
├── .gitignore
├── render.yaml
├── package.json
├── README.md
├── SETUP_GUIDE.md
└── src/
    └── index.js

Never upload a real `.env` or service-role key.

## 6. Render Environment Variables

Render -> ravi-trader -> Environment:

`RAVI_SUPABASE_URL=https://xxxxx.supabase.co`
`RAVI_SUPABASE_SERVICE_ROLE_KEY=<REAL SECRET>`
`OAUTH_ISSUER=https://YOUR-OAUTH-ISSUER`
`OAUTH_AUDIENCE=https://ravi-trader.onrender.com/mcp`
`MCP_RESOURCE_URL=https://ravi-trader.onrender.com/mcp`
`OAUTH_REQUIRED_SCOPE=ravi_traders:read`

The service receives `PORT` automatically.

## 7. Deploy

Build command: `npm install`
Start command: `npm start`

## 8. Health test

Open:

`https://ravi-trader.onrender.com/health`

Expected:

`{"ok":true,"service":"ravi-traders-mcp","transport":"streamable-http","tools":16,"version":"4.0.0","oauth":true}`

## 9. OAuth discovery test

Open:

`https://ravi-trader.onrender.com/.well-known/oauth-protected-resource/mcp`

It should return JSON identifying the MCP resource and OAuth authorization server.

Your provider should expose one of:

`https://YOUR-OAUTH-ISSUER/.well-known/openid-configuration`

or

`https://YOUR-OAUTH-ISSUER/.well-known/oauth-authorization-server`

## 10. ChatGPT setup

In ChatGPT Developer Mode create the custom MCP app:

Name: `Ravi Traders`

Server URL:
`https://ravi-trader.onrender.com/mcp`

Authentication: `OAuth`

Then choose **Scan Tools**, complete the OAuth authorization prompt, wait for the scan, and choose **Create**.

Do not use `None` for production because the server protects business data.

## 11. Expected OAuth flow

ChatGPT -> /mcp -> 401 + resource_metadata -> protected-resource metadata -> OAuth provider discovery -> login/consent -> Authorization Code + PKCE -> access token -> /mcp with Bearer token -> JWT verification -> 16 tools.

## 12. Troubleshooting

### Error fetching OAuth configuration
Check the protected-resource metadata and the OAuth provider discovery document. The provider must expose the endpoints and registration capability the ChatGPT MCP client expects.

### MCP server does not implement OAuth
Render is still running an older version or the `/mcp` 401 response is missing the `WWW-Authenticate` resource_metadata challenge.

### Unauthorized
A missing/invalid token is expected for an unauthenticated `/mcp` request. ChatGPT should then follow OAuth discovery.

### Mcp-Session-Id is required
V4 uses stateless Streamable HTTP and should not require a pre-existing session ID for the initial request.

### Tools show 11 instead of 16
Render is still serving V3. Redeploy and check `/health` for version `4.0.0` and tools `16`.

## 13. Security

Keep the Supabase service-role key only in Render. Never commit `.env`. Validate OAuth issuer, audience, signature and required scope. Use HTTPS. Keep OAuth refresh tokens outside this MCP code/database. Do not add payment/refund/write tools without a separate security review.

## 14. V4 tool list

1. search_customers
2. get_customer_balance
3. search_invoices
4. get_invoice
5. list_products
6. sales_summary
7. get_customer_invoices
8. get_overdue_invoices
9. get_product_details
10. sales_by_product
11. invoice_aging
12. get_company_catalog
13. get_customer_sales
14. recent_invoices
15. invoice_status_summary
16. get_payment_history
