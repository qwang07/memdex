/**
 * L3 privacy filters applied before any conversation reaches SQLite.
 * - redactSecrets: replace credentials, tokens, private keys, Chinese ID numbers, and bank card numbers
 *   with `[REDACTED:<kind>]`.
 * - isPrivateConversation: a user message that starts with PRIVATE_MARKER keeps the whole conversation out of L3.
 */

export const PRIVATE_MARKER = "#memdex-private";

const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK = "10X98765432";

function validChineseId(id) {
  const sum = ID_WEIGHTS.reduce((total, weight, index) => total + weight * Number(id[index]), 0);
  return ID_CHECK[sum % 11] === id[17].toUpperCase();
}

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

const mark = (kind) => `[REDACTED:${kind}]`;

// A value after `password=` or `密码：` counts as a secret only when it mixes letters and digits.
// This skips code such as `token: string` or `apiKey = process.env.API_KEY`.
const looksSecret = (value) => /[A-Za-z]/.test(value) && /\d/.test(value);

// Order matters: whole blocks and prefixed tokens first, generic assignments last.
const RULES = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, () => mark("private_key")],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, () => mark("jwt")],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, () => mark("api_key")],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g, () => mark("github_token")],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, () => mark("aws_key")],
  [/\bAIza[0-9A-Za-z_-]{35}/g, () => mark("google_key")],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, () => mark("slack_token")],
  [/\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g, () => mark("stripe_key")],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, () => mark("npm_token")],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, (_, prefix) => prefix + mark("token")],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@()[\]]+:)[^\s@/()[\]]+@/gi, (_, prefix) => prefix + mark("password") + "@"],
  [
    /(\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\w*["']?\s*[:=]\s*["']?)([A-Za-z0-9_\-+/=!@#$%^&*.~]{8,})/gi,
    (match, prefix, value) => (looksSecret(value) ? prefix + mark("secret") : match),
  ],
  [
    /((?:密码|口令|密钥)\s*[:：=]\s*["'“]?)([A-Za-z0-9_\-+/=!@#$%^&*.~]{6,})/g,
    (match, prefix, value) => (looksSecret(value) ? prefix + mark("secret") : match),
  ],
  [
    /(?<![\dA-Za-z])[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\dA-Za-z])/g,
    (match) => (validChineseId(match) ? mark("id_number") : match),
  ],
  [
    /(?<![\dA-Za-z-])[3-6]\d{3}(?:[ -]?\d{4}){2}[ -]?\d{4,7}(?![\dA-Za-z])/g,
    (match) => {
      const digits = match.replace(/[ -]/g, "");
      return digits.length >= 16 && digits.length <= 19 && luhn(digits) ? mark("card_number") : match;
    },
  ],
];

export function redactSecrets(text) {
  if (typeof text !== "string" || !text) return text;
  let result = text;
  for (const [pattern, replace] of RULES) result = result.replace(pattern, replace);
  return result;
}

export function isPrivateConversation(messages) {
  return Array.isArray(messages) && messages.some((message) =>
    String(message?.role ?? "").toUpperCase() === "USER" &&
    typeof message.content === "string" &&
    message.content.trimStart().toLowerCase().startsWith(PRIVATE_MARKER)
  );
}
