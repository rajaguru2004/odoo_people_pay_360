import {
  CompiledTemplate,
  compileDocument,
  DocumentCompileError,
} from './document-compiler';
import { compileGrapesDocument } from './grapes-compiler';
import {
  AnyTemplateDoc,
  DocumentTemplateDoc,
  isGrapesDoc,
} from './document-doc.model';

/**
 * One entry point for both template dialects.
 *
 * v1 (block builder) → `compileDocument`; v2 (`kind: 'grapes'`) →
 * `compileGrapesDocument`. Everything after compilation — sanitize, hash,
 * optimistic-lock write — is shared and unaware of the dialect, which is the
 * whole point: the visual editor is a second authoring surface, not a second
 * pipeline.
 */
export function compileAnyDocument(
  doc: AnyTemplateDoc,
): CompiledTemplate & { removed?: string[] } {
  if (isGrapesDoc(doc)) return compileGrapesDocument(doc);
  const v1 = doc as DocumentTemplateDoc;
  if (v1?.schemaVersion === 1) return compileDocument(v1);
  throw new DocumentCompileError(
    'This template was saved by a newer version of the builder. Update before editing it.',
  );
}
