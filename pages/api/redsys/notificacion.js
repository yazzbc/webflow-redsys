// pages/api/redsys/notificacion.js
import crypto from 'crypto';
import { parse as parseQS } from 'querystring';
import { google } from 'googleapis';

// ==== Config (usa los mismos valores que crear-operacion) ====
const MERCHANT_CODE = process.env.REDSYS_MERCHANT_CODE || '999008881';
const TERMINAL = process.env.REDSYS_TERMINAL || '1';
const SECRET_KEY = process.env.REDSYS_SECRET_KEY || 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';

// --- Next.js: necesitamos leer el body "crudo" para x-www-form-urlencoded
export const config = { api: { bodyParser: false } };

// ==== Utilidades Redsys ====

// Derivación de clave por operación (3DES-CBC + ZERO PADDING sobre Ds_Order)
function deriveKey(order, merchantKeyB64) {
  const key = Buffer.from(merchantKeyB64, 'base64');
  const iv = Buffer.alloc(8, 0);
  const data = Buffer.from(String(order || ''), 'utf8');
  const padLen = 8 - (data.length % 8 || 8);
  const padded = Buffer.concat([data, Buffer.alloc(padLen, 0)]);
  const cipher = crypto.createCipheriv('des-ede3-cbc', key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

// Firma esperada: HMAC-SHA256(Base64(Ds_MerchantParameters))
function expectedSignature(paramsBase64, order, merchantKeyB64) {
  const k = deriveKey(order, merchantKeyB64);
  return crypto.createHmac('sha256', k).update(paramsBase64).digest('base64');
}

// Base64URL -> Base64 (Redsys suele mandar la firma URL-safe)
function b64UrlToB64(s) {
  return String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
}

async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ==== Google Sheets helper ====
async function appendToSheet(values) {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Pagos!A:Z',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] },
  });
}

export default async function handler(req, res) {
  try {
    // 1) Leer POST (lo manda Redsys como application/x-www-form-urlencoded)
    const raw = await readRawBody(req);
    const form = parseQS(raw); // { Ds_MerchantParameters, Ds_Signature, Ds_SignatureVersion }

    const Ds_MerchantParameters = form.Ds_MerchantParameters || form.ds_merchantparameters || '';
    const Ds_Signature = form.Ds_Signature || form.ds_signature || '';
    const Ds_SignatureVersion = form.Ds_SignatureVersion || form.ds_signatureversion || '';

    if (!Ds_MerchantParameters || !Ds_Signature) {
      console.error('Notificación sin parámetros Redsys', form);
      res.status(400).send('Missing params');
      return;
    }

    // 2) Decodificar parámetros
    const jsonText = Buffer.from(Ds_MerchantParameters, 'base64').toString('utf8');
    const data = JSON.parse(jsonText);

    const order = data.Ds_Order || data.DS_ORDER;
    const responseCode = Number(data.Ds_Response ?? data.DS_RESPONSE);

    // 3) Verificar firma
    const expectedB64 = expectedSignature(Ds_MerchantParameters, order, SECRET_KEY);
    const providedB64 = b64UrlToB64(Ds_Signature);

    let valid = false;
    try {
      const a = Buffer.from(expectedB64);
      const b = Buffer.from(providedB64);
      valid = a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      valid = expectedB64 === providedB64;
    }

    if (!valid) {
      console.error('Firma inválida', { order, expectedB64, providedB64, data });
      res.status(400).send('INVALID SIGNATURE');
      return;
    }

    // 4) Pago autorizado si 0–99
    const autorizado = responseCode >= 0 && responseCode <= 99;

    console.log('Pago Redsys', { order, autorizado, responseCode, data, Ds_SignatureVersion });

    // 5) Guardar en Google Sheets si autorizado
    if (autorizado) {
      await appendToSheet([
        new Date().toISOString(),
        order,
        (Number(data.Ds_Amount) / 100).toFixed(2),
        responseCode,
        autorizado ? 'Sí' : 'No',
        data.Ds_Card_Brand || '',
        data.Ds_Card_Country || '',
        data.Ds_ProcessedPayMethod || '',
        data.Ds_MerchantData || ''
      ]);
    }

    // 6) Responder OK a Redsys
    res.status(200).send('OK');
  } catch (err) {
    console.error('Error procesando notificación Redsys', err);
    res.status(500).send('ERROR');
  }
}
