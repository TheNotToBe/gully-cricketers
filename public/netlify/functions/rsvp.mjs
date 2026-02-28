// netlify/functions/rsvp.mjs
// Single function handling all RSVP CRUD via Google Sheets API

const SHEET_ID = Netlify.env.get("GOOGLE_SHEET_ID");
const CLIENT_EMAIL = Netlify.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL");
const PRIVATE_KEY = Netlify.env.get("GOOGLE_PRIVATE_KEY")?.replace(/\\n/g, "\n");
const SHEET_NAME = "RSVPs";

// ── Google Auth (JWT → access token) ─────────────────────────────────────────
async function getAccessToken() {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claim = b64url(JSON.stringify({
    iss: CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  }));

  const sig = await sign(`${header}.${claim}`, PRIVATE_KEY);
  const jwt = `${header}.${claim}.${sig}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const { access_token } = await res.json();
  return access_token;
}

function b64url(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function sign(data, pemKey) {
  const keyData = pemToArrayBuffer(pemKey);
  const key = await crypto.subtle.importKey(
    "pkcs8", keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data));
  return b64url(String.fromCharCode(...new Uint8Array(sig)));
}

function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

// ── Sheets helpers ────────────────────────────────────────────────────────────
async function sheetsGet(token, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return res.json();
}

async function sheetsAppend(token, range, values) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values }),
  });
  return res.json();
}

async function sheetsUpdate(token, range, values) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values }),
  });
  return res.json();
}

async function sheetsClear(token, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:clear`;
  await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
}

// ── Row ↔ Object mappers ──────────────────────────────────────────────────────
// Columns: A=ID, B=Name, C=Playing, D=Room, E=ExtraDay, F=PaymentDone, G=Amount, H=PaymentDate, I=Timestamp
function rowToObj([id, name, playing, room, extraDay, payDone, amount, payDate, ts]) {
  return {
    id: Number(id),
    name,
    playingInterest: playing,
    roomPreference: room,
    extraDay,
    payment: {
      done: payDone === "TRUE",
      amount: amount ? parseFloat(amount) : null,
      date: payDate || null,
    },
    timestamp: Number(ts),
  };
}

function objToRow(r) {
  return [
    String(r.id),
    r.name,
    r.playingInterest,
    r.roomPreference,
    r.extraDay,
    r.payment?.done ? "TRUE" : "FALSE",
    r.payment?.amount != null ? String(r.payment.amount) : "",
    r.payment?.date || "",
    String(r.timestamp),
  ];
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async (req) => {
  const method = req.method.toUpperCase();
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  try {
    const token = await getAccessToken();

    // GET — fetch all RSVPs
    if (method === "GET") {
      const data = await sheetsGet(token, `${SHEET_NAME}!A2:I`);
      const rows = (data.values || []).filter(r => r[0]); // skip empty rows
      const rsvps = rows.map(rowToObj);
      return new Response(JSON.stringify(rsvps), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // POST — add new RSVP
    if (method === "POST") {
      const body = await req.json();
      const id = Date.now();
      const record = { ...body, id, timestamp: id, payment: { done: false, amount: null, date: null } };
      await sheetsAppend(token, `${SHEET_NAME}!A:I`, [objToRow(record)]);
      return new Response(JSON.stringify(record), {
        status: 201,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // PATCH — update payment or preferences for existing row
    if (method === "PATCH") {
      const body = await req.json();
      const { id } = body;

      // Read all rows to find the target
      const data = await sheetsGet(token, `${SHEET_NAME}!A2:I`);
      const rows = data.values || [];
      const rowIdx = rows.findIndex(r => r[0] === String(id));
      if (rowIdx === -1) return new Response("Not found", { status: 404, headers: cors });

      const existing = rowToObj(rows[rowIdx]);
      const updated = { ...existing, ...body, payment: { ...existing.payment, ...body.payment } };
      const sheetRow = rowIdx + 2; // +1 for header, +1 for 1-based index
      await sheetsUpdate(token, `${SHEET_NAME}!A${sheetRow}:I${sheetRow}`, [objToRow(updated)]);
      return new Response(JSON.stringify(updated), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // DELETE — remove a row by ID
    if (method === "DELETE") {
      const { id } = await req.json();
      const data = await sheetsGet(token, `${SHEET_NAME}!A2:I`);
      const rows = data.values || [];
      const rowIdx = rows.findIndex(r => r[0] === String(id));
      if (rowIdx === -1) return new Response("Not found", { status: 404, headers: cors });

      // Clear the row, then compact (re-write all rows without the deleted one)
      const remaining = rows.filter((_, i) => i !== rowIdx);
      await sheetsClear(token, `${SHEET_NAME}!A2:I`);
      if (remaining.length > 0) {
        await sheetsAppend(token, `${SHEET_NAME}!A2:I`, remaining);
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    return new Response("Method not allowed", { status: 405, headers: cors });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
};

export const config = {
  path: "/api/rsvp",
};
