# Ravi Traders MCP v3

Remote Streamable HTTP MCP server for the Ravi Traders Supabase database.

## Endpoint
- GET /health
- POST/GET/DELETE /mcp

## Render
Build: `npm install`
Start: `npm start`

## Environment variables
- `RAVI_SUPABASE_URL`
- `RAVI_SUPABASE_SERVICE_ROLE_KEY`
- `RAVI_MCP_BEARER_TOKEN`
- `RAVI_ALLOW_WRITE=false`

This version is read-only. It intentionally exposes no payment, refund, invoice-create/edit, or other database-write tool.
