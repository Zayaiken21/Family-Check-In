import bcrypt from 'bcryptjs';
const pin=process.argv[2];
if(!pin){console.error('Usage: node scripts/hash-pin.mjs 123456');process.exit(1)}
console.log(await bcrypt.hash(pin,12));
