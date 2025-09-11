// pages/api/redsys/notificacion.js
import crypto from "crypto";
import { google } from "googleapis";

// Config Redsys
const MERCHANT_CODE = process.env.REDSYS_MERCHANT_CODE;
const TERMINAL = process.env.REDSYS_TERMINAL;
const SECRET_KEY = process.env.REDSYS_SECRET_KEY;

// Config Google Sheets
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;

export const config = { api: { bodyParser: false } };

// ---- Utils ----
function base64UrlDecode(str) {
  return Buffer.from(str, "base64").toString("utf8");
}

function deriveKey(order, merchantKeyB64) {
  const key = Buffer.from(merchantKeyB64, "base64");
  const iv = Buffer.alloc(8, 0);
  const data = Buffer.from(order, "utf8");
  const padLen = 8 - (data.length % 8 || 8);
  const padded = Buffer.concat([data, Buffer.alloc(padLen, 0)]);
  const cipher = crypto.createCipheriv("des-ede3-cbc", key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

function verifySignature(paramsB64, signatureReceived, order) {
  const k = deriveKey(order, SECRET_KEY);
  const signatureCalc = crypto
    .createHmac("sha256", k)
    .update(paramsB64)
    .digest("base64");
  return signatureCalc === signatureReceived;
}

// ---- Google Sheets helper ----
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

export default async function handler(req, res) {
  try {
    const raw = await new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data));
    });

    const params = new URLSearchParams(raw);
    const Ds_Signature = params.get("Ds_Signature");
    const Ds_MerchantParameters = params.get("Ds_MerchantParameters");

    const decoded = JSON.parse(base64UrlDecode(Ds_MerchantParameters));

    // Verificar firma
    if (!verifySignature(Ds_MerchantParameters, Ds_Signature, decoded.Ds_Order)) {
      console.error("Firma inválida en notificación Redsys");
      return res.status(400).send("bad signature");
    }

    const autorizado = decoded.Ds_Response === "0000";

    // Parsear MerchantData (puede venir urlencoded)
    let merchantData = {};
    try {
      merchantData = JSON.parse(
        decodeURIComponent(decoded.Ds_MerchantData || "{}")
      );
    } catch (e) {
      console.warn("MerchantData no es JSON válido:", decoded.Ds_MerchantData);
    }

    console.log("Notificación Redsys recibida:", {
      order: decoded.Ds_Order,
      autorizado,
      nombre: merchantData.nombre,
      email: merchantData.email,
    });

    // Guardar en Google Sheets
    await appendToSheet([
      decodeURIComponent(decoded.Ds_Date || ""),   // ✅ fecha limpia
      decodeURIComponent(decoded.Ds_Hour || ""),   // ✅ hora limpia
      decoded.Ds_Order || "",
      decoded.Ds_Amount ? String(Number(decoded.Ds_Amount) / 100) : "",
      autorizado ? "Sí" : "No",
      decoded.Ds_Response || "",
      decoded.Ds_Card_Number || "",
      decoded.Ds_Card_Country || "",
      decoded.Ds_MerchantCode || "",
      merchantData.nombre || "",
      merchantData.email || "",
    ]);

    res.status(200).send("OK");
  } catch (err) {
    console.error("Error procesando notificación Redsys", err);
    res.status(500).send("error");
  }
}
