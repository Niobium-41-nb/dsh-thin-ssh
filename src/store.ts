/**
 * Durable profile store.
 *
 * One small JSON file, written atomically through a temporary sibling. The
 * plugin never caches the document: a hand-edited file takes effect on the next
 * tool call, which matters because the agent may fix a host alias between calls.
 * @module dsh-thin-ssh/store
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ProfileDocument, SshProfile } from './types.ts'

/** Empty document used both for a missing file and for the first write. */
export function emptyDocument(): ProfileDocument {
  return { version: 1, default: '', profiles: {} }
}

/** Structural check for a persisted document. */
function parseDocument(text: string, file: string): ProfileDocument {
  const value: unknown = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid profile store ${file}: expected an object`)
  }
  const doc = value as Partial<ProfileDocument>
  if (doc.version !== 1 || doc.profiles === null || typeof doc.profiles !== 'object' || Array.isArray(doc.profiles)) {
    throw new Error(`invalid profile store ${file}: expected version 1 with a profiles object`)
  }
  return {
    version: 1,
    default: typeof doc.default === 'string' ? doc.default : '',
    profiles: doc.profiles as Record<string, SshProfile>,
  }
}

/** Read/upsert/remove operations over `profiles.json`. */
export class ProfileStore {
  /** Absolute path of the JSON document. */
  readonly file: string

  constructor(file: string) {
    this.file = file
  }

  /** Read the current document; a missing file reads as empty. */
  read(): ProfileDocument {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return emptyDocument()
      throw error
    }
    return parseDocument(text, this.file)
  }

  /** List persisted profile names in stable order. */
  names(): string[] {
    return Object.keys(this.read().profiles).sort()
  }

  /** Read one profile or throw a message the model can act on. */
  get(name: string): SshProfile {
    const profile = this.read().profiles[name]
    if (profile === undefined) throw new Error(`unknown SSH profile "${name}"`)
    return profile
  }

  /** Write a document without ever exposing a partially written file. */
  write(document: ProfileDocument): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    try {
      renameSync(temporary, this.file)
    } catch (error) {
      try {
        unlinkSync(temporary)
      } catch {
        // The rename failure is the outcome that matters.
      }
      throw error
    }
  }

  /** Create or replace one profile; the first profile becomes the default. */
  upsert(name: string, profile: SshProfile): ProfileDocument {
    const document = this.read()
    const isFirst = Object.keys(document.profiles).length === 0
    const next: ProfileDocument = {
      version: 1,
      default: document.default === '' && isFirst ? name : document.default,
      profiles: { ...document.profiles, [name]: profile },
    }
    this.write(next)
    return next
  }

  /** Remove one profile, clearing the default when it was the removed one. */
  remove(name: string): ProfileDocument {
    const document = this.read()
    if (document.profiles[name] === undefined) throw new Error(`unknown SSH profile "${name}"`)
    const profiles = { ...document.profiles }
    delete profiles[name]
    const next: ProfileDocument = {
      version: 1,
      default: document.default === name ? '' : document.default,
      profiles,
    }
    this.write(next)
    return next
  }

  /** Change the profile used when a tool call omits `profile`. */
  setDefault(name: string): ProfileDocument {
    const document = this.read()
    if (document.profiles[name] === undefined) throw new Error(`unknown SSH profile "${name}"`)
    const next: ProfileDocument = { ...document, default: name }
    this.write(next)
    return next
  }
}
