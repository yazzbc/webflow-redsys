// pages/api/redsys/notificacion.js
import crypto from "crypto";
import { parse as parseQS } from "querystring";
import { google } from "googleapis";

// ==== Config (usa los mismos valores que crear-operacion) ====
const MERCHANT_CODE = process.env.REDSYS_MERCHANT_CODE || "999008881";
const TERMINAL = process.env.REDSYS_TERMINAL || "1";
const SECRET_KEY =
  process.env.REDSYS_SECRET_KEY || "sq7HjrUOBfKmC576ILgskD5srU870gJ7";

// Google Sheets
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;

// ==== Utils ====
function base64Decode(str) {
  return Buffer.from(str, "base64").toString("utf8");
}

// 3DES-CBC con IV=0 y ZERO-PADDING sobre Ds_Order
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

function signParams(paramsBase64, order, merchantKeyB64) {
  const k = deriveKey(order, merchantKeyB64);
  return crypto.createHmac("sha256", k).update(paramsBase64).digest("base64");
}

// ==== Sheets helper ====
async function appendToSheet(values) {
  const auth = new google.auth.JWT({
    email: GOOGLE_CLIENT_EMAIL,
    key: GOOGLE_PRIVATE_KEY,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: "Pagos!A:Z",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [values],
    },
  });
}

// ==== API Route ====
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  try {
    const rawBody = await new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data));
    });

    const { Ds_SignatureVersion, Ds_Signature, Ds_MerchantParameters } =
      parseQS(rawBody);

    const decoded = JSON.parse(base64Decode(Ds_MerchantParameters));
    const expected = signParams(
      Ds_MerchantParameters,
      decoded.Ds_Order,
      SECRET_KEY
    );

    if (expected !== Ds_Signature) {
      console.error("Firma no válida Redsys");
      return res.status(400).send("Bad signature");
    }

    const autorizado = decoded.Ds_Response === "0000";

    console.log("Pago Redsys:", {
      order: decoded.Ds_Order,
      autorizado,
      responseCode: decoded.Ds_Response,
      data: decoded,
    });

    // 👇 Extraemos MerchantData si existe
    let merchantData = "";
    try {
      merchantData = decoded.Ds_MerchantData
        ? JSON.parse(decoded.Ds_MerchantData)
        : {};
    } catch {
      merchantData = decoded.Ds_MerchantData || "";
    }
    console.log("MerchantData recibido:", merchantData);

    // Guardar en Google Sheets
    await appendToSheet([
      decoded.Ds_Date,
      decoded.Ds_Hour,
      decoded.Ds_Order,
      decoded.Ds_Amount,
      autorizado ? "Sí" : "No",
      decoded.Ds_Response,
      decoded.Ds_Card_Number,
      decoded.Ds_Card_Country,
      decoded.Ds_MerchantCode,
      JSON.stringify(merchantData), // 👈 guardamos nombre/email
    ]);

    res.status(200).send("OK");
  } catch (err) {
    console.error("Error procesando notificación Redsys", err);
    res.status(500).send("Error");
  }
}
