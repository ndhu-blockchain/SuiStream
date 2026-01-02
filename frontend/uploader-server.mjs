import http from 'node:http';
import { URL } from 'node:url';
import { createHash } from 'node:crypto';

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { bcs } from '@mysten/sui/bcs';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { walrus } from '@mysten/walrus';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

function base64UrlDecodeToBytes(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return Uint8Array.from(Buffer.from(padded, 'base64'));
}

function sha256(bytes) {
  return Uint8Array.from(createHash('sha256').update(Buffer.from(bytes)).digest());
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function fetchJson(url, init) {
  const resp = await fetch(url, init);
  const text = await resp.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${url}: ${text || resp.statusText}`);
  }
  return json;
}

const PORT = Number(process.env.PORT || 8787);
const NETWORK = process.env.SUI_NETWORK || 'testnet';
const SUI_RPC_URL = process.env.SUI_RPC_URL || getFullnodeUrl(NETWORK);
const WALRUS_UPLOAD_RELAY_HOST = process.env.WALRUS_UPLOAD_RELAY_HOST || 'https://upload-relay.testnet.walrus.space';

// Ed25519 secret key bytes in base64 (32 bytes).
const UPLOADER_SECRET_KEY_B64 = requireEnv('UPLOADER_SECRET_KEY_B64');
const secretKey = Uint8Array.from(Buffer.from(UPLOADER_SECRET_KEY_B64, 'base64'));
const keypair = Ed25519Keypair.fromSecretKey(secretKey);

const suiClient = new SuiClient({ url: SUI_RPC_URL, network: NETWORK }).$extend(
  walrus({
    network: NETWORK,
    uploadRelay: {
      host: WALRUS_UPLOAD_RELAY_HOST,
    },
  })
);

async function getTipConfig() {
  // The relay exposes /v1/tip-config
  const cfg = await fetchJson(`${WALRUS_UPLOAD_RELAY_HOST}/v1/tip-config`);
  // Expected shape (as of current relay): { address: '0x..', amount: '1234' } or similar.
  if (!cfg || !cfg.address || !cfg.amount) {
    throw new Error(`Unexpected tip-config response: ${JSON.stringify(cfg)}`);
  }
  return {
    address: cfg.address,
    amount: BigInt(cfg.amount),
  };
}

async function payTipForBlob({ nonceB64Url, blobBytes, tipAddress, tipAmount }) {
  const nonce = base64UrlDecodeToBytes(nonceB64Url);
  const digest = sha256(blobBytes);
  const nonceDigest = sha256(nonce);
  const lengthBytes = bcs.u64().serialize(BigInt(blobBytes.length)).toBytes();
  const authPayload = new Uint8Array(digest.length + nonceDigest.length + lengthBytes.length);
  authPayload.set(digest, 0);
  authPayload.set(nonceDigest, digest.length);
  authPayload.set(lengthBytes, digest.length + nonceDigest.length);

  const tx = new Transaction();
  tx.setSenderIfNotSet(keypair.getPublicKey().toSuiAddress());

  // Provide auth payload for relay to verify the tx paid for this exact blob.
  tx.pure(authPayload);

  // Pay tip in SUI.
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(tipAmount)]);
  tx.transferObjects([coin], tx.pure.address(tipAddress));

  const res = await suiClient.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true },
  });

  if (!res.digest) throw new Error('Tip tx missing digest');
  return res.digest;
}

async function uploadViaRelay({ blobId, blobObjectId, deletable, encodingType, nonceB64Url, tipTxDigest, blobBytes }) {
  const url = new URL('/v1/blob-upload-relay', WALRUS_UPLOAD_RELAY_HOST);
  url.searchParams.set('blob_id', blobId);
  url.searchParams.set('nonce', nonceB64Url);
  url.searchParams.set('tx_id', tipTxDigest);
  url.searchParams.set('blob_object_id', blobObjectId);
  url.searchParams.set('deletable', String(deletable));
  url.searchParams.set('encoding_type', encodingType);

  const resp = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
    },
    body: blobBytes,
  });

  const text = await resp.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!resp.ok) {
    throw new Error(`Relay upload failed (${resp.status}): ${text || resp.statusText}`);
  }

  if (!json?.certificate) {
    throw new Error(`Relay response missing certificate: ${text}`);
  }

  return json;
}

async function certifyAndTransfer({ blobId, blobObjectId, deletable, certificate, userAddress }) {
  const tx = new Transaction();
  tx.setSenderIfNotSet(keypair.getPublicKey().toSuiAddress());

  const parsedCert = {
    signers: certificate.signers,
    serializedMessage: base64UrlDecodeToBytes(certificate.serializedMessage),
    signature: base64UrlDecodeToBytes(certificate.signature),
  };

  suiClient.walrus.certifyBlobTransaction({
    transaction: tx,
    blobId,
    blobObjectId,
    deletable,
    certificate: parsedCert,
  });

  // After certify, transfer ownership to the user (so their app can manage it).
  tx.transferObjects([tx.object(blobObjectId)], tx.pure.address(userAddress));

  const res = await suiClient.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true },
  });

  if (!res.digest) throw new Error('Certify tx missing digest');
  return res.digest;
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && u.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, address: keypair.getPublicKey().toSuiAddress() }));
      return;
    }

    if (req.method === 'POST' && u.pathname === '/v1/upload') {
      const blobId = u.searchParams.get('blob_id');
      const blobObjectId = u.searchParams.get('blob_object_id');
      const encodingType = u.searchParams.get('encoding_type');
      const nonce = u.searchParams.get('nonce');
      const user = u.searchParams.get('user');
      const deletable = u.searchParams.get('deletable') === 'true';

      if (!blobId || !blobObjectId || !encodingType || !nonce || !user) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'missing required params: blob_id, blob_object_id, encoding_type, nonce, user',
          })
        );
        return;
      }

      const body = await readRequestBody(req);
      if (!body || body.length === 0) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'empty body' }));
        return;
      }

      const tipCfg = await getTipConfig();
      const tipTxDigest = await payTipForBlob({
        nonceB64Url: nonce,
        blobBytes: body,
        tipAddress: tipCfg.address,
        tipAmount: tipCfg.amount,
      });

      const relayResp = await uploadViaRelay({
        blobId,
        blobObjectId,
        deletable,
        encodingType,
        nonceB64Url: nonce,
        tipTxDigest,
        blobBytes: body,
      });

      const certifyDigest = await certifyAndTransfer({
        blobId,
        blobObjectId,
        deletable,
        certificate: relayResp.certificate,
        userAddress: user,
      });

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, tipTxDigest, certifyDigest }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(e?.message || e) }));
  }
});

server.listen(PORT, () => {
  console.log(`uploader server listening on http://localhost:${PORT}`);
  console.log(`uploader address: ${keypair.getPublicKey().toSuiAddress()}`);
});
