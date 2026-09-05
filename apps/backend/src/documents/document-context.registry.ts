/**
 * How a document type gets its data.
 *
 * Deliberately a near-copy of `src/storage/secure-download.registry.ts`,
 * including its most important rule: a resolver MUST THROW when the caller may
 * not have the record. Returning `false` or `null` would be treated as "not
 * found" by the caller, which is a different thing from "not allowed" — and a
 * resolver that forgot the check would leak existence rather than content.
 */

export interface DocumentSubjectRequest {
  /** The record the document describes: a payrollItemId, a loanId, a settlementId. */
  subjectId: string | null;
  /** Whom it is about. Null for company-wide artefacts. */
  employeeId: string | null;
  /** month, year, dateFrom, dateTo … interpreted by the resolver. */
  params: Record<string, unknown>;
}

export interface DocumentContextResolver {
  /** DOCUMENT_TYPES keys this resolver serves. */
  readonly typeKeys: readonly string[];

  /**
   * Permission for ONE subject, decided by the domain that owns the data.
   *
   * The engine deliberately does not try to answer this itself: whether a
   * particular manager may see a particular payslip depends on payroll's own
   * rules (a draft run is not a statement of pay), and a second copy of those
   * rules in the engine would drift from the first.
   */
  assertMayRead(req: DocumentSubjectRequest, user: unknown): Promise<void>;

  /**
   * Build contexts for a WHOLE LIST of subjects.
   *
   * Batch-shaped from day one, and this is the single most consequential line
   * in the interface. A single-subject signature with a loop around it is
   * exactly how a 300-payslip run turns into eighteen hundred queries, and
   * because each one is individually reasonable, nothing in a profile points
   * at the cause.
   *
   * Returns WHITELISTED PLAIN OBJECTS ONLY — never a Prisma model. Handlebars
   * `{{lookup}}` and `{{#with}}` walk whatever they are handed, so a model
   * instance would expose every relation the query happened to include.
   */
  build(
    reqs: DocumentSubjectRequest[],
    user: unknown,
  ): Promise<Map<string, Record<string, unknown>>>;

  /** Which subjects a bulk run over these params covers. Bulk types only. */
  expand?(params: Record<string, unknown>, user: unknown): Promise<DocumentSubjectRequest[]>;
}

/**
 * DI token for the resolver array.
 *
 * Nest has no `multi: true`, so every resolver is collected in ONE factory in
 * DocumentsModule — the same shape DocumentVaultModule uses for its download
 * resolvers, and for the same reason.
 */
export const DOCUMENT_CONTEXT_RESOLVERS = Symbol('DOCUMENT_CONTEXT_RESOLVERS');

/** Stable map key for a subject. */
export function subjectKey(req: DocumentSubjectRequest): string {
  return `${req.employeeId ?? '-'}:${req.subjectId ?? '-'}`;
}
