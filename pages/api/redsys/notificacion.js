// pages/api/redsys/notificacion.js
import crypto from "crypto";
import { google } from "googleapis";

// --- Redsys ---
const SECRET_KEY = process.env.REDSYS_SECRET_KEY;

// --- Google Sheets ---
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;

export const config = { api: { bodyParser: false } };

// ===== Utils =====
function b64UrlToB64(s = "") {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  return t + "=".repeat((4 - (t.length % 4 || 4)) % 4);
}

function decodeB64ToUtf8(b64) {
  return Buffer.from(b64, "base64").toString("utf8");
}

function deriveKey(order, merchantKeyB64) {
  const key = Buffer.from(merchantKeyB64, "base64");
  const iv = Buffer.alloc(8, 0);
  const data = Buffer.from(String(order || ""), "utf8");
  const padLen = 8 - (data.length % 8 || 8);
  const padded = Buffer.concat([data, Buffer.alloc(padLen, 0)]);
  const cipher = crypto.createCipheriv("des-ede3-cbc", key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

function calcSignature(paramsB64, order) {
  const k = deriveKey(order, SECRET_KEY);
  return crypto.createHmac("sha256", k).update(paramsB64).digest("base64");
}

async function appendToSheet(row) {
  const auth = new google.auth.JWT(
    GOOGLE_CLIENT_EMAIL,
    null,
    GOOGLE_PRIVATE_KEY,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: "Pagos!A:Z",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

// ===== Handler =====
export default async function handler(req, res) {
  try {
    // Redsys envía x-www-form-urlencoded
    const raw = await new Promise((resolve) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => resolve(data));
    });

    const form = new URLSearchParams(raw);
    const Ds_Signature_raw = form.get("Ds_Signature") || "";
    const Ds_MerchantParameters = form.get("Ds_MerchantParameters") || "";

    // Decodificamos los parámetros
    const decodedJson = decodeB64ToUtf8(b64UrlToB64(Ds_MerchantParameters));
    const data = JSON.parse(decodedJson);

    const order =
      data.Ds_Order ||
      data.DS_ORDER ||
      data.DS_Order ||
      data.ds_order ||
      "";

    // ---- Verificación de firma ----
    const firmaLocalB64 = calcSignature(Ds_MerchantParameters, order);
    const firmaRemotaB64 = Buffer.from(
      b64UrlToB64(Ds_Signature_raw),
      "base64"
    ).toString("base64");

    let firmasIguales = false;
    try {
      const a = Buffer.from(firmaLocalB64);
      const b = Buffer.from(firmaRemotaB64);
      firmasIguales = a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      firmasIguales = firmaLocalB64 === firmaRemotaB64;
    }

    if (!firmasIguales) {
      console.error("❌ Firma inválida en notificación Redsys");
      return res.status(400).send("bad signature");
    }

    // Autorización
    const code = String(data.Ds_Response ?? data.DS_RESPONSE ?? "");
    const autorizado =
      (Number.isFinite(+code) && +code >= 0 && +code <= 99) || code === "0000";

    // MerchantData (puede venir URL-encoded)
    let nombre = "";
    let email = "";
    try {
      const rawMD =
        data.Ds_MerchantData ||
        data.DS_MERCHANTDATA ||
        data.DS_MERCHANT_MERCHANTDATA ||
        "";
      if (rawMD) {
        const jsonMD = decodeURIComponent(rawMD);
        const obj = JSON.parse(jsonMD);
        nombre = obj.nombre || "";
        email = obj.email || "";
      }
    } catch (e) {
      console.warn("MerchantData no es JSON válido:", data.Ds_MerchantData);
    }

    // Normalizamos fecha/hora e importe
    const fecha = decodeURIComponent(data.Ds_Date || data.DS_DATE || "");
    const hora = decodeURIComponent(data.Ds_Hour || data.DS_HOUR || "");
    const fechaOut = hora ? `${fecha} ${hora}` : fecha;

    const importeEuros =
      data.Ds_Amount || data.DS_AMOUNT
        ? (Number(data.Ds_Amount || data.DS_AMOUNT) / 100).toFixed(2)
        : "";

    // Guardar en Google Sheets en el orden de tus columnas
    await appendToSheet([
      fechaOut, // A: Fecha (con hora)
      order,    // B: Orden
      importeEuros, // C: Importe (€ con 2 decimales)
      code,     // D: Response
      autorizado ? "Sí" : "No", // E: Autorizado
      data.Ds_Card_Brand ?? data.DS_CARD_BRAND ??
        data.Ds_SecurePayment ?? data.DS_SECUREPAYMENT ?? "", // F: Marca tarjeta
      data.Ds_Card_Country ?? data.DS_CARD_COUNTRY ?? "",     // G: País tarjeta
      data.Ds_MerchantCode ?? data.DS_MERCHANTCODE ?? "",     // H: Método
      nombre,  // I: Nombre
      email,   // J: Email
    ]);

    console.log("✅ Notificación procesada OK");
    res.status(200).send("OK");
  } catch (err) {
    console.error("Error procesando notificación Redsys", err);
    res.status(500).send("error");
  }
}
