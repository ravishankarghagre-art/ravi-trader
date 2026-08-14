import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const URL = process.env.RAVI_SUPABASE_URL;
const KEY = process.env.RAVI_SUPABASE_SERVICE_ROLE_KEY;
const PORT = Number(process.env.PORT || 3000);
const BEARER = process.env.RAVI_MCP_BEARER_TOKEN || '';

if (!URL || !KEY) {
  console.error('Missing RAVI_SUPABASE_URL or RAVI_SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const base = URL.replace(/\/$/, '') + '/rest/v1/';

async function sb(path, options = {}) {
  const res = await fetch(base + path, {
    ...options,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

function out(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
function money(n) { return Math.round(Number(n || 0) * 100) / 100; }

function registerTools(server) {
  server.registerTool('search_customers', {
    description: 'Search Ravi Traders customers by name, phone, or email. Read-only.',
    inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(50).default(10) },
    annotations: { readOnlyHint: true }
  }, async ({ query, limit }) => {
    const q = query.replace(/,/g, ' ');
    const data = await sb(`customers?or=(name.ilike.*${encodeURIComponent(q)}*,phone.ilike.*${encodeURIComponent(q)}*,email.ilike.*${encodeURIComponent(q)}*)&select=id,name,phone,email,address,category,credit_limit,discount_percent&order=name&limit=${limit}`);
    return out({ customers: data });
  });

  server.registerTool('get_customer_balance', {
    description: 'Get a customer\'s invoices, total invoiced, total paid, and outstanding balance. Read-only.',
    inputSchema: { customer_id: z.string().uuid().optional(), customer_name: z.string().optional() },
    annotations: { readOnlyHint: true }
  }, async ({ customer_id, customer_name }) => {
    let customers;
    if (customer_id) customers = await sb(`customers?id=eq.${encodeURIComponent(customer_id)}&select=id,name,phone,email,address,credit_limit`);
    else if (customer_name) customers = await sb(`customers?name.ilike.*${encodeURIComponent(customer_name)}*&select=id,name,phone,email,address,credit_limit&order=name&limit=10`);
    else throw new Error('Provide customer_id or customer_name');
    if (!customers.length) throw new Error('Customer not found');
    const results = [];
    for (const c of customers) {
      const invoices = await sb(`invoices?customer_id=eq.${encodeURIComponent(c.id)}&select=id,invoice_no,invoice_date,total,status&order=invoice_date.desc`);
      const ids = invoices.map(x => x.id);
      let pays = [];
      if (ids.length) pays = await sb(`payments?invoice_id=in.(${ids.join(',')})&select=invoice_id,amount,method,payment_date,created_at`);
      const paidBy = {};
      for (const p of pays) paidBy[p.invoice_id] = money((paidBy[p.invoice_id] || 0) + Number(p.amount || 0));
      const enriched = invoices.map(i => ({ ...i, paid_amount: paidBy[i.id] || 0, outstanding_amount: money(Number(i.total) - (paidBy[i.id] || 0)) }));
      results.push({ customer: c, total_invoiced: money(enriched.reduce((s,i)=>s+Number(i.total||0),0)), total_paid: money(enriched.reduce((s,i)=>s+Number(i.paid_amount||0),0)), outstanding: money(enriched.reduce((s,i)=>s+Number(i.outstanding_amount||0),0)), invoices: enriched });
    }
    return out({ results });
  });

  server.registerTool('search_invoices', {
    description: 'Search Ravi Traders invoices by invoice number or customer name. Read-only.',
    inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(100).default(20) },
    annotations: { readOnlyHint: true }
  }, async ({ query, limit }) => {
    const enc = encodeURIComponent(query);
    const data = await sb(`invoices?or=(invoice_no.ilike.*${enc}*,customer_name_snapshot.ilike.*${enc}*)&select=id,invoice_no,customer_id,customer_name_snapshot,invoice_date,due_date,total,subtotal,tax_percent,tax_amount,status,notes,created_at&order=created_at.desc&limit=${limit}`);
    const ids = data.map(x=>x.id);
    let pays = [];
    if (ids.length) pays = await sb(`payments?invoice_id=in.(${ids.join(',')})&select=invoice_id,amount,method,payment_date,razorpay_payment_id`);
    const paid = {};
    for (const p of pays) paid[p.invoice_id] = money((paid[p.invoice_id] || 0) + Number(p.amount || 0));
    return out({ invoices: data.map(i => ({ ...i, paid_amount: paid[i.id] || 0, outstanding_amount: money(Number(i.total) - (paid[i.id] || 0)) })) });
  });

  server.registerTool('get_invoice', {
    description: 'Get one invoice with line items, payment history, and calculated outstanding balance. Read-only.',
    inputSchema: { invoice_no: z.string().min(1) },
    annotations: { readOnlyHint: true }
  }, async ({ invoice_no }) => {
    const invs = await sb(`invoices?invoice_no=eq.${encodeURIComponent(invoice_no)}&select=*`);
    if (!invs.length) throw new Error('Invoice not found');
    const inv = invs[0];
    const items = await sb(`invoice_items?invoice_id=eq.${encodeURIComponent(inv.id)}&select=*`);
    const payments = await sb(`payments?invoice_id=eq.${encodeURIComponent(inv.id)}&select=id,amount,method,razorpay_payment_id,note,payment_date,created_at&order=created_at.desc`);
    const paid = money(payments.reduce((s,p)=>s+Number(p.amount||0),0));
    return out({ invoice: inv, items, payments, paid_amount: paid, outstanding_amount: money(Number(inv.total)-paid) });
  });

  server.registerTool('list_products', {
    description: 'List Ravi Traders product catalog and current rates. Read-only.',
    inputSchema: { query: z.string().optional(), limit: z.number().int().min(1).max(100).default(50) },
    annotations: { readOnlyHint: true }
  }, async ({ query, limit }) => {
    let path = `products?select=id,company_id,name,unit,rate,updated_at&order=name&limit=${limit}`;
    if (query) path = `products?name.ilike.*${encodeURIComponent(query)}*&select=id,company_id,name,unit,rate,updated_at&order=name&limit=${limit}`;
    return out({ products: await sb(path) });
  });

  server.registerTool('sales_summary', {
    description: 'Calculate sales, payments, outstanding, invoice count, and top outstanding customers for today or a month. Read-only.',
    inputSchema: { period: z.enum(['today','month']).default('today') },
    annotations: { readOnlyHint: true }
  }, async ({ period }) => {
    const now = new Date();
    const start = period === 'today' ? now.toISOString().slice(0,10) : `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const end = period === 'today' ? start : `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(new Date(now.getFullYear(), now.getMonth()+1, 0).getDate()).padStart(2,'0')}`;
    const invs = await sb(`invoices?invoice_date=gte.${start}&invoice_date=lte.${end}&select=id,customer_id,customer_name_snapshot,total,invoice_date`);
    const ids = invs.map(i=>i.id);
    const pays = ids.length ? await sb(`payments?invoice_id=in.(${ids.join(',')})&select=invoice_id,amount`) : [];
    const paidBy = {};
    for (const p of pays) paidBy[p.invoice_id] = money((paidBy[p.invoice_id]||0)+Number(p.amount||0));
    const totalInvoiced = money(invs.reduce((s,i)=>s+Number(i.total||0),0));
    const totalPaid = money(pays.reduce((s,p)=>s+Number(p.amount||0),0));
    const byCustomer = {};
    for (const i of invs) {
      const k = i.customer_id || i.customer_name_snapshot || 'Unknown';
      if (!byCustomer[k]) byCustomer[k] = { customer_id:i.customer_id, customer_name:i.customer_name_snapshot, outstanding:0 };
      byCustomer[k].outstanding = money(byCustomer[k].outstanding + Number(i.total||0) - (paidBy[i.id]||0));
    }
    return out({ period, start, end, invoice_count: invs.length, total_invoiced: totalInvoiced, total_paid: totalPaid, outstanding: money(totalInvoiced-totalPaid), top_outstanding_customers: Object.values(byCustomer).sort((a,b)=>b.outstanding-a.outstanding).slice(0,10) });
  });

  server.registerTool('get_customer_invoices', {
    description: 'Get a customer\'s invoice history with totals, status, and outstanding amount. Read-only.',
    inputSchema: { customer_id: z.string().uuid().optional(), customer_name: z.string().optional(), limit: z.number().int().min(1).max(100).default(50) },
    annotations: { readOnlyHint: true }
  }, async ({ customer_id, customer_name, limit }) => {
    let cid = customer_id;
    let customer = null;
    if (!cid && customer_name) {
      const rows = await sb(`customers?name.ilike.*${encodeURIComponent(customer_name)}*&select=id,name,phone,email,address&order=name&limit=10`);
      if (!rows.length) throw new Error('Customer not found');
      customer = rows[0]; cid = customer.id;
    }
    if (!cid) throw new Error('Provide customer_id or customer_name');
    if (!customer) {
      const rows = await sb(`customers?id=eq.${encodeURIComponent(cid)}&select=id,name,phone,email,address`);
      if (!rows.length) throw new Error('Customer not found');
      customer = rows[0];
    }
    const invoices = await sb(`invoices?customer_id=eq.${encodeURIComponent(cid)}&select=id,invoice_no,invoice_date,due_date,total,status,notes,created_at&order=invoice_date.desc&limit=${limit}`);
    const ids = invoices.map(i => i.id);
    const pays = ids.length ? await sb(`payments?invoice_id=in.(${ids.join(',')})&select=invoice_id,amount`) : [];
    const paidBy = {};
    for (const pay of pays) paidBy[pay.invoice_id] = money((paidBy[pay.invoice_id] || 0) + Number(pay.amount || 0));
    return out({ customer, invoices: invoices.map(i => ({ ...i, paid_amount: paidBy[i.id] || 0, outstanding_amount: money(Number(i.total || 0) - (paidBy[i.id] || 0)) })) });
  });

  server.registerTool('get_overdue_invoices', {
    description: 'Find Ravi Traders invoices whose due date has passed and that are not fully paid/cancelled. Read-only.',
    inputSchema: { as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), limit: z.number().int().min(1).max(100).default(50) },
    annotations: { readOnlyHint: true }
  }, async ({ as_of, limit }) => {
    const date = as_of || new Date().toISOString().slice(0, 10);
    const invoices = await sb(`invoices?due_date=lt.${encodeURIComponent(date)}&select=id,invoice_no,customer_id,customer_name_snapshot,invoice_date,due_date,total,status&order=due_date.asc&limit=${limit}`);
    const ids = invoices.map(i => i.id);
    const pays = ids.length ? await sb(`payments?invoice_id=in.(${ids.join(',')})&select=invoice_id,amount`) : [];
    const paidBy = {};
    for (const pay of pays) paidBy[pay.invoice_id] = money((paidBy[pay.invoice_id] || 0) + Number(pay.amount || 0));
    const overdue = invoices.filter(i => !['PAID','CANCELLED','VOID'].includes(String(i.status || '').toUpperCase())).map(i => ({ ...i, paid_amount: paidBy[i.id] || 0, outstanding_amount: money(Number(i.total || 0) - (paidBy[i.id] || 0)) })).filter(i => i.outstanding_amount > 0);
    return out({ as_of: date, count: overdue.length, invoices: overdue });
  });

  server.registerTool('get_product_details', {
    description: 'Get detailed information and current rate for one or more Ravi Traders products. Read-only.',
    inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(50).default(20) },
    annotations: { readOnlyHint: true }
  }, async ({ query, limit }) => {
    const products = await sb(`products?name.ilike.*${encodeURIComponent(query)}*&select=id,company_id,name,unit,rate,updated_at&order=name&limit=${limit}`);
    return out({ products });
  });

  server.registerTool('sales_by_product', {
    description: 'Summarize invoiced quantity and sales value by product/line-item description for a date range. Read-only.',
    inputSchema: { start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), query: z.string().optional(), limit: z.number().int().min(1).max(100).default(50) },
    annotations: { readOnlyHint: true }
  }, async ({ start_date, end_date, query, limit }) => {
    const invoices = await sb(`invoices?invoice_date=gte.${encodeURIComponent(start_date)}&invoice_date=lte.${encodeURIComponent(end_date)}&select=id,invoice_date,status`);
    const ids = invoices.map(i => i.id);
    if (!ids.length) return out({ start_date, end_date, products: [] });
    const items = await sb(`invoice_items?invoice_id=in.(${ids.join(',')})&select=invoice_id,description,qty,unit,rate,amount`);
    const by = {};
    for (const item of items) {
      if (query && !String(item.description || '').toLowerCase().includes(query.toLowerCase())) continue;
      const key = String(item.description || 'Unknown').trim();
      if (!by[key]) by[key] = { description: key, unit: item.unit || null, quantity: 0, sales_value: 0, line_count: 0 };
      by[key].quantity += Number(item.qty || 0);
      by[key].sales_value = money(by[key].sales_value + Number(item.amount || (Number(item.qty || 0) * Number(item.rate || 0))));
      by[key].line_count += 1;
    }
    const products = Object.values(by).sort((a,b) => b.sales_value - a.sales_value).slice(0, limit);
    return out({ start_date, end_date, products });
  });

  server.registerTool('invoice_aging', {
    description: 'Create an invoice aging summary grouped into current, 1-30, 31-60, 61-90, and 90+ overdue days. Read-only.',
    inputSchema: { as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() },
    annotations: { readOnlyHint: true }
  }, async ({ as_of }) => {
    const date = as_of || new Date().toISOString().slice(0, 10);
    const invoices = await sb(`invoices?select=id,invoice_no,customer_id,customer_name_snapshot,invoice_date,due_date,total,status&order=due_date.asc&limit=1000`);
    const ids = invoices.map(i => i.id);
    const pays = ids.length ? await sb(`payments?invoice_id=in.(${ids.join(',')})&select=invoice_id,amount`) : [];
    const paidBy = {};
    for (const pay of pays) paidBy[pay.invoice_id] = money((paidBy[pay.invoice_id] || 0) + Number(pay.amount || 0));
    const asOf = new Date(date + 'T00:00:00Z');
    const buckets = { current: 0, '1_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0 };
    const counts = { current: 0, '1_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0 };
    for (const i of invoices) {
      if (['PAID','CANCELLED','VOID'].includes(String(i.status || '').toUpperCase())) continue;
      const outstanding = money(Number(i.total || 0) - (paidBy[i.id] || 0));
      if (outstanding <= 0) continue;
      const due = new Date(String(i.due_date || i.invoice_date) + 'T00:00:00Z');
      const days = Math.floor((asOf - due) / 86400000);
      const key = days <= 0 ? 'current' : days <= 30 ? '1_30' : days <= 60 ? '31_60' : days <= 90 ? '61_90' : '90_plus';
      buckets[key] = money(buckets[key] + outstanding);
      counts[key] += 1;
    }
    return out({ as_of: date, buckets: Object.fromEntries(Object.keys(buckets).map(k => [k, { invoice_count: counts[k], outstanding: buckets[k] }])) });
  });
}

function createServer() {
  const server = new McpServer({ name: 'ravi-traders', version: '2.1.0' });
  registerTools(server);
  return server;
}

const sessions = new Map();

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, MCP-Protocol-Version');
}

function authorized(req) {
  if (!BEARER) return true;
  const header = req.headers.authorization || '';
  return header === `Bearer ${BEARER}`;
}

function sendJson(res, status, body) {
  if (!res.headersSent) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
  }
  res.end(JSON.stringify(body));
}

async function createSession() {
  const server = createServer();
  let sessionTransport;
  sessionTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, { server, transport: sessionTransport });
    }
  });
  sessionTransport.onclose = () => {
    const id = sessionTransport.sessionId;
    if (id) sessions.delete(id);
  };
  await server.connect(sessionTransport);
  return sessionTransport;
}

const httpServer = http.createServer(async (req, res) => {
  setCors(res);
  try {
    if (req.method === 'OPTIONS') return sendJson(res, 204, {});

    if (req.url === '/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, service: 'ravi-traders-mcp', transport: 'streamable-http', tools: 11 });
    }

    if (req.url !== '/mcp') return sendJson(res, 404, { error: 'Not found' });
    if (!authorized(req)) return sendJson(res, 401, { error: 'Unauthorized' });

    const sessionId = req.headers['mcp-session-id'];
    let entry = sessionId ? sessions.get(sessionId) : null;

    if (req.method === 'POST') {
      if (!entry) {
        if (sessionId) return sendJson(res, 404, { error: 'Unknown MCP session' });
        const transport = await createSession();
        return await transport.handleRequest(req, res);
      }
      return await entry.transport.handleRequest(req, res);
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!entry) return sendJson(res, 400, { error: 'Mcp-Session-Id is required for this request' });
      return await entry.transport.handleRequest(req, res);
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) return sendJson(res, 500, { error: 'MCP server error' });
    res.end();
  }
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Ravi Traders MCP listening on 0.0.0.0:${PORT}`);
  console.log(`MCP endpoint: /mcp`);
  console.log(`Health endpoint: /health`);
  console.log(`Authentication: ${BEARER ? 'Bearer token enabled' : 'DISABLED'}`);
});
