// pages/api/redsys/notificacion.js
import crypto from 'crypto';
import { parse as parseQS } from 'querystring';
import { google } from 'googleapis';

// ==== Config Redsys ====
const MERCHANT_CODE = process.env.REDSYS_MERCHANT_CODE || '999008881';
const TERMINAL = process.env.REDSYS_TERMINAL || '1';
const SECRET_KEY =
  process.env.REDSYS_SECRET_KEY || 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';

// ==== Config Google Sheets ====
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;

// --- Next.js: necesitamos leer el body "crudo"
export const config = { api: { bodyParser: false } };

// ==== Utilidades Redsys ====

// Derivar clave
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

// Firma esperada
function expectedSignature(paramsBase64, order, merchantKeyB64) {
  const k = deriveKey(order, merchantKeyB64);
  return crypto.createHmac('sha256', k).update(paramsBase64).digest('base64');
}

// Base64URL → Base64
function b64UrlToB64(s) {
  return String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
}

// Leer raw body
async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ==== Google Sheets helper ====
async function appendToSheet(row) {
  const auth = new google.auth.JWT(
    GOOGLE_CLIENT_EMAIL,
    null,
    GOOGLE_PRIVATE_KEY,
    ['https://www.googleapis.com/auth/spreadsheets']
  );

  const sheets = google.sheets({ version: 'v4', auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: 'Pagos!A:Z',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
}

// ==== Handler principal ====
export default async function handler(req, res) {
  try {
    const raw = await readRawBody(req);
    const form = parseQS(raw);

    const Ds_MerchantParameters = form.Ds_MerchantParameters || form.ds_merchantparameters || '';
    const Ds_Signature = form.Ds_Signature || form.ds_signature || '';

    if (!Ds_MerchantParameters || !Ds_Signature) {
      console.error('Notificación sin parámetros Redsys', form);
      res.status(400).send('Missing params');
      return;
    }

    const jsonText = Buffer.from(Ds_MerchantParameters, 'base64').toString('utf8');
    const data = JSON.parse(jsonText);

    const order = data.Ds_Order || data.DS_ORDER;
    const responseCode = Number(data.Ds_Response ?? data.DS_RESPONSE);

    // Verificar firma
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

    const autorizado = responseCode >= 0 && responseCode <= 99;

    // 👇 Extraer MerchantData (nombre/email)
    let nombre = '';
    let email = '';
    if (data.Ds_MerchantData) {
      try {
        const extra = JSON.parse(data.Ds_MerchantData);
        nombre = extra.nombre || '';
        email = extra.email || '';
      } catch (e) {
        console.warn('MerchantData inválido', data.Ds_MerchantData);
      }
    }

    console.log('Pago Redsys', { order, autorizado, responseCode, data, nombre, email });

    // 👇 Guardar en Google Sheets
    await appendToSheet([
      new Date().toISOString(),
      order,
      (Number(data.Ds_Amount) / 100).toFixed(2),
      responseCode,
      autorizado ? 'Sí' : 'No',
      data.Ds_Card_Brand || '',
      data.Ds_Card_Country || '',
      data.Ds_ProcessedPayMethod || '',
      nombre,
      email,
    ]);

    res.status(200).send('OK');
  } catch (err) {
    console.error('Error procesando notificación Redsys', err);
    res.status(500).send('ERROR');
  }
}
