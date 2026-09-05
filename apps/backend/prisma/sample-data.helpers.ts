/**
 * Backwards-compatible shim. The sample-data constants/helpers now live in the
 * Nest source tree so both the runtime SampleDataService and this CLI can share
 * one source of truth:
 *   src/sample-data/sample-data.constants.ts
 */
export * from '../src/sample-data/sample-data.constants';
