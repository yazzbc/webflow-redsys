// pages/api/crear-operacion.js
import crypto from 'crypto';

// 🚨 Necesario para que Vercel no intente parsear el body antes
export const config = { api: { bodyParser: false } };

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

export default async function handler(req, res) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  const base = `${proto}://${host}`;

  // ✅ Leer nombre y email enviados desde el formulario de Webflow
  let nombre = '';
  let email = '';

  if (req.method === 'POST') {
    const raw = await new Promise((resolve) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => resolve(data));
    });
    const paramsForm = new URLSearchParams(raw);
    nombre = paramsForm.get('nombre') || '';
    email = paramsForm.get('email') || '';
  }

  // ✅ Fijamos el importe desde variable de entorno
  const amount = PRICE_CENTS;
  const order = normalizeOrder(Date.now());

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

    // 👉 Aquí guardamos nombre/email en MerchantData
    DS_MERCHANT_MERCHANTDATA: JSON.stringify({ nombre, email }),
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
