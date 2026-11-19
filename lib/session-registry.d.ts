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
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionDatabase, type SessionDatabaseConfig } from './session-database.ts';
/** Lazily opened databases, one per Agent. */
export declare class SessionRegistry {
    #private;
    /**
     * @param config - resource limits applied to every session database.
     */
    constructor(config: SessionDatabaseConfig);
    /**
     * Get the calling Agent's database, opening it on first use.
     * @param agent - live Agent owning the call.
     * @returns the Agent's database.
     */
    for(agent: Agent): Promise<SessionDatabase>;
    /**
     * Release one Agent's database after the Agent left the registry.
     * @param agent - the disposed Agent.
     */
    release(agent: Agent): Promise<void>;
    /** Release every database when the plugin fiber unloads. */
    releaseAll(): Promise<void>;
}
