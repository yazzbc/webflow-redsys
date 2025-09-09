// pages/api/crear-operacion.js
import crypto from 'crypto';

// --- Config (sandbox por defecto) ---
const MERCHANT_CODE = process.env.REDSYS_MERCHANT_CODE || '999008881'; // FUC pruebas
const TERMINAL = process.env.REDSYS_TERMINAL || '001';
const SECRET_KEY =
  process.env.REDSYS_SECRET_KEY || 'sq7HjrUOBfKmC576ILgskD5srU870gJ7'; // clave pruebas (Base64)
const ENV = process.env.REDSYS_ENV || 'test';

const REDSYS_URL =
  ENV === 'real'
    ? 'https://sis.redsys.es/sis/realizarPago'
    : 'https://sis-t.redsys.es:25443/sis/realizarPago';

// --- Utils ---
function toBase64(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

// Derivación de clave por operación: 3DES-CBC (IV=0) sobre Ds_Merchant_Order
function deriveKey(order, merchantKeyB64) {
  const k = Buffer.from(merchantKeyB64, 'base64'); // clave comercio (binario)
  const iv = Buffer.alloc(8, 0);                   // IV = 00000000
  const cipher = crypto.createCipheriv('des-ede3-cbc', k, iv);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(order, 'utf8'), cipher.final()]);
}

// Firma HMAC-SHA256 sobre Ds_MerchantParameters
function signParams(paramsBase64, order, merchantKeyB64) {
  const k = deriveKey(order, merchantKeyB64);
  return crypto.createHmac('sha256', k).update(paramsBase64).digest('base64');
}

// Convertir firma a Base64URL (obligatorio)
function toBase64Url(b64) {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export default function handler(req, res) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  const base = `${proto}://${host}`;

  // Valores de ejemplo si no vienen por query
  const amount = String(req.query.amount || '249'); // céntimos (2,49€)
  // Mejor numérico 8-12 dígitos para pruebas
  const order = String(req.query.order || `${Date.now()}`.slice(-12));

  // Parámetros de Redsys (ojo a la capitalización Ds_Merchant_*)
  const params = {
    Ds_Merchant_Amount: amount,                 // en céntimos
    Ds_Merchant_Order: order,                   // 4-12 chars recomendado
    Ds_Merchant_MerchantCode: MERCHANT_CODE,
    Ds_Merchant_Currency: '978',                // EUR
    Ds_Merchant_TransactionType: '0',
    Ds_Merchant_Terminal: TERMINAL,
    Ds_Merchant_MerchantURL: `${base}/api/redsys/notificacion`,
    Ds_Merchant_UrlOK: `${base}/pago-ok`,
    Ds_Merchant_UrlKO: `${base}/pago-ko`,
  };

  const Ds_MerchantParameters = toBase64(params);
  const signatureB64 = signParams(Ds_MerchantParameters, params.Ds_Merchant_Order, SECRET_KEY);
  const Ds_Signature = toBase64Url(signatureB64);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(`<!doctype html>
<html><body onload="document.forms[0].submit()">
  <form action="${REDSYS_URL}" method="POST">
    <input type="hidden" name="Ds_SignatureVersion" value="HMAC_SHA256_V1" />
    <input type="hidden" name="Ds_MerchantParameters" value="${Ds_MerchantParameters}" />
    <input type="hidden" name="Ds_Signature" value="${Ds_Signature}" />
    <noscript><button>Pagar</button></noscript>
  </form>
</body></html>`);
}
