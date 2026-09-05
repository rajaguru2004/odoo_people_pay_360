/**
 * The last line of defence before anything leaves the browser for Google.
 *
 * Callers are trusted to pass counts and categories, not payroll rows — but
 * "trusted" is not a control. Every parameter goes through here, so a future
 * `trackEvent('payslip_downloaded', { netPay })` added in a hurry drops the
 * amount instead of publishing it.
 *
 * Three rules, in order:
 *   1. The key is checked against a denylist of HR-sensitive words.
 *   2. The value must be a plain scalar — objects and arrays are refused
 *      outright, because a whole employee record is exactly what gets passed
 *      by accident.
 *   3. Strings are shape-checked (no addresses, no long free text) and capped.
 */

export type AnalyticsScalar = string | number | boolean;
export type AnalyticsParams = Record<string, unknown>;

/**
 * Key words that mean the value is personal, financial or otherwise
 * confidential.
 *
 * Matched against the key's TOKENS and against each pair of adjacent tokens
 * joined up, so `employeeId`, `employee_id` and `employeeid` are all the same
 * entry. That is why the list holds `employeeid` but not a bare `employee`: a
 * bare `employee` would also kill `employee_count`, which is a number we want.
 *
 * Bare `id` IS denied. Every id in this product points at one record about one
 * person, and no legitimate analytics dimension needs it.
 */
const DENIED_TOKENS = new Set([
  // Identity
  'id', 'name', 'fullname', 'firstname', 'lastname', 'middlename', 'displayname',
  'username', 'email', 'mail', 'phone', 'mobile', 'address', 'dob', 'birthdate',
  'birthday', 'gender', 'nationality', 'passport', 'nid', 'ssn', 'iqama',
  'photo', 'avatar', 'signature',
  // Identifiers that point at one person or record
  'employeeid', 'employeecode', 'employeename', 'userid', 'managerid',
  'managername', 'approverid', 'requesterid', 'candidateid', 'departmentid',
  'branchid', 'recordid',
  // Money
  'salary', 'wage', 'pay', 'netpay', 'grosspay', 'gross', 'net', 'basic',
  'allowance', 'deduction', 'bonus', 'gratuity', 'amount', 'balance', 'total',
  'cost', 'ctc', 'currency',
  // Banking
  'iban', 'account', 'accountnumber', 'swift', 'bic', 'card',
  // Free text / credentials
  'comment', 'comments', 'reason', 'note', 'notes', 'description', 'remark',
  'remarks', 'message', 'token', 'password', 'secret', 'otp', 'query', 'search',
]);

/** Splits `net_pay`, `netPay`, `net-pay` and `NetPay` into comparable tokens. */
function tokenize(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

export function isDeniedKey(key: string): boolean {
  const tokens = tokenize(key);
  if (tokens.some((token) => DENIED_TOKENS.has(token))) return true;
  // Adjacent pairs, so a compound entry matches however the key was cased.
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (DENIED_TOKENS.has(tokens[i] + tokens[i + 1])) return true;
  }
  return false;
}

/** Longest string an event parameter may carry. GA4's own limit is 100 chars. */
const MAX_STRING_LENGTH = 100;

/** Value shapes that are personal data whatever the key is called. */
const VALUE_LOOKS_PERSONAL = [
  /@/, // email address
  /\+?\d[\d\s().-]{7,}/, // phone number
  /\b[A-Z]{2}\d{2}[A-Z0-9]{10,}\b/, // IBAN
];

function isSafeValue(value: unknown): value is AnalyticsScalar {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  if (value.length > MAX_STRING_LENGTH) return false;
  return !VALUE_LOOKS_PERSONAL.some((pattern) => pattern.test(value));
}

/**
 * Drop every parameter that fails a rule and return the rest.
 *
 * Dropping — rather than throwing — is deliberate: analytics must never be able
 * to break the screen that called it. A dropped parameter costs a report
 * dimension; a thrown error costs the user their form.
 */
export function scrubParams(params: AnalyticsParams | undefined): Record<string, AnalyticsScalar> {
  if (!params) return {};
  const safe: Record<string, AnalyticsScalar> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (isDeniedKey(key)) continue;
    if (!isSafeValue(value)) continue;
    safe[key] = value;
  }
  return safe;
}

/**
 * A stable, non-reversible id for a signed-in user.
 *
 * GA4's `user_id` is what joins a person's sessions across devices, which is
 * the "user/session activity" half of the brief. The raw account id is not sent:
 * it is a live database key, and pasting it into a GA report would let anyone
 * with report access look the employee up. FNV-1a over the id gives the same
 * value for the same account on every device without carrying the key itself.
 */
export function pseudonymousId(rawId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < rawId.length; i += 1) {
    hash ^= rawId.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in range with Math.imul.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `u_${hash.toString(16).padStart(8, '0')}`;
}
