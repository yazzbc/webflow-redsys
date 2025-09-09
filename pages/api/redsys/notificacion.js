// pages/api/redsys/notificacion.js
import crypto from 'crypto';
import { parse as parseQS } from 'querystring';

// ==== Config (usa los mismos valores que crear-operacion) ====
const MERCHANT_CODE = process.env.REDSYS_MERCHANT_CODE || '999008881';
const TERMINAL = process.env.REDSYS_TERMINAL || '1';
const SECRET_KEY =
  process.env.REDSYS_SECRET_KEY || 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';

// --- Next.js: necesitamos leer el body "crudo" para x-www-form-urlencoded
export const config = { api: { bodyParser: false } };

// ==== Utilidades (idénticas a las usadas al firmar) ====

// Derivación de clave por operación:
// 3DES-CBC (IV=0) + ZERO PADDING sobre Ds_Order
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

// Firma esperada: HMAC-SHA256(Base64(Ds_MerchantParameters)) en Base64 estándar
function expectedSignature(paramsBase64, order, merchantKeyB64) {
  const k = deriveKey(order, merchantKeyB64);
  return crypto.createHmac('sha256', k).update(paramsBase64).digest('base64');
}

// Base64URL <-> Base64 helpers (Redsys a veces envía la firma en URL-safe)
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

    // 2) Decodificar y leer campos
    const jsonText = Buffer.from(Ds_MerchantParameters, 'base64').toString('utf8');
    const data = JSON.parse(jsonText);

    // Ds_Order puede venir como Ds_Order o DS_ORDER; cubrimos ambas
    const order = data.Ds_Order || data.DS_ORDER;
    const responseCode = Number(data.Ds_Response ?? data.DS_RESPONSE);

    // 3) Verificar la firma
    const expectedB64 = expectedSignature(Ds_MerchantParameters, order, SECRET_KEY);
    // Redsys suele mandar la firma en Base64URL; la normalizamos
    const providedB64 = b64UrlToB64(Ds_Signature);

    let valid = false;
    try {
      // timing-safe compare con buffers del mismo tamaño
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

    // 4) Lógica de negocio: aprobado si 0–99
    const autorizado = responseCode >= 0 && responseCode <= 99;

    // Aquí actualiza tu orden/pedido en tu base de datos.
    // Por ahora, solo registramos en logs de Vercel:
    console.log('Pago Redsys', {
      order,
      autorizado,
      responseCode,
      data,
      Ds_SignatureVersion,
    });

    // 5) Responder "OK" (Redsys espera 200 + cuerpo OK)
    res.status(200).send('OK');
  } catch (err) {
    console.error('Error procesando notificación Redsys', err);
    res.status(500).send('ERROR');
  }
}
