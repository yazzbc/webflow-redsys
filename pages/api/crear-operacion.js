// pages/api/crear-operacion.js
import crypto from 'crypto';

// ---- Config (sandbox por defecto) ----
const MERCHANT_CODE = process.env.REDSYS_MERCHANT_CODE || '999008881'; // FUC pruebas
const TERMINAL = process.env.REDSYS_TERMINAL || '1';                   // en test suele ser "1"
const SECRET_KEY =
  process.env.REDSYS_SECRET_KEY || 'sq7HjrUOBfKmC576ILgskD5srU870gJ7'; // clave (Base64) pruebas
const ENV = process.env.REDSYS_ENV || 'test';

// Importe fijo (en céntimos) controlado por variable de entorno:
const PRICE_CENTS = String(process.env.PRICE_CENTS || '3000'); // <-- 3000 = 30,00 €

const REDSYS_URL =
  ENV === 'real'
    ? 'https://sis.redsys.es/sis/realizarPago'
    : 'https://sis-t.redsys.es:25443/sis/realizarPago';

// Para que el cliente VUELVA a tu Webflow:
const FRONTEND = process.env.FRONTEND_BASE_URL
  || 'https://www.grupomoterodescubridoreshuelva.com';

// ---- Utils ----
function toBase64(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64'); // sin CR/LF
}

// 3DES-CBC con IV=0 y ZERO-PADDING sobre Ds_Merchant_Order (como la librería oficial)
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
  return crypto.createHmac('sha256', k).update(paramsBase64).digest('base64'); // Base64 estándar
}

// Normaliza pedido a 12 dígitos (empieza por dígitos)
function normalizeOrder(raw) {
  let s = String(raw || '').replace(/\D/g, '');
  if (s.length < 4) s = (Date.now() + '').slice(-12);
  if (s.length > 12) s = s.slice(0, 12);
  return s;
}

export default function handler(req, res) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  const base = `${proto}://${host}`; // Vercel: aquí recibimos la notificación firmada

  // ✅ Fijamos el importe desde variable de entorno (no aceptamos amount por URL)
  const amount = PRICE_CENTS;
  // El order puedes pasarlo por query si quieres, si no lo generamos:
  const order  = normalizeOrder(req.query.order || Date.now());

  // Parámetros en MAYÚSCULAS (como en ejemplos oficiales)
  const params = {
    DS_MERCHANT_AMOUNT: amount,                 // céntimos (fijo desde backend)
    DS_MERCHANT_ORDER: order,                   // 4–12 dígitos
    DS_MERCHANT_MERCHANTCODE: MERCHANT_CODE,
    DS_MERCHANT_CURRENCY: '978',                // EUR
    DS_MERCHANT_TRANSACTIONTYPE: '0',
    DS_MERCHANT_TERMINAL: TERMINAL,
    DS_MERCHANT_MERCHANTURL: `${base}/api/redsys/notificacion`,     // servidor↔servidor (Vercel)
    DS_MERCHANT_URLOK: `${FRONTEND}/checkout/gracias`,              // Webflow OK
    DS_MERCHANT_URLKO: `${FRONTEND}/checkout/error`,                // Webflow KO
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


