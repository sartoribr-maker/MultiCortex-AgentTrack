/**
 * Generates a DEVCORE_USERS entry: email:<bcrypt hash in base64>[:Nome]
 *
 *   npm run hash-password -- pessoa@multicortex.com.br "Nome da Pessoa"
 *
 * The password is read from the terminal without echo (or from stdin when piped)
 * and never printed. Append the output to DEVCORE_USERS, separated by commas.
 */
import bcrypt from "bcryptjs";
import { createInterface } from "node:readline";
import { encodeHash, normalizeEmail, parseDevcoreUsers } from "../src/lib/devcore/users";

const COST = 12;

function fail(message: string): never {
  console.error(`Erro: ${message}`);
  process.exit(1);
}

async function readPiped(): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of createInterface({ input: process.stdin })) lines.push(line);
  return lines;
}

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") process.exit(130);
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });
}

async function main() {
  const [rawEmail, ...nameParts] = process.argv.slice(2);
  if (!rawEmail) fail('informe o e-mail: npm run hash-password -- pessoa@multicortex.com.br "Nome"');
  const email = normalizeEmail(rawEmail);
  const name = nameParts.join(" ").trim();
  if (/[,:\n]/.test(name)) fail("o nome não pode ter vírgula nem dois-pontos.");

  let password: string;
  if (process.stdin.isTTY) {
    password = await askHidden("Senha: ");
    if ((await askHidden("Repita a senha: ")) !== password) fail("as senhas não conferem.");
  } else {
    password = (await readPiped())[0] ?? "";
  }
  if (password.length < 12) fail("use uma senha com pelo menos 12 caracteres.");

  const entry = [email, encodeHash(await bcrypt.hash(password, COST)), name].filter(Boolean).join(":");
  parseDevcoreUsers(entry); // same validation the server applies
  console.log(entry);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
