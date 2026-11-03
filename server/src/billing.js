// Invoicing through Fakturoid API v3 (https://www.fakturoid.cz/api/v3).
// Used only by the hosted version: enabled when FAKTUROID_* credentials are set.
const BASE = "https://app.fakturoid.cz/api/v3";

export function createFakturoid({ clientId, clientSecret, account, email, fetchImpl = fetch }) {
  const userAgent = `fckscrn (${email})`;
  let token = null, tokenUntil = 0;

  async function getToken() {
    if (token && Date.now() < tokenUntil) return token;
    const res = await fetchImpl(`${BASE}/oauth/token`, {
      method: "POST",
      headers: {
        "User-Agent": userAgent, "Content-Type": "application/json", Accept: "application/json",
        Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      },
      body: JSON.stringify({ grant_type: "client_credentials" }),
    });
    if (!res.ok) throw new Error(`Fakturoid: přihlášení selhalo (${res.status})`);
    const data = await res.json();
    token = data.access_token;
    tokenUntil = Date.now() + ((data.expires_in || 7200) - 120) * 1000; // tokens live 2 h, no refresh
    return token;
  }

  async function api(method, path, body, retried = false) {
    const res = await fetchImpl(`${BASE}/accounts/${account}${path}`, {
      method,
      headers: { "User-Agent": userAgent, "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${await getToken()}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried) { token = null; return api(method, path, body, true); }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw Object.assign(new Error(`Fakturoid ${method} ${path}: ${res.status} ${JSON.stringify(err.errors || err)}`), { status: res.status });
    }
    return res.status === 204 ? null : res.json();
  }

  return {
    /** Reuse the customer by IČO, otherwise create them. */
    async subject(c) {
      if (c.ico) {
        const found = await api("GET", `/subjects/search.json?query=${encodeURIComponent(c.ico)}`);
        const hit = (found || []).find(s => s.registration_no === c.ico);
        if (hit) return hit.id;
      }
      const s = await api("POST", "/subjects.json", {
        name: c.name, registration_no: c.ico || undefined, vat_no: c.dic || undefined,
        street: c.street || undefined, city: c.city || undefined, zip: c.zip || undefined,
        country: "CZ", email: c.email, type: "customer",
      });
      return s.id;
    },
    async invoice({ subjectId, text, price, due = 14, customId }) {
      return api("POST", "/invoices.json", {
        subject_id: subjectId, document_type: "invoice", payment_method: "bank", due, custom_id: customId,
        lines: [{ name: text, quantity: 1, unit_name: "akce", unit_price: price }],
      });
    },
    async send(invoiceId, { email, eventName }) {
      return api("POST", `/invoices/${invoiceId}/message.json`, {
        email,
        subject: `Faktura #no# – FckScrn pro ${eventName}`,
        message: `Dobrý den,\n\nděkujeme, že jste si pro „${eventName}“ vybrali FckScrn. Akce je aktivní, projekce už běží bez vodoznaku.\n\nFakturu najdete zde: #link#\nČástka #price#, splatnost #due#, variabilní symbol #vs#.\n\nAť přednášky prostě fungují,\nTomáš Foltas, FckScrn`,
      });
    },
    get: id => api("GET", `/invoices/${id}.json`),
  };
}

/** Company details from the public Czech business register (ARES). */
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
