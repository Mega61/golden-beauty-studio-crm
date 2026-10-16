/**
 * Encrypts a report for exactly one recipient, so it can travel as a GitHub
 * Actions artifact on a PUBLIC repo without exposing anyone's name or phone.
 *
 * Hybrid scheme, Node's built-in crypto only: a fresh AES-256-GCM key per file,
 * and that key wrapped with the recipient's RSA public key (OAEP, SHA-256). The
 * output is a small JSON envelope; only the holder of the private key can open
 * it (see the `decrypt` snippet in the README).
 */
import crypto from 'node:crypto';

export function encryptForRecipient(buffer, publicKeyPem) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const wrapped = crypto.publicEncrypt(
    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    key,
  );
  return JSON.stringify({
    alg: 'RSA-OAEP-256+A256GCM',
    key: wrapped.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  });
}
