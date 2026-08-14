# Ravi Traders MCP — Render Ready

Remote MCP server for ChatGPT/custom MCP clients using **Streamable HTTP** at `/mcp`.

The server exposes **11 read-only Ravi Traders tools**. It does not expose payment, Razorpay, refund, invoice-creation, or other database-writing tools.

## Tools

- `search_customers`
- `get_customer_balance`
- `search_invoices`
- `get_invoice`
- `list_products`
- `sales_summary`
- `get_customer_invoices`
- `get_overdue_invoices`
- `get_product_details`
- `sales_by_product`
- `invoice_aging`

## Render

1. Upload these files to a private GitHub repository.
2. Render → New → Web Service → select the repository.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variables:

```text
RAVI_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
RAVI_SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
RAVI_MCP_BEARER_TOKEN=GENERATE_A_LONG_RANDOM_SECRET
```

`PORT` is supplied automatically by Render.

## Endpoints

- Health: `https://YOUR-SERVICE.onrender.com/health`
- MCP: `https://YOUR-SERVICE.onrender.com/mcp`

The MCP endpoint uses the modern Streamable HTTP transport and supports MCP sessions.

## Security

The Supabase service-role key stays server-side in Render environment variables. Never commit it to GitHub or put it into ChatGPT. A bearer token can be enabled with `RAVI_MCP_BEARER_TOKEN`.

For a production ChatGPT connector using OAuth, add a proper OAuth authorization/token layer before exposing sensitive business data. Do not use an unauthenticated public endpoint for production.
