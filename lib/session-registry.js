import { engineFailure } from "./errors.js";
import { SessionDatabase } from "./session-database.js";
/** Lazily opened databases, one per Agent. */
export class SessionRegistry {
    #config;
    #databases = new Map();
    #released = false;
    /**
     * @param config - resource limits applied to every session database.
     */
    constructor(config) {
        this.#config = config;
    }
    /**
     * Get the calling Agent's database, opening it on first use.
     * @param agent - live Agent owning the call.
     * @returns the Agent's database.
     */
    async for(agent) {
        if (this.#released)
            throw engineFailure('The analytics plugin was unloaded; reload it before querying again.');
        const existing = this.#databases.get(agent);
        if (existing !== undefined)
            return existing;
        const opening = SessionDatabase.open(this.#config);
        this.#databases.set(agent, opening);
        try {
            return await opening;
        }
        catch (error) {
            this.#databases.delete(agent);
            throw error;
        }
    }
    /**
     * Release one Agent's database after the Agent left the registry.
     * @param agent - the disposed Agent.
     */
    async release(agent) {
        const opening = this.#databases.get(agent);
        if (opening === undefined)
            return;
        this.#databases.delete(agent);
        try {
            await (await opening).close();
        }
        catch {
            // An opening that already failed holds no database to close.
        }
    }
    /** Release every database when the plugin fiber unloads. */
    async releaseAll() {
        this.#released = true;
        const openings = [...this.#databases.values()];
        this.#databases.clear();
        await Promise.allSettled(openings.map(async (opening) => (await opening).close()));
    }
}
