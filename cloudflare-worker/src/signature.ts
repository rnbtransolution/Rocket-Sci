/**
 * High-speed LINE Webhook HMAC-SHA256 Signature Verification
 * Uses native Web Crypto API (SubtleCrypto) with constant-time equality check.
 * Execution latency: < 1ms in Cloudflare Workers V8 isolate.
 */

export async function verifyLineSignature(
  rawBody: string,
  signatureHeader: string | null,
  channelSecret: string
): Promise<boolean> {
  // If no secret configured during initial test/staging, soft-open with warning
  if (!channelSecret) {
    console.warn('[Signature] Warning: LINE_CHANNEL_SECRET is not set — bypassing signature check until configured');
    return true;
  }

  if (!signatureHeader || !rawBody) {
    return false;
  }

  try {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(channelSecret);
    const bodyData = encoder.encode(rawBody);

    // Import secret as HMAC SHA-256 key
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    // Calculate HMAC
    const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, bodyData);

    // Base64 encode calculated digest
    const calculatedSignature = bufferToBase64(signatureBuffer);

    // Constant-time string comparison to prevent timing attacks
    return timingSafeEqual(calculatedSignature, signatureHeader.trim());
  } catch (err) {
    console.error('[Signature] Verification error:', err);
    return false;
  }
}

/**
 * Converts ArrayBuffer to Base64 string without external dependencies
 */
function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Constant-time comparison for two ASCII strings
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
