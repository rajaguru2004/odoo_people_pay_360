import * as Handlebars from 'handlebars';
import { registerDocumentHelpers } from './helpers';

/**
 * A PRIVATE Handlebars environment for document templates.
 *
 * NOT the global singleton, and this is load-bearing. `@nestjs-modules/mailer`
 * compiles all 31 `.hbs` email templates against the global registry
 * (mail.module.ts). A helper registered globally under a name as ordinary as
 * `date` or `money` would silently change the rendering of every email the
 * product sends — a payslip notification, a leave approval, a welcome mail —
 * with nothing in the diff to suggest it.
 *
 * `Handlebars.create()` gives an isolated registry. Nothing here can reach the
 * mailer, and nothing the mailer registers can reach documents.
 */
export const docHb = Handlebars.create();

registerDocumentHelpers(docHb);

export const DOC_COMPILE_OPTIONS: CompileOptions = {
  // A field a profile template no longer defines must render blank, not throw.
  // An admin removing a custom field must not break every document that still
  // mentions it.
  strict: false,
  // {{x}} escapes. Triple-stash is rejected outright by the sanitizer, so this
  // is the only escaping mode a stored template can be in.
  noEscape: false,
};

/**
 * Runtime options, pinned explicitly even though they match the 4.x defaults.
 *
 * These are the security property, not a preference: with prototype access
 * enabled, `{{constructor.constructor}}` reaches the Function constructor from
 * inside a template an admin can edit. Handlebars takes them per RENDER, not
 * per compile, so they must be passed at every call site — which is why
 * rendering goes through `renderDocumentTemplate` below rather than callers
 * invoking the compiled function directly.
 *
 * A default that is relied upon but never written down is one dependency bump
 * away from changing underneath us.
 */
export const DOC_RUNTIME_OPTIONS: RuntimeOptions = {
  allowProtoPropertiesByDefault: false,
  allowProtoMethodsByDefault: false,
};

export function compileDocumentTemplate(source: string): HandlebarsTemplateDelegate {
  return docHb.compile(source, DOC_COMPILE_OPTIONS);
}

/** Render a compiled template with the prototype guards applied. */
export function renderDocumentTemplate(
  template: HandlebarsTemplateDelegate,
  context: Record<string, unknown>,
): string {
  return template(context, DOC_RUNTIME_OPTIONS);
}
