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
