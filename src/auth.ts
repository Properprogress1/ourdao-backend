import { Keypair } from '@stellar/stellar-sdk'
import { randomBytes } from 'crypto'

// Nonce storage interface - in production this would use Redis or similar
export interface NonceStore {
  issue(address: string): Promise<string>
  consume(address: string, nonce: string): Promise<boolean>
}

// In-memory nonce store for development
export class MemoryNonceStore implements NonceStore {
  private store = new Map<string, { nonce: string; expiresAt: number }>()
  private readonly TTL_MS = 5 * 60 * 1000 // 5 minutes

  async issue(address: string): Promise<string> {
    // Generate a random 32-byte nonce (64 hex chars)
    const nonce = randomBytes(32).toString('hex')
    this.store.set(address, {
      nonce,
      expiresAt: Date.now() + this.TTL_MS
    })
    return nonce
  }

  async consume(address: string, nonce: string): Promise<boolean> {
    const entry = this.store.get(address)
    if (!entry) return false
    if (entry.expiresAt < Date.now()) {
      this.store.delete(address)
      return false
    }
    if (entry.nonce !== nonce) return false
    this.store.delete(address)
    return true
  }
}

export function verifySignature(
  address: string,
  nonce: string,
  signature: string
): boolean {
  try {
    // Create the data that was signed: nonce + address for context
    const data = Buffer.from(`${nonce}:${address}`, 'utf8')
    
    // Convert signature from base64
    const signatureBuffer = Buffer.from(signature, 'base64')
    
    // Verify using Stellar's Keypair.verify
    const keypair = Keypair.fromPublicKey(address)
    return keypair.verify(data, signatureBuffer)
  } catch {
    // Any error means invalid signature
    return false
  }
}

// Helper to extract and validate auth headers
export function extractAuthHeaders(headers: Record<string, unknown>): {
  address: string | null
  signature: string | null
  nonce: string | null
} {
  const authHeader = headers['authorization']
  if (typeof authHeader !== 'string') {
    return { address: null, signature: null, nonce: null }
  }

  // Format: StellarSignature <address>:<signature>:<nonce>
  if (!authHeader.startsWith('StellarSignature ')) {
    return { address: null, signature: null, nonce: null }
  }

  const parts = authHeader.slice('StellarSignature '.length).split(':')
  if (parts.length !== 3) {
    return { address: null, signature: null, nonce: null }
  }

  const [address, signature, nonce] = parts
  return { address: address ?? null, signature: signature ?? null, nonce: nonce ?? null }
}

// Authentication middleware function
export async function authenticateRequest(
  headers: Record<string, unknown>,
  nonceStore: NonceStore,
  targetAddress?: string
): Promise<{ authenticated: boolean; error?: string }> {
  const { address, signature, nonce } = extractAuthHeaders(headers)
  
  if (!address || !signature || !nonce) {
    return { authenticated: false, error: 'Missing authentication headers' }
  }

  // Check if the nonce is valid and hasn't been used
  const nonceValid = await nonceStore.consume(address, nonce)
  if (!nonceValid) {
    return { authenticated: false, error: 'Invalid or expired nonce' }
  }

  // Verify the signature
  const signatureValid = verifySignature(address, nonce, signature)
  if (!signatureValid) {
    return { authenticated: false, error: 'Invalid signature' }
  }

  // If a target address is provided, ensure it matches the authenticated address
  if (targetAddress && targetAddress !== address) {
    return { authenticated: false, error: 'Cannot modify notifications for another address' }
  }

  return { authenticated: true }
}
