import common from './common.json';

/**
 * One namespace per feature area. Kept as separate JSON files rather than one
 * large object so a translator can be handed the file for the module they are
 * working on, and so two features adding keys do not conflict in the same file.
 */
const messages = { common };

export default messages;
