// pages/api/crear-operacion.js
import crypto from 'crypto';

// --- Config (sandbox por defecto) ---
const MERCHANT_CODE = process.env.REDSYS_MERCHANT_CODE || '999008881'; // FUC pruebas
const TERMINAL = process.env.REDSYS_TERMINAL || '1'; // en los ejemplos aparece "1"
const SECRET_KEY =
  process.env.REDSYS_SECRET_KEY || 'sq7HjrUOBfKmC576ILgskD5srU870gJ7'; // clave Base64 de pruebas
const ENV = process.env.REDSYS_ENV || 'test';

const REDSYS_URL =
  ENV === 'real'
    ? 'https://sis.redsys.es/sis/realizarPago'
    : 'https://sis-t.redsys.es:25443/sis/realizarPago';

// --- Utils ---
function toBase64(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64'); // sin CR/LF
}

// Derivación de clave por operación: cifrar ORDER con 3DES usando la clave del comercio (Base64→bin)
// El manual no fija modo/padding; la librería oficial usa 3DES-CBC con IV=0 y padding OpenSSL.
function deriveKey(order, merchantKeyB64) {
  const key = Buffer.from(merchantKeyB64, 'base64');
  const iv = Buffer.alloc(8, 0);
  const cipher = crypto.createCipheriv('des-ede3-cbc', key, iv);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(order, 'utf8'), cipher.final()]);
}

// Firma HMAC-SHA256 sobre el Base64 de Ds_MerchantParameters (resultado en Base64 estándar)
function signParams(paramsBase64, order, merchantKeyB64) {
  const k = deriveKey(order, merchantKeyB64);
  return crypto.createHmac('sha256', k).update(paramsBase64).digest('base64');
}

// Normalizar pedido: 12 dígitos, empezando por dígitos (requisito práctico de Redsys)
function normalizeOrder(raw) {
  let s = String(raw || '');
  s = s.replace(/\D/g, ''); // sólo dígitos
  if (s.length < 4) s = (Date.now() + '').slice(-12);
  if (s.length > 12) s = s.slice(0, 12);
  return s;
}

export default function handler(req, res) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  const base = `${proto}://${host}`;

  // valores por defecto
  const amount = String(req.query.amount || '249'); // céntimos → 2,49 €
  const order = normalizeOrder(req.query.order || `${Date.now()}`);

  // === OJO: claves en MAYÚSCULAS como en el manual ===
  const params = {
    DS_MERCHANT_AMOUNT: amount,            // céntimos
    DS_MERCHANT_ORDER: order,              // 4-12 y empieza por dígitos
    DS_MERCHANT_MERCHANTCODE: MERCHANT_CODE,
    DS_MERCHANT_CURRENCY: '978',           // EUR
    DS_MERCHANT_TRANSACTIONTYPE: '0',
    DS_MERCHANT_TERMINAL: TERMINAL,
    DS_MERCHANT_MERCHANTURL: `${base}/api/redsys/notificacion`,
    DS_MERCHANT_URLOK: `${base}/pago-ok`,
    DS_MERCHANT_URLKO: `${base}/pago-ko`,
  };

  const Ds_MerchantParameters = toBase64(params);
  const Ds_Signature = signParams(Ds_MerchantParameters, params.DS_MERCHANT_ORDER, SECRET_KEY);

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

