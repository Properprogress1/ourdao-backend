import { Keypair, StrKey } from '@stellar/stellar-sdk'
import { randomBytes } from 'crypto'
import type { Pool } from 'pg'

// Nonce storage interface - in production this would use Redis or similar
export interface NonceStore {
  issue(address: string): Promise<string>
  consume(address: string, nonce: string): Promise<boolean>
}

// In-memory nonce store for development
export class MemoryNonceStore implements NonceStore {
  private store = new Map<string, { nonce: string; expiresAt: number }>()
  private readonly TTL_MS = 5 * 60 * 1000 // 5 minutes
  private readonly MAX_ENTRIES = 10000 // Hard cap on stored entries
  private sweepTimer: NodeJS.Timeout | null = null

  constructor() {
    // Start periodic sweep of expired entries, unref'd so it doesn't hold process open
    this.startSweep()
  }

  private startSweep(): void {
    // Sweep every minute to clean up expired entries
    this.sweepTimer = setInterval(() => {
      const now = Date.now()
      let evictedCount = 0
      for (const [key, entry] of this.store.entries()) {
        if (entry.expiresAt < now) {
          this.store.delete(key)
          evictedCount++
        }
      }
      if (evictedCount > 0) {
        // Could log this if needed: console.debug(`MemoryNonceStore: evicted ${evictedCount} expired entries`)
      }
    }, 60 * 1000) // Every minute
    // Unref the timer so it doesn't prevent graceful shutdown
    if (this.sweepTimer.unref) {
      this.sweepTimer.unref()
    }
  }

  async shutdown(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  async issue(address: string): Promise<string> {
    // Generate a random 32-byte nonce (64 hex chars)
    const nonce = randomBytes(32).toString('hex')
    
    // If we're at capacity, reject new challenges to prevent DoS
    if (this.store.size >= this.MAX_ENTRIES) {
      throw new Error('Nonce store capacity exceeded')
    }
    
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

// Postgres-backed nonce store for production (issue #66)
// Uses atomic DELETE ... WHERE to ensure a nonce can only be consumed once,
// even with concurrent requests across multiple API instances.
export class PostgresNonceStore implements NonceStore {
  private pool: Pool
  private readonly TTL_MS = 5 * 60 * 1000 // 5 minutes
  private cleanupTimer: NodeJS.Timeout | null = null

  constructor(pool: Pool) {
    this.pool = pool
    this.startCleanup()
  }

  private startCleanup(): void {
    // Clean up expired nonces every 10 minutes
    this.cleanupTimer = setInterval(async () => {
      try {
        await this.pool.query(
          `DELETE FROM auth_nonces WHERE expires_at <= now()`
        )
      } catch (error) {
        // Log but don't throw - cleanup failure shouldn't crash the process
      }
    }, 10 * 60 * 1000) // Every 10 minutes
    // Unref the timer so it doesn't prevent graceful shutdown
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref()
    }
  }

  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  async issue(address: string): Promise<string> {
    const nonce = randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + this.TTL_MS)

    // Insert the nonce. If an address already has a nonce, replace it (UPSERT via ON CONFLICT)
    await this.pool.query(
      `INSERT INTO auth_nonces (address, nonce, expires_at) 
       VALUES ($1, $2, $3)
       ON CONFLICT (address) DO UPDATE 
       SET nonce = $2, expires_at = $3`,
      [address, nonce, expiresAt]
    )

    return nonce
  }

  async consume(address: string, nonce: string): Promise<boolean> {
    // Atomically: DELETE the row if it exists, not expired, and nonce matches
    const result = await this.pool.query(
      `DELETE FROM auth_nonces 
       WHERE address = $1 AND nonce = $2 AND expires_at > now()
       RETURNING address`,
      [address, nonce]
    )

    // If a row was deleted, the nonce was valid
    return result.rows.length > 0
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

// Validate a string as a Stellar public key
export function isValidStellarAddress(address: string): boolean {
  try {
    // Use StrKey to validate
    return StrKey.isValidEd25519PublicKey(address)
  } catch {
    return false
  }
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
