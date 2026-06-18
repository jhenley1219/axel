import argon2 from 'argon2'

export class PasscodeService {
  async hash(passcode: string): Promise<string> {
    return argon2.hash(passcode, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    })
  }

  async verify(passcode: string, hash: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, passcode)
    } catch {
      return false
    }
  }
}
