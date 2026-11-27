// Run on YOUR computer (never in chat):  node scripts/hash-admin-password.js
// It asks for a password, prints a hash to put in the ADMIN_ACCOUNTS Vercel variable.
const A = require('../lib/admin-session.js');
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('New admin password (min 12 characters): ', (pw) => {
  rl.close();
  if (pw.length < 12) { console.error('Too short.'); process.exit(1); }
  console.log('\nHash (safe to store in Vercel env):\n' + A.hashPassword(pw));
});
