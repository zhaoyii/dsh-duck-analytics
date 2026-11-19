/**
 * Ownership of one session database per live Agent.
 *
 * The registry is plugin-scoped state: it lives exactly as long as the plugin
 * fiber and hands each Agent its own database. An Agent is the isolation and
 * authorization subject, so the registry is keyed by the live Agent object and
 * never by a model-supplied or client-supplied identifier.
 *
 * @module duckdb-analytics/session-registry
 */
import type { Agent } from '@deepseek-ai/dsh-agent'

import { engineFailure } from './errors.ts'
import { SessionDatabase, type SessionDatabaseConfig } from './session-database.ts'

/** Lazily opened databases, one per Agent. */
export class SessionRegistry {
  readonly #config: SessionDatabaseConfig
  readonly #databases = new Map<Agent, Promise<SessionDatabase>>()
  #released = false

  /**
   * @param config - resource limits applied to every session database.
   */
  constructor(config: SessionDatabaseConfig) {
    this.#config = config
  }

  /**
   * Get the calling Agent's database, opening it on first use.
   * @param agent - live Agent owning the call.
   * @returns the Agent's database.
   */
  async for(agent: Agent): Promise<SessionDatabase> {
    if (this.#released) throw engineFailure('The analytics plugin was unloaded; reload it before querying again.')
    const existing = this.#databases.get(agent)
    if (existing !== undefined) return existing
    const opening = SessionDatabase.open(this.#config)
    this.#databases.set(agent, opening)
    try {
      return await opening
    } catch (error) {
      this.#databases.delete(agent)
      throw error
    }
  }

  /**
   * Release one Agent's database after the Agent left the registry.
   * @param agent - the disposed Agent.
   */
  async release(agent: Agent): Promise<void> {
    const opening = this.#databases.get(agent)
    if (opening === undefined) return
    this.#databases.delete(agent)
    try {
      await (await opening).close()
    } catch {
      // An opening that already failed holds no database to close.
    }
  }

  /** Release every database when the plugin fiber unloads. */
  async releaseAll(): Promise<void> {
    this.#released = true
    const openings = [...this.#databases.values()]
    this.#databases.clear()
    await Promise.allSettled(openings.map(async opening => (await opening).close()))
  }
}
