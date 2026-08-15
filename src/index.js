import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const SUPABASE_URL = (process.env.RAVI_SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.RAVI_SUPABASE_SERVICE_ROLE_KEY || '';
const BEARER = process.env.RAVI_MCP_BEARER_TOKEN || '';
const PORT = Number(process.env.PORT || 3000);

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing RAVI_SUPABASE_URL or RAVI_SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const base = `${SUPABASE_URL}/rest/v1/`;
const esc = (v) => encodeURIComponent(String(v));
const money = (v) => Math.round(Number(v || 0) * 100) / 100;
const out = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

async function sb(path) {
  const r = await fetch(base + path, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Accept: 'application/json' }
  });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

async function paymentsFor(invoiceIds) {
  if (!invoiceIds.length) return [];
  return sb(`payments?invoice_id=in.(${invoiceIds.map(esc).join(',')})&select=id,invoice_id,customer_id,amount,payment_date,method,note,razorpay_payment_id,created_at&order=payment_date.desc`);
}

function paidMap(payments) {
  const m = {};
  for (const p of payments) m[p.invoice_id] = money((m[p.invoice_id] || 0) + Number(p.amount || 0));
  return m;
}

async function customerByIdOrName({ customer_id, customer_name }) {
  if (customer_id) {
    const rows = await sb(`customers?id=eq.${esc(customer_id)}&select=id,customer_code,name,phone,alternate_phone,email,address,gstin,category,credit_limit,discount_percent,notes,status,created_at,updated_at`);
    return rows;
  }
  if (customer_name) {
    return sb(`customers?name=ilike.*${esc(customer_name)}*&select=id,customer_code,name,phone,alternate_phone,email,address,gstin,category,credit_limit,discount_percent,notes,status,created_at,updated_at&order=name&limit=20`);
  }
  throw new Error('Provide customer_id or customer_name');
}

function registerTools(server) {
  server.registerTool('search_customers', {
    description: 'Search Ravi Traders customers by name, phone, email, or customer code. Read-only.',
    inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(50).default(20) },
    annotations: { readOnlyHint: true }
  }, async ({ query, limit }) => {
    const q = esc(query);
    const rows = await sb(`customers?or=(name.ilike.*${q}*,phone.ilike.*${q}*,email.ilike.*${q}*,customer_code.ilike.*${q}*)&select=id,customer_code,name,phone,alternate_phone,email,address,gstin,category,credit_limit,discount_percent,status&order=name&limit=${limit}`);
    return out({ customers: rows, count: rows.length });
  });

  server.registerTool('get_customer', {
    description: 'Get a detailed Ravi Traders customer profile. Read-only.',
    inputSchema: { customer_id: z.string().uuid().optional(), customer_name: z.string().optional() },
    annotations: { readOnlyHint: true }
  }, async (args) => {
    const rows = await customerByIdOrName(args);
    return out({ customers: rows, count: rows.length });
  });

  server.registerTool('get_customer_balance', {
    description: 'Calculate customer total invoiced, total paid, outstanding balance, and invoice-level balances. Read-only.',
    inputSchema: { customer_id: z.string().uuid().optional(), customer_name: z.string().optional() },
    annotations: { readOnlyHint: true }
  }, async (args) => {
    const customers = await customerByIdOrName(args);
    const results = [];
    for (const c of customers) {
      const invoices = await sb(`invoices?customer_id=eq.${esc(c.id)}&select=id,invoice_no,invoice_date,due_date,total,status&order=invoice_date.desc`);
      const pays = await paymentsFor(invoices.map(i => i.id));
      const paid = paidMap(pays);
      const enriched = invoices.map(i => ({ ...i, paid_amount: paid[i.id] || 0, outstanding_amount: money(Number(i.total) - (paid[i.id] || 0)) }));
      results.push({ customer: c, invoice_count: invoices.length, total_invoiced: money(enriched.reduce((s,i)=>s+Number(i.total||0),0)), total_paid: money(enriched.reduce((s,i)=>s+Number(i.paid_amount||0),0)), outstanding: money(enriched.reduce((s,i)=>s+Number(i.outstanding_amount||0),0)), invoices: enriched });
    }
    return out({ results });
  });

  server.registerTool('get_customer_invoices', {
    description: 'Get a customer invoice history with paid and outstanding amounts. Read-only.',
    inputSchema: { customer_id: z.string().uuid().optional(), customer_name: z.string().optional(), limit: z.number().int().min(1).max(100).default(50) },
    annotations: { readOnlyHint: true }
  }, async (args) => {
    const customers = await customerByIdOrName(args);
    const results = [];
    for (const c of customers.slice(0, 20)) {
      const invoices = await sb(`invoices?customer_id=eq.${esc(c.id)}&select=id,invoice_no,invoice_date,due_date,total,status,notes&order=invoice_date.desc&limit=${args.limit}`);
      const pays = await paymentsFor(invoices.map(i=>i.id));
      const paid = paidMap(pays);
      results.push({ customer: c, invoices: invoices.map(i=>({...i,paid_amount:paid[i.id]||0,outstanding_amount:money(Number(i.total)-Number(paid[i.id]||0))})) });
    }
    return out({ results });
  });

  server.registerTool('search_invoices', {
    description: 'Search invoices by invoice number, customer name snapshot, status, or date range. Read-only.',
    inputSchema: { query: z.string().optional(), status: z.string().optional(), from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), limit: z.number().int().min(1).max(100).default(50) },
    annotations: { readOnlyHint: true }
  }, async ({query,status,from_date,to_date,limit}) => {
    let path = 'invoices?select=id,invoice_no,customer_id,customer_name_snapshot,invoice_date,due_date,total,subtotal,tax_percent,tax_amount,status,notes,created_at&order=invoice_date.desc';
    if (query) path += `&or=(invoice_no.ilike.*${esc(query)}*,customer_name_snapshot.ilike.*${esc(query)}*)`;
    if (status) path += `&status=eq.${esc(status)}`;
    if (from_date) path += `&invoice_date=gte.${esc(from_date)}`;
    if (to_date) path += `&invoice_date=lte.${esc(to_date)}`;
    path += `&limit=${limit}`;
    const invoices = await sb(path); const pays = await paymentsFor(invoices.map(i=>i.id)); const paid=paidMap(pays);
    return out({ invoices: invoices.map(i=>({...i,paid_amount:paid[i.id]||0,outstanding_amount:money(Number(i.total)-Number(paid[i.id]||0))})), count: invoices.length });
  });

  server.registerTool('get_invoice', {
    description: 'Get one complete invoice with customer-safe details, line items, payments, and outstanding balance. Read-only.',
    inputSchema: { invoice_no: z.string().min(1) },
    annotations: { readOnlyHint: true }
  }, async ({invoice_no}) => {
    const rows = await sb(`invoices?invoice_no=eq.${esc(invoice_no)}&select=*`);
    if (!rows.length) throw new Error('Invoice not found');
    const invoice = rows[0];
    const [items,payments] = await Promise.all([
      sb(`invoice_items?invoice_id=eq.${esc(invoice.id)}&select=id,product_id,description,company_name,qty,unit,rate,amount`),
      sb(`payments?invoice_id=eq.${esc(invoice.id)}&select=id,amount,payment_date,method,note,razorpay_payment_id,created_at&order=created_at.desc`)
    ]);
    const paid=money(payments.reduce((s,p)=>s+Number(p.amount||0),0));
    return out({invoice,items,payments,paid_amount:paid,outstanding_amount:money(Number(invoice.total)-paid)});
  });

  server.registerTool('list_products', {
    description: 'List Ravi Traders product catalog with company, unit and current rate. Read-only.',
    inputSchema: { query: z.string().optional(), company_id: z.string().uuid().optional(), unit: z.string().optional(), limit: z.number().int().min(1).max(100).default(50) },
    annotations: { readOnlyHint: true }
  }, async ({query,company_id,unit,limit}) => {
    let path='products?select=id,company_id,name,unit,rate,updated_at&order=name';
    if(query) path+=`&name=ilike.*${esc(query)}*`; if(company_id) path+=`&company_id=eq.${esc(company_id)}`; if(unit) path+=`&unit=eq.${esc(unit)}`; path+=`&limit=${limit}`;
    return out({products:await sb(path)});
  });

  server.registerTool('get_product_details', {
    description: 'Search products and return current rates and units. Read-only.',
    inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(50).default(20) },
    annotations: { readOnlyHint: true }
  }, async ({query,limit}) => out({products:await sb(`products?name=ilike.*${esc(query)}*&select=id,company_id,name,unit,rate,updated_at&order=name&limit=${limit}`)}));

  server.registerTool('list_companies', {
    description: 'List Ravi Traders companies/brands and their material types. Read-only.',
    inputSchema: { material_type: z.string().optional() },
    annotations: { readOnlyHint: true }
  }, async ({material_type}) => out({companies:await sb(`companies?select=id,name,material_type,created_at${material_type?`&material_type=eq.${esc(material_type)}`:''}&order=name`)}));

  server.registerTool('get_overdue_invoices', {
    description: 'Find unpaid invoices past their due date and calculate outstanding amounts. Read-only.',
    inputSchema: { as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), limit: z.number().int().min(1).max(100).default(100) },
    annotations: { readOnlyHint: true }
  }, async ({as_of,limit}) => {
    const date=as_of||new Date().toISOString().slice(0,10); const inv=await sb(`invoices?due_date=lt.${esc(date)}&select=id,invoice_no,customer_id,customer_name_snapshot,invoice_date,due_date,total,status&order=due_date.asc&limit=${limit}`); const pays=await paymentsFor(inv.map(i=>i.id)); const paid=paidMap(pays);
    const rows=inv.map(i=>({...i,paid_amount:paid[i.id]||0,outstanding_amount:money(Number(i.total)-Number(paid[i.id]||0))})).filter(i=>i.outstanding_amount>0&&!['CANCELLED','VOID'].includes(String(i.status).toUpperCase()));
    return out({as_of:date,count:rows.length,total_outstanding:money(rows.reduce((s,i)=>s+i.outstanding_amount,0)),invoices:rows});
  });

  server.registerTool('invoice_aging', {
    description: 'Group unpaid invoice balances into current, 1-30, 31-60, 61-90 and 90+ days. Read-only.',
    inputSchema: { as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() },
    annotations: { readOnlyHint: true }
  }, async ({as_of}) => {
    const date=as_of||new Date().toISOString().slice(0,10); const inv=await sb('invoices?select=id,invoice_no,customer_name_snapshot,invoice_date,due_date,total,status&limit=1000'); const pays=await paymentsFor(inv.map(i=>i.id)); const paid=paidMap(pays);
    const b={current:{count:0,amount:0},'1_30':{count:0,amount:0},'31_60':{count:0,amount:0},'61_90':{count:0,amount:0},'90_plus':{count:0,amount:0}}; const as=new Date(`${date}T00:00:00Z`);
    for(const i of inv){if(['PAID','CANCELLED','VOID'].includes(String(i.status).toUpperCase()))continue;const o=money(Number(i.total)-Number(paid[i.id]||0));if(o<=0)continue;const d=new Date(`${i.due_date||i.invoice_date}T00:00:00Z`);const days=Math.floor((as-d)/86400000);const k=days<=0?'current':days<=30?'1_30':days<=60?'31_60':days<=90?'61_90':'90_plus';b[k].count++;b[k].amount=money(b[k].amount+o);}
    return out({as_of:date,buckets:b,total_outstanding:money(Object.values(b).reduce((s,x)=>s+x.amount,0))});
  });

  server.registerTool('sales_by_product', {
    description: 'Summarize sold quantity and sales value by invoice item description for a date range. Read-only.',
    inputSchema: { start_date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end_date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/), query:z.string().optional(), limit:z.number().int().min(1).max(100).default(50) },
    annotations:{readOnlyHint:true}
  }, async({start_date,end_date,query,limit})=>{const inv=await sb(`invoices?invoice_date=gte.${esc(start_date)}&invoice_date=lte.${esc(end_date)}&select=id`);if(!inv.length)return out({start_date,end_date,products:[]});const items=await sb(`invoice_items?invoice_id=in.(${inv.map(i=>esc(i.id)).join(',')})&select=description,company_name,qty,unit,rate,amount`);const m={};for(const x of items){if(query&&!String(x.description||'').toLowerCase().includes(query.toLowerCase()))continue;const k=x.description||'Unknown';m[k]??={description:k,company_name:x.company_name||null,unit:x.unit||null,quantity:0,sales_value:0};m[k].quantity+=Number(x.qty||0);m[k].sales_value=money(m[k].sales_value+Number(x.amount||0));}return out({start_date,end_date,products:Object.values(m).sort((a,b)=>b.sales_value-a.sales_value).slice(0,limit)});});

  server.registerTool('sales_by_customer', {
    description: 'Summarize invoiced sales and outstanding balances by customer for a date range. Read-only.',
    inputSchema: { start_date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end_date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/), limit:z.number().int().min(1).max(100).default(50) },
    annotations:{readOnlyHint:true}
  }, async({start_date,end_date,limit})=>{const inv=await sb(`invoices?invoice_date=gte.${esc(start_date)}&invoice_date=lte.${esc(end_date)}&select=id,customer_id,customer_name_snapshot,total`);const pays=await paymentsFor(inv.map(i=>i.id));const paid=paidMap(pays);const m={};for(const i of inv){const k=i.customer_id||i.customer_name_snapshot||'Unknown';m[k]??={customer_id:i.customer_id,customer_name:i.customer_name_snapshot,invoiced:0,paid:0,outstanding:0,invoice_count:0};m[k].invoiced=money(m[k].invoiced+Number(i.total||0));m[k].paid=money(m[k].paid+Number(paid[i.id]||0));m[k].outstanding=money(m[k].outstanding+Number(i.total||0)-Number(paid[i.id]||0));m[k].invoice_count++;}return out({start_date,end_date,customers:Object.values(m).sort((a,b)=>b.invoiced-a.invoiced).slice(0,limit)});});

  server.registerTool('sales_summary', {
    description: 'Business sales summary for today, this month, or a custom date range. Read-only.',
    inputSchema: { period:z.enum(['today','month']).optional(), start_date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), end_date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() },
    annotations:{readOnlyHint:true}
  }, async({period,start_date,end_date})=>{const now=new Date();const today=now.toISOString().slice(0,10);let start=start_date,end=end_date;if(!start){start=period==='month'?`${today.slice(0,7)}-01`:today;}if(!end){end=period==='month'?today:today;}const inv=await sb(`invoices?invoice_date=gte.${start}&invoice_date=lte.${end}&select=id,customer_id,customer_name_snapshot,total,status`);const pays=await paymentsFor(inv.map(i=>i.id));const paid=money(pays.reduce((s,p)=>s+Number(p.amount||0),0));const invoiced=money(inv.reduce((s,i)=>s+Number(i.total||0),0));return out({start_date:start,end_date:end,invoice_count:inv.length,total_invoiced:invoiced,total_paid:paid,outstanding:money(invoiced-paid),status_counts:Object.fromEntries([...new Set(inv.map(i=>i.status))].map(s=>[s,inv.filter(i=>i.status===s).length]))});});

  server.registerTool('recent_invoices', {
    description: 'Get the most recent Ravi Traders invoices. Read-only.',
    inputSchema:{limit:z.number().int().min(1).max(100).default(20)},
    annotations:{readOnlyHint:true}
  }, async({limit})=>out({invoices:await sb(`invoices?select=id,invoice_no,customer_name_snapshot,invoice_date,due_date,total,status,created_at&order=created_at.desc&limit=${limit}`)}));

  server.registerTool('invoice_status_summary', {
    description: 'Count invoices by current status and calculate their gross totals. Read-only.',
    inputSchema:{from_date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),to_date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()},
    annotations:{readOnlyHint:true}
  }, async({from_date,to_date})=>{let path='invoices?select=status,total&limit=1000';if(from_date)path+=`&invoice_date=gte.${esc(from_date)}`;if(to_date)path+=`&invoice_date=lte.${esc(to_date)}`;const rows=await sb(path);const m={};for(const r of rows){const s=r.status||'UNKNOWN';m[s]??={count:0,total:0};m[s].count++;m[s].total=money(m[s].total+Number(r.total||0));}return out({summary:m,total_invoices:rows.length});});
}

function createServer(){const s=new McpServer({name:'ravi-traders',version:'3.0.0'});registerTools(s);return s;}
const sessions=new Map();
function cors(res){res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID');res.setHeader('Access-Control-Allow-Methods','GET, POST, DELETE, OPTIONS');res.setHeader('Access-Control-Expose-Headers','Mcp-Session-Id, MCP-Protocol-Version');}
function json(res,status,body){res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));}
function authorized(req){if(!BEARER)return true;return req.headers.authorization===`Bearer ${BEARER}`;}
async function newSession(){const server=createServer();let transport;transport=new StreamableHTTPServerTransport({sessionIdGenerator:()=>randomUUID(),onsessioninitialized:(id)=>sessions.set(id,{server,transport})});transport.onclose=()=>{if(transport.sessionId)sessions.delete(transport.sessionId)};await server.connect(transport);return transport;}
const httpServer=http.createServer(async(req,res)=>{cors(res);try{if(req.method==='OPTIONS')return json(res,204,{});if(req.method==='GET'&&req.url==='/health')return json(res,200,{ok:true,service:'ravi-traders-mcp',transport:'streamable-http',tools:16,version:'3.0.0'});if(req.url!=='/mcp')return json(res,404,{error:'Not found'});if(!authorized(req))return json(res,401,{error:'Unauthorized'});const sid=req.headers['mcp-session-id'];let e=sid?sessions.get(sid):null;if(req.method==='POST'){if(!e){if(sid)return json(res,404,{error:'Unknown MCP session'});const t=await newSession();return t.handleRequest(req,res);}return e.transport.handleRequest(req,res);}if(req.method==='GET'||req.method==='DELETE'){if(!e)return json(res,400,{error:'Mcp-Session-Id is required'});return e.transport.handleRequest(req,res);}return json(res,405,{error:'Method not allowed'});}catch(err){console.error(err);if(!res.headersSent)return json(res,500,{error:'MCP server error'});res.end();}});
httpServer.listen(PORT,'0.0.0.0',()=>console.log(`Ravi Traders MCP v3 listening on ${PORT}`));
