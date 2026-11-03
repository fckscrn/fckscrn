// Invoicing for the hosted version: an external invoicing service (proforma first, the invoice after payment).
// Enabled when FAKTURACE_URL and FAKTURACE_API_TOKEN are set; self-hosted servers run without it (all free).
//   POST /api/proformas {ref, customer, items, dueDays} → proforma (idempotent per ref)
//   GET  /api/documents?ref=…  → [{ id, kind: proforma|invoice, number, status, total, dueDate, paidDate, variableSymbol, account, iban }]
//   GET  /api/documents/:id/pdf
export function createInvoicing({ url, token, fetchImpl = fetch }) {
  const base = String(url).replace(/\/$/, "");
  async function call(method, path, body) {
    const res = await fetchImpl(base + path, {
      method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw Object.assign(new Error(`invoicing ${method} ${path}: ${res.status}`), { status: res.status });
    return res;
  }
  return {
    async proforma({ ref, customer, items, dueDays = 14 }) { return (await call("POST", "/api/proformas", { ref, customer, items, dueDays })).json(); },
    async documents(ref) { return (await (await call("GET", `/api/documents?ref=${encodeURIComponent(ref)}`)).json()).documents; },
    async pdf(id) { return call("GET", `/api/documents/${encodeURIComponent(id)}/pdf`); },
  };
}

export async function aresLookup(ico, fetchImpl = fetch) {
  const res = await fetchImpl(`https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/${ico}`, { headers: { Accept: "application/json" } });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`ARES ${res.status}`);
  const d = await res.json();
  const s = d.sidlo || {};
  const no = [s.cisloDomovni, s.cisloOrientacni].filter(Boolean).join("/");
  return {
    ico: d.ico, name: d.obchodniJmeno, dic: d.dic || null,
    street: [s.nazevUlice || s.nazevCastiObce || s.nazevObce, no].filter(Boolean).join(" ") || null,
    city: s.nazevObce || null, zip: s.psc ? String(s.psc) : null,
  };
}
