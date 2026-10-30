'use strict';

/* JWT Debugger: decode, verify, create and sign JSON Web Tokens entirely in the browser.
   Crypto is done with the built-in Web Crypto API. Tokens and keys are never sent anywhere
   and never stored; only the theme choice is saved. */

const $ = (id) => document.getElementById(id);
const utf8 = new TextEncoder();
const subtle = window.crypto && window.crypto.subtle;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function flash(button, text) {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.textContent = text;
  clearTimeout(button._flash);
  button._flash = setTimeout(() => { button.textContent = button.dataset.label; }, 1200);
}

async function copyText(button, text) {
  try {
    await navigator.clipboard.writeText(text);
    flash(button, 'Copied');
  } catch {
    flash(button, 'Blocked');
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${label} is not valid JSON: ${e.message}`);
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- Base64 ----

function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
const bytesToB64url = (bytes) => bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToBytes(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('has characters that are not allowed in base64url');
  if (s.length % 4 === 1) throw new Error('has an impossible length (it may be cut off)');
  return b64ToBytes(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
}

// Standard or URL-safe base64, with or without padding and line breaks.
const looseB64ToBytes = (s) =>
  b64urlToBytes(s.replace(/\s+/g, '').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'));

const decodeUtf8 = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const encodeJson = (value) => bytesToB64url(utf8.encode(JSON.stringify(value)));

// ---- Token parsing ----

const BEARER = /^\s*bearer\s+/i;
const cleanToken = (raw) => raw.replace(BEARER, '').replace(/\s+/g, '');

// Decodes each part independently, so a damaged token still shows whatever can be read.
function parseToken(raw) {
  const token = cleanToken(raw);
  const t = { token, errors: [] };
  if (!token) return t;
  const parts = token.split('.');
  if (parts.length === 5) {
    t.errors.push('This is an encrypted token (JWE, five parts). Only signed tokens (three parts) can be decoded here.');
    return t;
  }
  if (parts.length !== 3) t.errors.push(`A JWT has three parts separated by dots; this one has ${parts.length}.`);

  function decodePart(i, label) {
    if (parts[i] === undefined) return undefined;
    let bytes;
    try {
      bytes = b64urlToBytes(parts[i]);
    } catch (e) {
      t.errors.push(`${label} ${e.message}.`);
      return undefined;
    }
    if (i === 2) return bytes;
    try {
      return decodeUtf8(bytes);
    } catch {
      t.errors.push(`${label} is not valid UTF-8 text.`);
      return undefined;
    }
  }

  const headerText = decodePart(0, 'The header');
  if (headerText !== undefined) {
    let header;
    try { header = JSON.parse(headerText); } catch { /* reported below */ }
    if (isObject(header)) t.header = header;
    else {
      t.errors.push(header === undefined ? 'The header is not valid JSON.' : 'The header must be a JSON object.');
      t.headerText = headerText;
    }
  }
  const payloadText = decodePart(1, 'The payload');
  if (payloadText !== undefined) {
    try { t.payload = JSON.parse(payloadText); } catch { t.payloadText = payloadText; } // a JWS payload may be any text
  }
  if (parts.length === 3) {
    t.signature = decodePart(2, 'The signature');
    t.signingInput = parts[0] + '.' + parts[1];
  }
  return t;
}

// ---- Algorithms ----

const ALGS = {
  HS256: { kind: 'hmac', hash: 'SHA-256', bytes: 32, label: 'HMAC with SHA-256' },
  HS384: { kind: 'hmac', hash: 'SHA-384', bytes: 48, label: 'HMAC with SHA-384' },
  HS512: { kind: 'hmac', hash: 'SHA-512', bytes: 64, label: 'HMAC with SHA-512' },
  RS256: { kind: 'rsa', name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', label: 'RSA PKCS#1 v1.5 with SHA-256' },
  RS384: { kind: 'rsa', name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384', label: 'RSA PKCS#1 v1.5 with SHA-384' },
  RS512: { kind: 'rsa', name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512', label: 'RSA PKCS#1 v1.5 with SHA-512' },
  PS256: { kind: 'rsa', name: 'RSA-PSS', hash: 'SHA-256', saltLength: 32, label: 'RSA-PSS with SHA-256' },
  PS384: { kind: 'rsa', name: 'RSA-PSS', hash: 'SHA-384', saltLength: 48, label: 'RSA-PSS with SHA-384' },
  PS512: { kind: 'rsa', name: 'RSA-PSS', hash: 'SHA-512', saltLength: 64, label: 'RSA-PSS with SHA-512' },
  ES256: { kind: 'ec', curve: 'P-256', hash: 'SHA-256', size: 32, label: 'ECDSA with P-256 and SHA-256' },
  ES384: { kind: 'ec', curve: 'P-384', hash: 'SHA-384', size: 48, label: 'ECDSA with P-384 and SHA-384' },
  ES512: { kind: 'ec', curve: 'P-521', hash: 'SHA-512', size: 66, label: 'ECDSA with P-521 and SHA-512' },
  EdDSA: { kind: 'okp', label: 'EdDSA with Ed25519' },
  Ed25519: { kind: 'okp', label: 'Ed25519' },
};
const KTY = { hmac: 'oct', rsa: 'RSA', ec: 'EC', okp: 'OKP' };
const PRIVATE_JWK_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'];

function importParams(a) {
  switch (a.kind) {
    case 'hmac': return { name: 'HMAC', hash: a.hash };
    case 'rsa': return { name: a.name, hash: a.hash };
    case 'ec': return { name: 'ECDSA', namedCurve: a.curve };
    default: return { name: 'Ed25519' };
  }
}

function signParams(a) {
  switch (a.kind) {
    case 'hmac': return { name: 'HMAC' };
    case 'rsa': return a.saltLength ? { name: a.name, saltLength: a.saltLength } : { name: a.name };
    case 'ec': return { name: 'ECDSA', hash: a.hash };
    default: return { name: 'Ed25519' };
  }
}

function generateParams(a) {
  switch (a.kind) {
    case 'rsa': return { name: a.name, hash: a.hash, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) };
    case 'ec': return { name: 'ECDSA', namedCurve: a.curve };
    default: return { name: 'Ed25519' };
  }
}

// Keys that work for one algorithm also work for others in the same family.
function keyFamily(alg) {
  const a = ALGS[alg];
  if (!a) return alg;
  return a.kind === 'ec' ? `ec:${a.curve}` : a.kind;
}

function friendlyCryptoError(e, alg) {
  if (e && e.name === 'NotSupportedError') return `This browser's Web Crypto does not support ${alg}.`;
  return `This key does not work with ${alg}${e && e.message ? ` (${e.message})` : ''}. Check that it is the right type and size for the algorithm.`;
}

// ---- Minimal DER, enough to convert older PEM formats to the ones Web Crypto imports ----

function derRead(b, pos) {
  if (pos + 2 > b.length) throw new Error('The key data is cut off or malformed.');
  const tag = b[pos];
  let len = b[pos + 1];
  let p = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4) throw new Error('The key data is cut off or malformed.');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p++];
  }
  if (p + len > b.length) throw new Error('The key data is cut off or malformed.');
  return { tag, start: pos, body: p, end: p + len };
}

function derChildren(b, el) {
  const out = [];
  for (let p = el.body; p < el.end;) {
    const child = derRead(b, p);
    out.push(child);
    p = child.end;
  }
  return out;
}

function concatBytes(...arrays) {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let p = 0;
  for (const a of arrays) { out.set(a, p); p += a.length; }
  return out;
}

function der(tag, ...contents) {
  const body = concatBytes(...contents);
  const n = body.length;
  const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 0xff] : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff];
  return concatBytes(new Uint8Array([tag, ...len]), body);
}

const RSA_ALGORITHM_ID = der(0x30, new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]));
const EC_PUBLIC_KEY_OID = new Uint8Array([0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);
const VERSION_0 = new Uint8Array([0x02, 0x01, 0x00]);

function certificateToSpki(b) {
  const tbs = derChildren(b, derRead(b, 0))[0];
  const fields = derChildren(b, tbs);
  const i = fields[0] && fields[0].tag === 0xa0 ? 1 : 0; // optional [0] version
  const spki = fields[i + 5]; // serial, signature, issuer, validity, subject, subjectPublicKeyInfo
  if (!spki || spki.tag !== 0x30) throw new Error('No public key was found in the certificate.');
  return b.slice(spki.start, spki.end);
}

const rsaPublicToSpki = (pkcs1) => der(0x30, RSA_ALGORITHM_ID, der(0x03, new Uint8Array([0]), pkcs1));
const rsaPrivateToPkcs8 = (pkcs1) => der(0x30, VERSION_0, RSA_ALGORITHM_ID, der(0x04, pkcs1));

function ecPrivateToPkcs8(sec1) {
  const params = derChildren(sec1, derRead(sec1, 0)).find((c) => c.tag === 0xa0);
  if (!params) throw new Error('The EC key does not say which curve it uses.');
  const curve = derChildren(sec1, params)[0];
  return der(0x30, VERSION_0, der(0x30, EC_PUBLIC_KEY_OID, sec1.slice(curve.start, curve.end)), der(0x04, sec1));
}

function parsePem(text) {
  const m = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(text);
  if (!m) return null;
  if (/Proc-Type:\s*4,ENCRYPTED/.test(m[2])) return { label: 'ENCRYPTED PRIVATE KEY' };
  try {
    return { label: m[1], der: b64ToBytes(m[2].replace(/\s+/g, '')) };
  } catch {
    throw new Error('The PEM block is not valid base64.');
  }
}

function toPem(buffer, label) {
  const b64 = bytesToB64(new Uint8Array(buffer));
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----`;
}

// ---- Keys ----

function pickFromJwks(keys, header, alg) {
  if (header.kid !== undefined) {
    const key = keys.find((k) => k && k.kid === header.kid);
    if (!key) throw new Error(`No key in this JWKS has kid "${header.kid}", the token's kid.`);
    return { jwk: key, note: `Using the key with kid "${header.kid}" from the JWKS.` };
  }
  const fits = keys.filter((k) => k && (k.alg ? k.alg === alg : k.kty === KTY[ALGS[alg].kind]) && k.use !== 'enc');
  if (fits.length === 1) return { jwk: fits[0], note: 'Using the only matching key in the JWKS.' };
  throw new Error(fits.length
    ? 'This JWKS has several matching keys and the token has no "kid" to choose between them. Paste just one key.'
    : `No key in this JWKS fits ${alg}.`);
}

async function importJwk(jwk, alg, usage) {
  const a = ALGS[alg];
  if (!isObject(jwk)) throw new Error('The key is JSON but not a JWK object.');
  if (jwk.kty !== KTY[a.kind]) {
    throw new Error(`${alg} needs an ${KTY[a.kind]} key, but this JWK is ${jwk.kty ? `kty "${jwk.kty}"` : 'missing "kty"'}.`);
  }
  const clean = { ...jwk };
  for (const f of ['alg', 'key_ops', 'use', 'ext']) delete clean[f];
  if (usage === 'verify') PRIVATE_JWK_FIELDS.forEach((f) => delete clean[f]);
  else if (!clean.d) throw new Error('This JWK has no private part ("d"). Signing needs the private key.');
  try {
    return await subtle.importKey('jwk', clean, importParams(a), true, [usage]);
  } catch (e) {
    throw new Error(friendlyCryptoError(e, alg));
  }
}

async function publicJwkOf(key) {
  const jwk = await subtle.exportKey('jwk', key);
  const pub = {};
  for (const f of ['kty', 'crv', 'n', 'e', 'x', 'y']) if (jwk[f] !== undefined) pub[f] = jwk[f];
  return pub;
}

// Turns pasted key text into a CryptoKey for `usage` ('sign' or 'verify').
// Returns { key, note }, where the note says how the text was read.
async function loadKey(text, alg, usage, { b64 = false, header = {} } = {}) {
  const a = ALGS[alg];
  const params = importParams(a);
  const trimmed = text.trim();

  if (a.kind === 'hmac') {
    let bytes;
    let note = '';
    if (trimmed.startsWith('{')) {
      const jwk = parseJson(trimmed, 'The key');
      if (!isObject(jwk) || jwk.kty !== 'oct' || typeof jwk.k !== 'string') {
        throw new Error(`${alg} needs a shared secret; this JSON is not a symmetric ("oct") JWK.`);
      }
      bytes = b64urlToBytes(jwk.k);
      note = 'Read as a JWK. ';
    } else if (b64) {
      try {
        bytes = looseB64ToBytes(trimmed);
      } catch (e) {
        throw new Error(`The secret is not valid base64: it ${e.message}.`);
      }
    } else {
      bytes = utf8.encode(text);
      if (/-----BEGIN /.test(text)) note = `This looks like a PEM key, but ${alg} uses a shared secret, so it is treated as plain text. `;
    }
    if (!bytes.length) throw new Error('The secret is empty.');
    note += `${bytes.length}-byte secret`;
    if (bytes.length < a.bytes) note += `: shorter than the ${a.bytes} bytes ${alg} calls for, which makes it easier to guess`;
    return { key: await subtle.importKey('raw', bytes, params, false, [usage]), note: note + '.' };
  }

  if (trimmed.startsWith('{')) {
    let jwk = parseJson(trimmed, 'The key');
    let note = 'Read as a JWK.';
    if (isObject(jwk) && Array.isArray(jwk.keys)) ({ jwk, note } = pickFromJwks(jwk.keys, header, alg));
    return { key: await importJwk(jwk, alg, usage), note };
  }

  const pem = parsePem(trimmed);
  if (!pem) {
    throw new Error(usage === 'verify'
      ? 'Paste a public key: PEM ("-----BEGIN PUBLIC KEY-----"), a certificate, a JWK or a JWKS.'
      : 'Paste a private key: PEM ("-----BEGIN PRIVATE KEY-----") or a JWK that includes "d".');
  }
  let spki, pkcs8, note;
  switch (pem.label) {
    case 'PUBLIC KEY': spki = pem.der; note = 'Read as a PEM public key.'; break;
    case 'RSA PUBLIC KEY': spki = rsaPublicToSpki(pem.der); note = 'Read as a PKCS#1 RSA public key.'; break;
    case 'CERTIFICATE': spki = certificateToSpki(pem.der); note = "Using the certificate's public key. The certificate's dates and issuer are not checked."; break;
    case 'PRIVATE KEY': pkcs8 = pem.der; note = 'Read as a PEM private key.'; break;
    case 'RSA PRIVATE KEY': pkcs8 = rsaPrivateToPkcs8(pem.der); note = 'Read as a PKCS#1 RSA private key.'; break;
    case 'EC PRIVATE KEY': pkcs8 = ecPrivateToPkcs8(pem.der); note = 'Read as an EC private key.'; break;
    case 'ENCRYPTED PRIVATE KEY':
      throw new Error('Password-protected keys are not supported. Remove the password first, for example: openssl pkey -in key.pem -out plain.pem');
    default:
      throw new Error(`"${pem.label}" PEM blocks are not supported.`);
  }
  if (spki && usage === 'sign') throw new Error('This is a public key. Signing needs the matching private key.');
  try {
    if (spki) return { key: await subtle.importKey('spki', spki, params, true, ['verify']), note };
    const priv = await subtle.importKey('pkcs8', pkcs8, params, true, ['sign']);
    if (usage === 'sign') return { key: priv, note };
    // Verifying with a private key: use its public half.
    const pub = await subtle.importKey('jwk', await publicJwkOf(priv), params, true, ['verify']);
    return { key: pub, note: 'Using the public half of this private key.' };
  } catch (e) {
    throw new Error(friendlyCryptoError(e, alg));
  }
}

// ---- Claims and times ----

const HEADER_INFO = {
  alg: 'Algorithm used to sign the token',
  typ: 'Type of token, usually "JWT"',
  cty: 'Content type of the payload',
  kid: 'Key ID: which key signed the token',
  jku: 'URL of a key set (JWKS) holding the signing key. Never fetched here.',
  jwk: 'The public key itself, embedded in the header',
  x5u: 'URL of the signing certificate. Never fetched here.',
  x5c: 'Certificate chain of the signing key',
  x5t: 'SHA-1 thumbprint of the signing certificate',
  'x5t#S256': 'SHA-256 thumbprint of the signing certificate',
  crit: 'Header extensions the receiver must understand',
  b64: 'Whether the payload is base64url-encoded (RFC 7797)',
};

const CLAIM_INFO = {
  iss: 'Issuer: who created and signed the token',
  sub: 'Subject: who the token is about, usually a user ID',
  aud: 'Audience: who the token is meant for',
  exp: 'Expiration time: reject the token after this',
  nbf: 'Not before: reject the token before this',
  iat: 'Issued at: when the token was created',
  jti: 'JWT ID: a unique ID, used to stop replays',
  azp: 'Authorized party: the client the token was issued to',
  client_id: 'The OAuth client the token was issued to',
  scope: 'Scopes granted, separated by spaces',
  scp: 'Scopes granted',
  nonce: 'Ties an ID token to the login request that asked for it',
  auth_time: 'When the user actually signed in',
  sid: 'Session ID',
  acr: 'Authentication context class: how strongly the user signed in',
  amr: 'Authentication methods used, such as pwd or mfa',
  at_hash: 'Hash of the access token issued alongside this ID token',
  c_hash: 'Hash of the authorization code',
  cnf: 'Confirmation: the key the token is bound to',
  act: 'Actor: who is acting on behalf of the subject',
  name: 'Full name',
  given_name: 'Given (first) name',
  family_name: 'Family (last) name',
  nickname: 'Nickname',
  preferred_username: 'Preferred username',
  email: 'Email address',
  email_verified: 'Whether the email address was verified',
  phone_number: 'Phone number',
  picture: 'Profile picture URL',
  locale: 'Preferred language',
  zoneinfo: 'Time zone',
  updated_at: "When the user's profile was last updated",
  roles: 'Roles granted',
  groups: 'Groups the user belongs to',
  permissions: 'Permissions granted',
  tid: 'Tenant ID (Microsoft Entra ID)',
  oid: "User's object ID (Microsoft Entra ID)",
  upn: 'User principal name (Microsoft)',
  admin: 'Whether the user is an administrator (custom claim)',
};

const TIME_CLAIMS = new Set(['exp', 'nbf', 'iat', 'auth_time', 'updated_at']);
const nowSec = () => Math.floor(Date.now() / 1000);
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

function relTime(sec) {
  const diff = sec - nowSec();
  const abs = Math.abs(diff);
  if (abs < 5) return 'just now';
  const units = [[31557600, 'year'], [86400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second']];
  for (const [size, name] of units) {
    if (abs >= size) {
      const n = Math.floor(abs / size);
      const s = `${n} ${name}${n === 1 ? '' : 's'}`;
      return diff > 0 ? `in ${s}` : `${s} ago`;
    }
  }
  return '';
}

function describeTime(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || Math.abs(sec) > 8e12) return null;
  const d = new Date(sec * 1000);
  return { local: dateFormat.format(d), iso: d.toISOString(), rel: relTime(sec) };
}

function timeChecks(p) {
  if (!isObject(p)) return [];
  const out = [];
  const now = nowSec();
  for (const c of ['exp', 'nbf', 'iat']) {
    if (!(c in p)) continue;
    if (typeof p[c] !== 'number') out.push({ level: 'warn', text: `"${c}" should be a number of seconds since 1970, not ${typeof p[c] === 'string' ? 'a string' : JSON.stringify(p[c])}.` });
    else if (p[c] > 1e11) out.push({ level: 'warn', text: `"${c}" looks like milliseconds; JWT times are in seconds.` });
  }
  const num = (c) => (typeof p[c] === 'number' ? p[c] : undefined);
  const exp = num('exp');
  const nbf = num('nbf');
  const iat = num('iat');
  if (exp !== undefined && exp <= now) out.push({ level: 'bad', text: `Expired ${relTime(exp)}.` });
  if (nbf !== undefined && nbf > now) out.push({ level: 'bad', text: `Not valid yet: it becomes valid ${relTime(nbf)}.` });
  if (iat !== undefined && iat > now + 60) out.push({ level: 'warn', text: `Issued in the future (${relTime(iat)}). Check the issuer's clock.` });
  if (!out.some((o) => o.level === 'bad')) {
    if (exp !== undefined) out.unshift({ level: 'ok', text: `Not expired: it expires ${relTime(exp)}.` });
    else out.unshift({ level: 'info', text: 'No "exp" claim, so this token never expires.' });
  }
  return out;
}

// Pretty JSON with colours. Top-level keys get their description as a tooltip, and time values their date.
function highlightJson(value, info) {
  const json = JSON.stringify(value, null, 2);
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let out = '';
  let last = 0;
  let topKey = null;
  for (const m of json.matchAll(re)) {
    out += escapeHtml(json.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2]) {
      const indent = m.index - json.lastIndexOf('\n', m.index) - 1;
      const name = JSON.parse(m[1]);
      topKey = indent === 2 ? name : null;
      const title = topKey !== null && info[name] ? ` title="${escapeHtml(info[name])}"` : '';
      out += `<span class="j-key"${title}>${escapeHtml(m[1])}</span>${m[2]}`;
      continue;
    }
    if (m[1]) out += `<span class="j-str">${escapeHtml(m[1])}</span>`;
    else if (m[3]) out += `<span class="j-lit">${m[3]}</span>`;
    else {
      const t = topKey !== null && TIME_CLAIMS.has(topKey) ? describeTime(Number(m[0])) : null;
      const title = t ? ` title="${escapeHtml(`${t.local} (${t.rel})\n${t.iso}`)}"` : '';
      out += `<span class="j-num"${title}>${m[0]}</span>`;
    }
    topKey = null;
  }
  return out + escapeHtml(json.slice(last));
}

function claimValueHtml(name, value) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  let html = escapeHtml(raw);
  const t = TIME_CLAIMS.has(name) ? describeTime(value) : null;
  if (t) {
    const late = name === 'exp' && value <= nowSec();
    html += `<div class="sub${late ? ' bad' : ''}" title="${escapeHtml(t.iso)}">${escapeHtml(t.local)} · ${escapeHtml(t.rel)}</div>`;
  } else if (name === 'scope' && typeof value === 'string' && value.includes(' ')) {
    html += `<div class="sub">${value.trim().split(/\s+/).length} scopes</div>`;
  }
  return html;
}

// ---- Coloured token text ----

function tokenColorsHtml(raw, forEditor = true) {
  let html = '';
  let rest = raw;
  const bearer = BEARER.exec(raw);
  if (bearer) {
    html += `<span class="bearer">${escapeHtml(bearer[0])}</span>`;
    rest = raw.slice(bearer[0].length);
  }
  let part = 0;
  for (const piece of rest.split(/(\.)/)) {
    if (piece === '.') {
      html += '<span class="dot">.</span>';
      part++;
    } else if (piece) {
      html += `<span class="${part < 3 ? `p${part}` : 'px'}">${escapeHtml(piece)}</span>`;
    }
  }
  // In the editor overlay, a trailing space keeps the last line's height when the text ends with a newline.
  return forEditor ? html + ' ' : html;
}

// ---- Decode & verify ----

let parsed = parseToken('');
let verifyGen = 0;

function onTokenInput() {
  $('token-colors').innerHTML = tokenColorsHtml($('token').value);
  syncTokenScroll();
  parsed = parseToken($('token').value);
  renderDecoded();
  runVerify();
}

function syncTokenScroll() {
  $('token-colors').scrollTop = $('token').scrollTop;
}

function renderDecoded() {
  const t = parsed;
  $('token-meta').textContent = t.token ? `${t.token.length} characters` : '';
  $('token-error').hidden = !t.errors.length;
  $('token-error').innerHTML = t.errors.map(escapeHtml).join('<br>');
  $('token-copy').disabled = !t.token;
  $('token-to-encoder').disabled = !t.header;

  const alg = t.header && t.header.alg;
  const a = ALGS[alg];
  $('header-meta').textContent = typeof alg === 'string' ? (a ? a.label : alg === 'none' ? 'unsigned' : `${alg} (not supported here)`) : '';
  $('header-json').innerHTML = t.header ? highlightJson(t.header, HEADER_INFO)
    : t.headerText !== undefined ? escapeHtml(t.headerText) : '<span class="empty">Nothing to show</span>';
  $('header-copy').disabled = !t.header;

  if (t.payload !== undefined) {
    $('payload-json').innerHTML = highlightJson(t.payload, CLAIM_INFO);
    $('payload-meta').textContent = '';
  } else if (t.payloadText !== undefined) {
    $('payload-json').textContent = t.payloadText;
    $('payload-meta').textContent = 'not JSON; shown as text';
  } else {
    $('payload-json').innerHTML = '<span class="empty">Nothing to show</span>';
    $('payload-meta').textContent = '';
  }
  $('payload-copy').disabled = t.payload === undefined && t.payloadText === undefined;

  renderClaims();
  renderTimeChecks();
  updateVerifyUi();
}

function renderClaims() {
  const p = parsed.payload;
  const rows = isObject(p) ? Object.keys(p).map((name) => `<tr>
      <td><code>${escapeHtml(name)}</code></td>
      <td class="value">${claimValueHtml(name, p[name])}</td>
      <td class="desc">${escapeHtml(CLAIM_INFO[name] || '')}</td>
    </tr>`) : [];
  $('claims').innerHTML = rows.length ? rows.join('')
    : `<tr><td class="empty">${parsed.token ? 'The payload has no claims to list.' : 'Paste a token to see its claims.'}</td></tr>`;
}

function renderTimeChecks() {
  $('time-status').innerHTML = timeChecks(parsed.payload)
    .map((c) => `<li class="${c.level}">${escapeHtml(c.text)}</li>`).join('');
}

function updateVerifyUi() {
  const header = parsed.header || {};
  const alg = header.alg;
  const a = ALGS[alg];
  const hmac = !a || a.kind === 'hmac';
  $('verify-alg').textContent = typeof alg === 'string' ? alg : '';
  $('verify-key-label').textContent = hmac ? 'Shared secret' : 'Public key';
  $('verify-b64-label').hidden = !hmac;
  $('verify-key').placeholder = hmac
    ? 'The secret the token was signed with'
    : 'Public key: PEM (-----BEGIN PUBLIC KEY-----), certificate, JWK or JWKS';

  // Offer keys embedded in the header, with a warning: anyone can put a key there.
  const helpers = [];
  if (a && !hmac && Array.isArray(header.x5c) && typeof header.x5c[0] === 'string') {
    helpers.push('<button data-use="x5c">Use the certificate from the header (x5c)</button>');
  }
  if (a && !hmac && isObject(header.jwk)) helpers.push('<button data-use="jwk">Use the key from the header (jwk)</button>');
  $('verify-helpers').hidden = !helpers.length;
  $('verify-helpers').innerHTML = helpers.length
    ? `<div>${helpers.join('')}</div><span>Only rely on this if you already trust that key: anyone can put a key in a token's header.</span>`
    : '';
}

$('verify-helpers').addEventListener('click', (e) => {
  const use = e.target.closest('button') && e.target.closest('button').dataset.use;
  if (!use) return;
  const header = parsed.header;
  $('verify-key').value = use === 'x5c'
    ? toPem(b64ToBytes(header.x5c[0].replace(/\s+/g, '')), 'CERTIFICATE')
    : JSON.stringify(header.jwk, null, 2);
  runVerify();
});

async function computeVerdict(t) {
  if (!t.token) return { state: 'idle', text: 'Paste a token to decode and verify it.' };
  if (!t.header || t.signature === undefined) return { state: 'bad', text: 'The token could not be fully decoded, so its signature cannot be checked.' };
  const alg = t.header.alg;
  if (typeof alg !== 'string') return { state: 'bad', text: 'The header has no "alg", so the signature cannot be checked.' };
  if (alg.toLowerCase() === 'none') {
    return t.signature.length
      ? { state: 'bad', text: 'The header says "alg": "none" but the token has a signature. Reject it.' }
      : { state: 'warn', text: 'Unsigned token ("alg": "none"). Anyone could have written it; never accept one.' };
  }
  const a = ALGS[alg];
  if (!a) return { state: 'warn', text: `"${alg}" is not supported here, so the signature cannot be checked.` };
  if (!subtle) return { state: 'warn', text: 'Web Crypto is not available on this page, so signatures cannot be checked. Open the page from a file or over https.' };
  const keyText = $('verify-key').value;
  if (!keyText.trim()) {
    return { state: 'idle', text: a.kind === 'hmac' ? 'Enter the shared secret to check the signature.' : 'Paste the public key to check the signature.' };
  }
  let key, note;
  try {
    ({ key, note } = await loadKey(keyText, alg, 'verify', { b64: $('verify-b64').checked, header: t.header }));
  } catch (e) {
    return { state: 'warn', text: e.message, keyProblem: true };
  }
  if (a.kind === 'ec' && t.signature.length !== a.size * 2) {
    return { state: 'bad', text: `Invalid signature: ${alg} signatures are ${a.size * 2} bytes, this one is ${t.signature.length}.`, note };
  }
  let ok;
  try {
    ok = await subtle.verify(signParams(a), key, t.signature, utf8.encode(t.signingInput));
  } catch (e) {
    return { state: 'warn', text: friendlyCryptoError(e, alg), note };
  }
  return ok
    ? { state: 'good', text: 'Signature verified.', note }
    : { state: 'bad', text: 'Invalid signature: the token was changed, or this is not the right key.', note };
}

async function runVerify() {
  const gen = ++verifyGen;
  const result = await computeVerdict(parsed);
  if (gen !== verifyGen) return;
  const verdict = $('verdict');
  verdict.className = `banner ${result.state}`;
  verdict.textContent = result.text;
  $('verify-hint').textContent = result.keyProblem ? result.text : result.note || '';
  $('verify-hint').classList.toggle('warn', !!result.keyProblem || /shorter than|looks like a PEM/.test(result.note || ''));
}

$('token').addEventListener('input', onTokenInput);
$('token').addEventListener('scroll', syncTokenScroll);
new ResizeObserver(syncTokenScroll).observe($('token'));
$('verify-key').addEventListener('input', runVerify);
$('verify-b64').addEventListener('change', runVerify);

function setToken(value) {
  $('token').value = value;
  onTokenInput();
}

$('token-paste').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  try {
    setToken(await navigator.clipboard.readText());
  } catch {
    flash(button, 'Blocked');
    $('token').focus();
  }
});
$('token-copy').addEventListener('click', (e) => copyText(e.currentTarget, parsed.token));
$('token-clear').addEventListener('click', () => { setToken(''); $('token').focus(); });
$('token-example').addEventListener('click', loadExample);
$('header-copy').addEventListener('click', (e) => copyText(e.currentTarget, JSON.stringify(parsed.header, null, 2)));
$('payload-copy').addEventListener('click', (e) => copyText(e.currentTarget,
  parsed.payload !== undefined ? JSON.stringify(parsed.payload, null, 2) : parsed.payloadText));

const EXAMPLE_SECRET = 'example-secret-change-me-0123456789abcdef';

async function loadExample() {
  const now = nowSec();
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { sub: '1234567890', name: 'Ana Example', admin: true, iat: now, exp: now + 3600 };
  const input = encodeJson(header) + '.' + encodeJson(payload);
  let signature = 'c2lnbmF0dXJl';
  if (subtle) {
    const { key } = await loadKey(EXAMPLE_SECRET, 'HS256', 'sign');
    signature = bytesToB64url(new Uint8Array(await subtle.sign('HMAC', key, utf8.encode(input))));
  }
  $('verify-key').value = EXAMPLE_SECRET;
  $('verify-b64').checked = false;
  setToken(`${input}.${signature}`);
}

// Keep relative times ("expires in 5 minutes") current.
setInterval(() => {
  if (!parsed.token || $('decode').hidden) return;
  renderTimeChecks();
  if (!window.getSelection().toString()) renderClaims();
}, 15000);

// ---- Encode & sign ----

let encodeGen = 0;
let encoded = {};
let encAlg = 'HS256';

const ALG_OPTIONS = [...Object.keys(ALGS), 'none'];
$('enc-alg').innerHTML = ALG_OPTIONS.map((alg) =>
  `<option value="${alg}">${alg === 'none' ? 'none (unsigned)' : `${alg} · ${ALGS[alg].label}`}</option>`).join('');

function updateEncodeKeyUi() {
  const a = ALGS[encAlg];
  const hmac = a && a.kind === 'hmac';
  $('enc-alg').value = encAlg;
  $('enc-key').disabled = !a;
  $('enc-key-label').textContent = !a ? 'No key needed' : hmac ? 'Shared secret' : 'Private key';
  $('enc-b64-label').hidden = !hmac;
  $('enc-key').placeholder = !a ? '"alg": "none" tokens are not signed.'
    : hmac ? 'Secret text, at least as long as the hash (32 bytes for HS256)'
    : 'Private key: PEM (-----BEGIN PRIVATE KEY-----) or a JWK that includes "d"';
  $('enc-generate').hidden = !a;
  $('enc-generate').textContent = hmac ? 'Generate secret' : 'Generate key pair';
  $('enc-generate').title = hmac ? 'Fill in a new random secret'
    : a ? `Make a new ${{ rsa: '2048-bit RSA', ec: a.curve, okp: 'Ed25519' }[a.kind]} key pair` : '';
  $('enc-key-meta').textContent = a ? (hmac ? 'shared secret' : 'private key; keep it secret') : '';
}

async function generateKey() {
  const a = ALGS[encAlg];
  if (!a || !subtle) {
    runEncode();
    return;
  }
  if (a.kind === 'hmac') {
    $('enc-key').value = bytesToB64url(crypto.getRandomValues(new Uint8Array(a.bytes)));
    $('enc-b64').checked = true;
  } else {
    const button = $('enc-generate');
    const before = $('enc-key').value;
    button.disabled = true;
    try {
      const pair = await subtle.generateKey(generateParams(a), true, ['sign', 'verify']);
      const pem = toPem(await subtle.exportKey('pkcs8', pair.privateKey), 'PRIVATE KEY');
      // Don't overwrite a key typed or pasted while this one was being made.
      if ($('enc-key').value !== before) return;
      $('enc-key').value = pem;
      $('enc-b64').checked = false;
    } catch (e) {
      $('enc-hint').textContent = friendlyCryptoError(e, encAlg);
      $('enc-hint').classList.add('warn');
      return;
    } finally {
      button.disabled = false;
    }
  }
  runEncode();
}

async function computeEncode() {
  const res = {};
  let header, payload;
  try {
    header = parseJson($('enc-header').value, 'The header');
    if (!isObject(header)) throw new Error('The header must be a JSON object.');
  } catch (e) {
    res.headerError = e.message;
  }
  try {
    payload = parseJson($('enc-payload').value, 'The payload');
  } catch (e) {
    res.payloadError = e.message;
  }
  if (res.headerError || res.payloadError) {
    res.error = 'Fix the JSON above to build the token.';
    return res;
  }
  res.input = encodeJson(header) + '.' + encodeJson(payload);
  const alg = header.alg;
  if (typeof alg !== 'string') {
    res.error = 'The header needs an "alg".';
    return res;
  }
  if (alg === 'none') {
    res.token = res.input + '.';
    res.warn = 'Unsigned token ("alg": "none"). Most libraries reject these, as they should.';
    return res;
  }
  const a = ALGS[alg];
  if (!a) {
    res.error = `"${alg}" is not supported here. Pick an algorithm from the list.`;
    return res;
  }
  if (!subtle) {
    res.error = 'Web Crypto is not available on this page, so tokens cannot be signed. Open the page from a file or over https.';
    return res;
  }
  const keyText = $('enc-key').value;
  if (!keyText.trim()) {
    res.error = a.kind === 'hmac' ? 'Enter a shared secret, or click Generate secret.' : 'Paste a private key, or click Generate key pair.';
    return res;
  }
  let key;
  try {
    ({ key, note: res.note } = await loadKey(keyText, alg, 'sign', { b64: $('enc-b64').checked, header }));
  } catch (e) {
    res.keyError = e.message;
    res.error = 'The token cannot be signed until the key problem below is fixed.';
    return res;
  }
  try {
    const signature = await subtle.sign(signParams(a), key, utf8.encode(res.input));
    res.token = res.input + '.' + bytesToB64url(new Uint8Array(signature));
  } catch (e) {
    res.keyError = friendlyCryptoError(e, alg);
    res.error = 'The token cannot be signed until the key problem below is fixed.';
    return res;
  }
  if (a.kind !== 'hmac') {
    const jwk = await publicJwkOf(key);
    const pub = await subtle.importKey('jwk', jwk, importParams(a), true, ['verify']);
    res.publicPem = toPem(await subtle.exportKey('spki', pub), 'PUBLIC KEY');
    res.publicJwk = { ...jwk, ...(header.kid !== undefined ? { kid: header.kid } : {}), use: 'sig', alg };
  }
  return res;
}

function showFieldError(id, text) {
  $(id).hidden = !text;
  $(id).textContent = text || '';
}

async function runEncode() {
  const gen = ++encodeGen;
  let res;
  try {
    res = await computeEncode();
  } catch (e) {
    res = { error: e.message };
  }
  if (gen !== encodeGen) return;
  encoded = res;
  showFieldError('enc-header-error', res.headerError);
  showFieldError('enc-payload-error', res.payloadError);

  const out = $('enc-token');
  if (res.token) out.innerHTML = tokenColorsHtml(res.token, false);
  else if (res.input) out.innerHTML = tokenColorsHtml(res.input + '.', false) + '<span class="missing">signature</span>';
  else out.innerHTML = '<span class="missing">No token yet</span>';
  $('enc-meta').textContent = res.token ? `${res.token.length} characters` : '';
  $('enc-copy').disabled = !res.token;
  $('enc-open').disabled = !res.token;

  const message = res.error || res.warn;
  $('enc-error').hidden = !message;
  $('enc-error').textContent = message || '';
  $('enc-error').className = `msg ${res.error ? 'bad' : 'warn'}`;

  $('enc-hint').textContent = res.keyError || res.note || '';
  $('enc-hint').classList.toggle('warn', !!res.keyError || /shorter than|looks like a PEM/.test(res.note || ''));

  $('enc-public-card').hidden = !res.publicPem;
  renderPublicKey();
}

function publicKeyText() {
  if (!encoded.publicPem) return '';
  switch ($('enc-public-format').value) {
    case 'jwk': return JSON.stringify(encoded.publicJwk, null, 2);
    case 'jwks': return JSON.stringify({ keys: [encoded.publicJwk] }, null, 2);
    default: return encoded.publicPem;
  }
}

function renderPublicKey() {
  $('enc-public').textContent = publicKeyText();
}

// Reads the alg from the header JSON as it is typed, so the picker and key field follow it.
function onHeaderInput() {
  try {
    const header = JSON.parse($('enc-header').value);
    if (isObject(header) && ALG_OPTIONS.includes(header.alg) && header.alg !== encAlg) {
      encAlg = header.alg;
      updateEncodeKeyUi();
    }
  } catch { /* the error shows below the field */ }
  runEncode();
}

$('enc-alg').addEventListener('change', () => {
  const alg = $('enc-alg').value;
  try {
    const header = JSON.parse($('enc-header').value);
    if (isObject(header)) {
      header.alg = alg;
      $('enc-header').value = JSON.stringify(header, null, 2);
    }
  } catch { /* leave invalid JSON alone */ }
  const familyChanged = keyFamily(alg) !== keyFamily(encAlg);
  encAlg = alg;
  updateEncodeKeyUi();
  if (familyChanged) {
    $('enc-key').value = '';
    if (ALGS[alg]) { generateKey(); return; }
  }
  runEncode();
});

$('enc-header').addEventListener('input', onHeaderInput);
$('enc-payload').addEventListener('input', runEncode);
$('enc-key').addEventListener('input', runEncode);
$('enc-b64').addEventListener('change', runEncode);
$('enc-generate').addEventListener('click', generateKey);
$('enc-public-format').addEventListener('change', renderPublicKey);
$('enc-copy').addEventListener('click', (e) => copyText(e.currentTarget, encoded.token));
$('enc-public-copy').addEventListener('click', (e) => copyText(e.currentTarget, publicKeyText()));

for (const button of document.querySelectorAll('[data-claim]')) {
  button.addEventListener('click', () => {
    let payload;
    try { payload = JSON.parse($('enc-payload').value); } catch { /* handled below */ }
    if (!isObject(payload)) {
      flash(button, 'Fix the JSON first');
      return;
    }
    payload[button.dataset.claim] = nowSec() + Number(button.dataset.add || 0);
    $('enc-payload').value = JSON.stringify(payload, null, 2);
    runEncode();
  });
}

$('enc-open').addEventListener('click', () => {
  if (!encoded.token) return;
  const a = ALGS[encAlg];
  if (a && a.kind === 'hmac') {
    $('verify-key').value = $('enc-key').value;
    $('verify-b64').checked = $('enc-b64').checked;
  } else {
    $('verify-key').value = encoded.publicPem || '';
    $('verify-b64').checked = false;
  }
  setMode('decode');
  setToken(encoded.token);
});

$('token-to-encoder').addEventListener('click', () => {
  const t = parsed;
  if (!t.header) return;
  $('enc-header').value = JSON.stringify(t.header, null, 2);
  $('enc-payload').value = t.payload !== undefined ? JSON.stringify(t.payload, null, 2) : JSON.stringify(t.payloadText || {});
  const alg = ALG_OPTIONS.includes(t.header.alg) ? t.header.alg : encAlg;
  const a = ALGS[alg];
  const sameFamily = keyFamily(alg) === keyFamily(encAlg);
  encAlg = alg;
  updateEncodeKeyUi();
  setMode('encode');
  if (a && a.kind === 'hmac' && $('verify-key').value.trim()) {
    // Same secret, so the re-signed token still verifies.
    $('enc-key').value = $('verify-key').value;
    $('enc-b64').checked = $('verify-b64').checked;
  } else if (a && !sameFamily) {
    // Only the public key is known here, so sign with a fresh key pair instead.
    $('enc-key').value = '';
    generateKey();
    return;
  }
  runEncode();
});

// ---- Modes, help and theme ----

function setMode(mode) {
  const encode = mode === 'encode';
  $('decode').hidden = encode;
  $('encode').hidden = !encode;
  $('mode-decode').setAttribute('aria-selected', String(!encode));
  $('mode-encode').setAttribute('aria-selected', String(encode));
  try {
    history.replaceState(null, '', encode ? '#encode' : location.pathname + location.search);
  } catch { /* some browsers refuse this for file:// pages */ }
  if (!encode) renderDecoded();
}
$('mode-decode').addEventListener('click', () => setMode('decode'));
$('mode-encode').addEventListener('click', () => setMode('encode'));

$('help').addEventListener('click', () => $('help-dialog').showModal());
$('help-dialog').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close(); // click on the backdrop
});

const THEME_KEY = 'jwt-debugger:theme';
const THEME_LABELS = { auto: '◐ Auto', light: '☀ Light', dark: '☾ Dark' };
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
let themePref = 'auto';
try { themePref = localStorage.getItem(THEME_KEY) || 'auto'; } catch { /* storage unavailable */ }

function applyTheme() {
  const dark = themePref === 'dark' || (themePref === 'auto' && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('theme').textContent = THEME_LABELS[themePref];
  $('theme').title = `Theme: ${themePref}. Click to switch between auto (follow the system), light and dark.`;
}
$('theme').addEventListener('click', () => {
  const order = ['auto', 'light', 'dark'];
  themePref = order[(order.indexOf(themePref) + 1) % order.length];
  try { localStorage.setItem(THEME_KEY, themePref); } catch { /* storage unavailable */ }
  applyTheme();
});
darkQuery.addEventListener('change', applyTheme);
window.addEventListener('storage', (e) => {
  if (e.key === THEME_KEY) { themePref = e.newValue || 'auto'; applyTheme(); }
});

// ---- Startup ----

applyTheme();
{
  const now = nowSec();
  $('enc-header').value = JSON.stringify({ alg: 'HS256', typ: 'JWT' }, null, 2);
  $('enc-payload').value = JSON.stringify({ sub: '1234567890', name: 'Ana Example', iat: now, exp: now + 3600 }, null, 2);
}
updateEncodeKeyUi();
generateKey();
setMode(location.hash === '#encode' ? 'encode' : 'decode');
loadExample();
