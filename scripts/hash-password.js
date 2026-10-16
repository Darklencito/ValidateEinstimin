// Uso: npm run hash -- "mi_contraseña"
const bcrypt = require("bcryptjs");

const password = process.argv[2];
if (!password) {
  console.error('Uso: npm run hash -- "tu_contraseña"');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 10);
console.log("\nHash (para panel de SiteGround / variables de entorno):\n" + hash);
console.log("\nPara .env.local (con $ escapados):\n" + hash.replace(/\$/g, "\\$") + "\n");
