import { rpc } from '@stellar/stellar-sdk'
import { config } from '../config.js'

// Allow http:// for local/standalone RPC while defaulting to secure transport.
export const server = new rpc.Server(config.stellar.rpcUrl, {
  allowHttp: config.stellar.rpcUrl.startsWith('http://'),
})

export async function getLatestLedger(): Promise<number> {
  const res = await server.getLatestLedger()
  return res.sequence
}

/** Latest-ledger sequence plus its hash (`id`). Soroban's `getEvents` does
 *  not expose a per-event ledger hash, so this tip info is the only hash the
 *  RPC gives us — used as forensic context and a coarse rewind signal for
 *  reorg detection (issue #23). */
export async function getLatestLedgerInfo(): Promise<{ sequence: number; hash: string }> {
  const res = await server.getLatestLedger()
  return { sequence: res.sequence, hash: res.id }
}
