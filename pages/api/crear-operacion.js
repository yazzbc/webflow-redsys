// pages/api/crear-operacion.js
import crypto from 'crypto';

// ---- Config (sandbox por defecto) ----
const MERCHANT_CODE = process.env.REDSYS_MERCHANT_CODE || '118436674'; // FUC real
const TERMINAL = process.env.REDSYS_TERMINAL || '100';                  // Terminal real
const SECRET_KEY = process.env.REDSYS_SECRET_KEY;                       // Clave real (Base64)
const ENV = process.env.REDSYS_ENV || 'real';

// Importe fijo (en céntimos) → 50 = 0,50 €
const PRICE_CENTS = String(process.env.PRICE_CENTS || '50');

// URL Redsys
const REDSYS_URL =
  ENV === 'real'
    ? 'https://sis.redsys.es/sis/realizarPago'
    : 'https://sis-t.redsys.es:25443/sis/realizarPago';

// URL de tu Webflow (para redirecciones)
const FRONTEND =
  process.env.FRONTEND_BASE_URL ||
  'https://www.grupomoterodescubridoreshuelva.com';

// ---- Utils ----
function toBase64(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

// 3DES-CBC con IV=0 y ZERO-PADDING sobre Order
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

function signParams(paramsBase64, order, merchantKeyB64) {
  const k = deriveKey(order, merchantKeyB64);
  return crypto.createHmac('sha256', k).update(paramsBase64).digest('base64');
}

// Genera un número de pedido único de 12 dígitos
function normalizeOrder() {
  const timestamp = Date.now().toString().slice(-9);
  const rand = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return (timestamp + rand).slice(0, 12);
}

// ---- Handler ----
export default async function handler(req, res) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  const base = `${proto}://${host}`;

  const amount = PRICE_CENTS;
  const order = normalizeOrder();

  const params = {
    DS_MERCHANT_AMOUNT: amount,
    DS_MERCHANT_ORDER: order,
    DS_MERCHANT_MERCHANTCODE: MERCHANT_CODE,
    DS_MERCHANT_CURRENCY: '978',
    DS_MERCHANT_TRANSACTIONTYPE: '0',
    DS_MERCHANT_TERMINAL: TERMINAL,
    DS_MERCHANT_MERCHANTURL: `${base}/api/redsys/notificacion`,
    DS_MERCHANT_URLOK: `${FRONTEND}/checkout/gracias`,
    DS_MERCHANT_URLKO: `${FRONTEND}/checkout/error`,
  };

  const Ds_MerchantParameters = toBase64(params);
  const Ds_Signature = signParams(Ds_MerchantParameters, params.DS_MERCHANT_ORDER, SECRET_KEY);

  // Logs básicos
  console.log('=== NUEVA OPERACIÓN REDSYS (estable) ===');
  console.log('Order:', order);
  console.log('Amount (cents):', amount);
  console.log('Params:', params);

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
