import { describe, expect, it } from 'vitest'
import { Account, Keypair, MuxedAccount, StrKey } from '@stellar/stellar-sdk'
import {
  authenticateRequest,
  classifyStellarAddress,
  verifySignature,
  MemoryNonceStore,
  type NonceStore,
} from '../src/auth.js'

const keypair = Keypair.random()
const G = keypair.publicKey()
const M = new MuxedAccount(new Account(G, '0'), '42').accountId()
const C = StrKey.encodeContract(Buffer.alloc(32, 7))

function sign(nonce: string, address: string): string {
  return keypair.sign(Buffer.from(`${nonce}:${address}`, 'utf8')).toString('base64')
}

/** A NonceStore that always accepts, so signature-path assertions don't need a DB. */
const alwaysValidNonce: NonceStore = {
  issue: async () => 'n',
  consume: async () => true,
}

describe('classifyStellarAddress', () => {
  it('distinguishes ed25519, muxed, contract, and invalid', () => {
    expect(classifyStellarAddress(G)).toBe('ed25519')
    expect(classifyStellarAddress(M)).toBe('muxed')
    expect(classifyStellarAddress(C)).toBe('contract')
    expect(classifyStellarAddress('not-a-strkey')).toBe('invalid')
  })
})

describe('verifySignature (issue #71)', () => {
  it('accepts a valid G… signature', () => {
    const r = verifySignature(G, 'nonce1', sign('nonce1', G))
    expect(r).toEqual({ ok: true, ed25519Address: G })
  })

  it('rejects a valid-length but wrong signature as 401 "Invalid signature"', () => {
    const wrong = Keypair.random().sign(Buffer.from('x')).toString('base64')
    expect(verifySignature(G, 'nonce1', wrong)).toEqual({
      ok: false,
      status: 401,
      error: 'Invalid signature',
    })
  })

  it('reports a contract (C…) account as unsupported with a 400, not "Invalid signature"', () => {
    const r = verifySignature(C, 'nonce1', sign('nonce1', C))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.status).toBe(400)
    expect(r.error).toMatch(/contract/i)
    expect(r.error).not.toMatch(/invalid signature/i)
  })

  it('resolves a muxed (M…) address to its underlying G… account and verifies against it', () => {
    const r = verifySignature(M, 'nonce1', sign('nonce1', M))
    expect(r).toEqual({ ok: true, ed25519Address: G })
  })

  it('rejects an unrecognized address format with a 400', () => {
    const r = verifySignature('GARBAGE', 'nonce1', sign('nonce1', 'GARBAGE'))
    expect(r).toMatchObject({ ok: false, status: 400 })
  })

  it('treats a malformed-length signature as invalid without throwing', () => {
    expect(verifySignature(G, 'nonce1', 'not-base64-!!!')).toMatchObject({
      ok: false,
      status: 401,
    })
  })
})

describe('authenticateRequest (issue #70)', () => {
  function headersFor(address: string, nonce = 'nonce1'): Record<string, unknown> {
    return { authorization: `StellarSignature ${address}:${sign(nonce, address)}:${nonce}` }
  }

  it('returns the authenticated address on success', async () => {
    const res = await authenticateRequest(headersFor(G), alwaysValidNonce)
    expect(res).toEqual({ authenticated: true, address: G })
  })

  it('never carries an address on failure — the union makes it a type error to read one', async () => {
    const res = await authenticateRequest({ authorization: 'StellarSignature bad' }, alwaysValidNonce)
    expect(res.authenticated).toBe(false)
    // @ts-expect-error address is not present on the failure branch
    expect(res.address).toBeUndefined()
  })

  it('surfaces the 400 status for a contract account rather than a blanket 401', async () => {
    const res = await authenticateRequest(headersFor(C), alwaysValidNonce)
    expect(res).toMatchObject({ authenticated: false, status: 400 })
  })

  it('keeps existing 401 behaviour for a bad nonce and a bad signature', async () => {
    const rejectingNonce: NonceStore = { issue: async () => 'n', consume: async () => false }
    const badNonce = await authenticateRequest(headersFor(G), rejectingNonce)
    expect(badNonce).toMatchObject({ authenticated: false, status: 401 })

    const store = new MemoryNonceStore()
    const nonce = await store.issue(G)
    const badSig = await authenticateRequest(
      { authorization: `StellarSignature ${G}:${Keypair.random().sign(Buffer.from('x')).toString('base64')}:${nonce}` },
      store,
    )
    expect(badSig).toMatchObject({ authenticated: false, status: 401, error: 'Invalid signature' })
    await store.shutdown()
  })

  it('rejects a target-address mismatch (unchanged 401 behaviour)', async () => {
    const other = Keypair.random().publicKey()
    const res = await authenticateRequest(headersFor(G), alwaysValidNonce, other)
    expect(res).toMatchObject({ authenticated: false, status: 401 })
  })
})
