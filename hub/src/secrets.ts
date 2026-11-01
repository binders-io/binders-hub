import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// Sealing what the hub keeps that mustn't be read off its Redis or disk as is: sessions' GitHub tokens, the GitHub App's
// keys. One key, from HUB_SECRET or, without it, from a file the hub makes once and keeps beside its data.

export class Sealer {
  private key: Buffer

  constructor(secret: string) {
    this.key = createHash('sha256').update(secret).digest()
  }

  seal(text: string) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')
  }

  open(sealed: string) {
    const raw = Buffer.from(sealed, 'base64url')
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
  }
}

/** HUB_SECRET, or the one kept in `file`, made the first time with only the hub's user able to read it. */
export async function hubSecret(fromEnv: string | undefined, file: string) {
  if (fromEnv) return { secret: fromEnv, made: false }
  try {
    const kept = (await readFile(file, 'utf8')).trim()
    if (kept) return { secret: kept, made: false }
  } catch {
    // Not made yet.
  }
  const secret = randomBytes(32).toString('hex')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${secret}\n`, { mode: 0o600 })
  await chmod(file, 0o600)
  return { secret, made: true }
}
