export function generateAESKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

export function generateIV(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

export async function encryptAES128ToBase64(
  plaintext: string,
  key: Uint8Array,
  iv: Uint8Array
): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);

  if (key.length !== 16) throw new Error("Key must be 16 bytes");
  if (iv.length !== 16) throw new Error("IV must be 16 bytes");

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(key),
    { name: "AES-CBC" },
    false,
    ["encrypt"]
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: new Uint8Array(iv) },
    cryptoKey,
    data
  );

  return bufferToBase64(encrypted);
}

export async function decryptAES128FromBase64(
  ciphertextBase64: string,
  key: Uint8Array,
  iv: Uint8Array
): Promise<string> {
  const data = base64ToBuffer(ciphertextBase64);

  if (key.length !== 16) throw new Error("Key must be 16 bytes");
  if (iv.length !== 16) throw new Error("IV must be 16 bytes");

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(key),
    { name: "AES-CBC" },
    false,
    ["decrypt"]
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: new Uint8Array(iv) },
    cryptoKey,
    data
  );

  return new TextDecoder().decode(decrypted);
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
