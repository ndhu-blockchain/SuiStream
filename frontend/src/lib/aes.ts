export function generateAESKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

export function generateIV(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

// 修正：輸入輸出皆為 Uint8Array，不轉 Base64/String 以免損毀影片檔
export async function encryptAES128(
  data: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array
): Promise<Uint8Array> {
  if (key.length !== 16) throw new Error("Key must be 16 bytes");
  if (iv.length !== 16) throw new Error("IV must be 16 bytes");

  // 使用 as BufferSource 斷言，明確告知 TS 這是相容的 BufferSource
  // 這是比 as any 更安全且正確的解法，解決 ArrayBufferLike vs ArrayBuffer 的定義衝突
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource, 
    { name: "AES-CBC" },
    false,
    ["encrypt"]
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: iv as BufferSource },
    cryptoKey,
    data as BufferSource
  );

  return new Uint8Array(encrypted);
}

// 解密函式 (備用)
export async function decryptAES128(
  encryptedData: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array
): Promise<Uint8Array> {
  if (key.length !== 16) throw new Error("Key must be 16 bytes");
  if (iv.length !== 16) throw new Error("IV must be 16 bytes");

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "AES-CBC" },
    false,
    ["decrypt"]
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: iv as BufferSource },
    cryptoKey,
    encryptedData as BufferSource
  );

  return new Uint8Array(decrypted);
}
