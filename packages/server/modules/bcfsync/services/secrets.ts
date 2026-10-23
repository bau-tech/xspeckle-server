import crypto from 'node:crypto'
import { getSessionSecret } from '@/modules/shared/helpers/envHelper'

/**
 * Encrypts OAuth secrets at rest: AES-256-GCM, key derived from SESSION_SECRET
 * (so rotating it invalidates stored connections, which then re-authorize).
 * Format: v1.<iv>.<tag>.<ciphertext>, all base64url.
 */
const key = (secret = getSessionSecret()) =>
  Buffer.from(crypto.hkdfSync('sha256', secret, 'xspeckle-bcfsync', 'secrets-v1', 32))

export const encryptSecret = (plain: string, secret?: string): string => {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key(secret), iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return ['v1', iv, cipher.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.')
}

export const decryptSecret = (stored: string, secret?: string): string => {
  const [version, iv, tag, data] = stored.split('.')
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unknown secret format')
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key(secret),
    Buffer.from(iv, 'base64url')
  )
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64url')),
    decipher.final()
  ]).toString('utf8')
}
