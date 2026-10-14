import type { Client } from '../domain.ts';

export type PiiKind = 'email' | 'phone' | 'card' | 'credential';

export interface Pseudonymized {
  text: string;
  /** token -> real name, used to rehydrate model output. */
  map: Record<string, string>;
  piiKinds: PiiKind[];
}

/** Stable per roster: the same client always gets the same token, so cross-ticket prompts stay consistent. */
export function clientTokens(clients: Client[]): Map<string, string> {
  const sorted = [...clients].sort((a, b) => a.id.localeCompare(b.id));
  return new Map(sorted.map((c, i) => [c.id, `[CLIENT_${i + 1}]`]));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const CARD_RE = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g;
const PHONE_RE = /(?<![\w+])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]?\d{3,4}(?!\w)/g;
const BARE_PHONE_RE = /(?<![\w+])\+?\d{10,14}(?!\w)/g;
// The secret runs to the end of the sentence, not the first space: passphrases and "123 456" codes have spaces.
const SECRET = String.raw`("[^"\n]*"|'[^'\n]*'|\S[^\n]*?(?=\s*(?:\n|$)|[.!?,;]\s))`;
const CREDENTIAL_LABEL = String.raw`password|passcode|passwd|pwd|2fa code|backup code|verification code|login code|one-time code|otp`;
const SEPARATOR = String.raw`(?:\b(?:is|was)\b\s*[:=]?|[:=]|->)\s*`;
// "password was changed" describes the password rather than giving it.
const NOT_A_SECRET = String.raw`(?!\s*(?:changed|reset|updated|wrong|incorrect|invalid|expired|rejected|not|never|sent|stolen|leaked)\b)`;
const CREDENTIAL_RES = [
  // "password is: x", "2FA code was 123 456", "new password -> x"
  new RegExp(String.raw`\b(${CREDENTIAL_LABEL})(\s*${SEPARATOR})${NOT_A_SECRET}${SECRET}`, 'gi'),
  // "the password to our IG account is x", "password for the admin login: x"
  new RegExp(String.raw`\b(${CREDENTIAL_LABEL})(\s+(?:to|for|on)\s+[^\n.:]{1,40}?\s*${SEPARATOR})${NOT_A_SECRET}${SECRET}`, 'gi'),
  // Short labels only with an explicit separator, so "the pass is valid" stays readable.
  new RegExp(String.raw`\b(pw|pass|pin)(\s*[:=]\s*)${SECRET}`, 'gi'),
];

export function redactPii(input: string): { text: string; piiKinds: PiiKind[] } {
  const kinds = new Set<PiiKind>();
  let text = input;
  for (const re of CREDENTIAL_RES) {
    text = text.replace(re, (_m, label: string, sep: string) => {
      kinds.add('credential');
      return `${label}${sep}[CREDENTIAL]`;
    });
  }
  text = text.replace(EMAIL_RE, () => {
    kinds.add('email');
    return '[EMAIL]';
  });
  text = text.replace(CARD_RE, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 13 || !luhn(digits)) return m;
    kinds.add('card');
    return '[CARD]';
  });
  text = text.replace(PHONE_RE, (m) => {
    if (m.replace(/\D/g, '').length < 9) return m;
    kinds.add('phone');
    return '[PHONE]';
  });
  text = text.replace(BARE_PHONE_RE, () => {
    kinds.add('phone');
    return '[PHONE]';
  });
  return { text, piiKinds: [...kinds] };
}

export function pseudonymize(input: string, clients: Client[]): Pseudonymized {
  const tokens = clientTokens(clients);
  const map: Record<string, string> = {};
  const terms: { term: string; token: string }[] = [];
  for (const c of clients) {
    const token = tokens.get(c.id)!;
    map[token] = c.name;
    for (const term of [c.name, ...c.aliases]) terms.push({ term, token });
  }
  // Longest first so "Kingsley Motors" wins over "Kingsley".
  terms.sort((a, b) => b.term.length - a.term.length);

  // PII first: a client name in an email address ("aurora@gmail.com") would otherwise hide the address from EMAIL_RE.
  const redacted = redactPii(input);
  let text = redacted.text;
  for (const { term, token } of terms) {
    const re = new RegExp(`(?<![\\w@])${escapeRe(term)}(?!\\w)`, 'gi');
    text = text.replace(re, token);
  }
  return { text, map, piiKinds: redacted.piiKinds };
}

export function rehydrate(text: string, map: Record<string, string>): string {
  return text.replace(/\[CLIENT_\d+\]/g, (token) => map[token] ?? token);
}

const PROMPT_TAG_RE = /<\/?\s*(ticket|report|reports|doc|docs|incident|runbooks|summary|signals|system|instructions)\b[^>]*>/gi;

/** Removes tags that could close the data wrapper in our prompts. */
export function neutralizePromptTags(text: string): string {
  return text.replace(PROMPT_TAG_RE, '[tag removed]');
}

const INJECTION_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b.{0,40}\b(instructions?|prompts?|rules|guidelines)\b/i,
  /\b(system|developer)\s+(prompt|message|instructions?)\b/i,
  /\byou are now\b/i,
  /\bnew instructions?\s*:/i,
  /\b(act|behave|respond) as (an? )?(admin|administrator|system|developer|different)\b/i,
  /\b(mark|set|classify)\b.{0,30}\b(as|to)\b.{0,10}\b(resolved|low priority|p4|approved|not urgent)\b/i,
  PROMPT_TAG_RE,
];

export function detectPromptInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}
