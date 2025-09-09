// pages/api/crear-operacion.js
import crypto from 'crypto';

// ---- Config (sandbox por defecto) ----
const MERCHANT_CODE = process.env.REDSYS_MERCHANT_CODE || '999008881'; // FUC pruebas
const TERMINAL = process.env.REDSYS_TERMINAL || '1';                   // en test suele ser "1"
const SECRET_KEY =
  process.env.REDSYS_SECRET_KEY || 'sq7HjrUOBfKmC576ILgskD5srU870gJ7'; // clave (Base64) pruebas
const ENV = process.env.REDSYS_ENV || 'test';

const REDSYS_URL =
  ENV === 'real'
    ? 'https://sis.redsys.es/sis/realizarPago'
    : 'https://sis-t.redsys.es:25443/sis/realizarPago';

// ---- Utils ----

// Base64 del JSON sin retornos de carro (como pide el manual)
function toBase64(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

// 3DES-CBC con IV=0 y ZERO-PADDING sobre Ds_Merchant_Order (igual que la librería oficial)
function deriveKey(order, merchantKeyB64) {
  const key = Buffer.from(merchantKeyB64, 'base64'); // 24 bytes
  const iv = Buffer.alloc(8, 0);

  // ZERO-PADDING a múltiplo de 8 bytes
  const data = Buffer.from(order, 'utf8');
  const padLen = 8 - (data.length % 8 || 8);
  const padded = Buffer.concat([data, Buffer.alloc(padLen, 0)]);

  const cipher = crypto.createCipheriv('des-ede3-cbc', key, iv);
  cipher.setAutoPadding(false); // usamos nuestro padding a 0x00
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

// HMAC-SHA256 sobre el Base64 de Ds_MerchantParameters con la clave derivada
function signParams(paramsBase64, order, merchantKeyB64) {
  const k = deriveKey(order, merchantKeyB64);
  return crypto.createHmac('sha256', k).update(paramsBase64).digest('base64'); // Base64 estándar
}

// Normaliza pedido: 12 dígitos (empieza por dígitos)
function normalizeOrder(raw) {
  let s = String(raw || '').replace(/\D/g, '');
  if (s.length < 4) s = (Date.now() + '').slice(-12);
  if (s.length > 12) s = s.slice(0, 12);
  return s;
}

export default function handler(req, res) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  const base = `${proto}://${host}`;

  // Valores por defecto si no se pasan por query
  const amount = String(req.query.amount || '249');       // céntimos (2,49 €)
  const order  = normalizeOrder(req.query.order || Date.now());

  // --- IMPORTANTE: claves en MAYÚSCULAS (como los ejemplos del manual) ---
  // Campos mínimos: Amount, Order, MerchantCode, Currency, TransactionType, Terminal,
  // MerchantURL/URLOK/URLKO (ver ejemplos del PDF) :contentReference[oaicite:2]{index=2}
  const params = {
    DS_MERCHANT_AMOUNT: amount,                 // céntimos
    DS_MERCHANT_ORDER: order,                   // 4–12 dígitos
    DS_MERCHANT_MERCHANTCODE: MERCHANT_CODE,
    DS_MERCHANT_CURRENCY: '978',                // EUR
    DS_MERCHANT_TRANSACTIONTYPE: '0',
    DS_MERCHANT_TERMINAL: TERMINAL,
    DS_MERCHANT_MERCHANTURL: `${base}/api/redsys/notificacion`,
    DS_MERCHANT_URLOK: `${base}/pago-ok`,
    DS_MERCHANT_URLKO: `${base}/pago-ko`,
  };

  const Ds_MerchantParameters = toBase64(params);
  const Ds_Signature = signParams(Ds_MerchantParameters, params.DS_MERCHANT_ORDER, SECRET_KEY);

  // Formulario de Redirección (3 campos exactos + URL de pruebas) :contentReference[oaicite:3]{index=3}
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
