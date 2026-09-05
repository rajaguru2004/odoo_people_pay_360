/**
 * Generates the bcrypt hash for DEV_MODE_PASSWORD_HASH.
 *
 *   npx ts-node scripts/hash-dev-password.ts 'the-password'
 *
 * Paste the output into the backend .env. The plaintext is never stored
 * anywhere — not in the database, not in system_settings — so it cannot be read
 * back or replaced through the app by anyone, including an ADMIN.
 */
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

const COST = 12;

async function main() {
  const password = process.argv[2];

  if (!password) {
    console.error("Usage: npx ts-node scripts/hash-dev-password.ts 'the-password'");
    process.exit(1);
  }

  if (password.length < 12) {
    console.error('Refusing: use at least 12 characters. This one password gates');
    console.error('every operator setting and the database reset.');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, COST);

  // Each $ doubled. Docker Compose interpolates env_file values, so a raw hash
  // loses every $name segment: $2b$12$pSOAs0... arrives as $2b$12... and every
  // elevation then fails with "Invalid credentials". Compose collapses $$ back
  // to $; on the host dotenv does not interpolate, so DevModeService collapses
  // it instead. One line, correct in both places.
  const escaped = hash.replace(/\$/g, '$$$$');

  console.log('\nAdd to the backend .env:\n');
  console.log(`DEV_MODE_PASSWORD_HASH=${escaped}`);
  console.log(`DEV_MODE_TOKEN_SECRET=${randomBytes(32).toString('hex')}`);
  console.log('DEV_MODE_TTL_MINUTES=20');
  console.log('DEV_MODE_ENFORCED=false   # flip to true once elevation is verified\n');
  console.log('The $$ is deliberate — do not "correct" it to single $, or Docker');
  console.log('Compose will eat most of the hash. The raw hash, for reference:\n');
  console.log(`  ${hash}\n`);
}

void main();
