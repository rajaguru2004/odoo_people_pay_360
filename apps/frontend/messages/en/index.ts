import common from './common.json';
import moduleLanding from './moduleLanding.json';
import schedules from './schedules.json';
import sidebar from './sidebar.json';

/**
 * One namespace per feature area. Kept as separate JSON files rather than one
 * large object so a translator can be handed the file for the module they are
 * working on, and so two features adding keys do not conflict in the same file.
 */
const messages = { common, moduleLanding, schedules, sidebar };

export default messages;
