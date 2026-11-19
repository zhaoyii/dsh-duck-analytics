import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'

const workdir = path.resolve(import.meta.dirname, '..')

/** Installed Host client-module registry, when the package is present. */
const REGISTRY_SPECIFIER = '@deepseek-ai/dsh-client-modules'

/**
 * Resolve the installed Host client-module registry.
 * @returns the module, or undefined when the package is not installed.
 */
async function loadRegistry() {
  try {
    return await import(REGISTRY_SPECIFIER)
  } catch {
    return undefined
  }
}

/**
 * Run the Host's own client-row resolver over this plugin's loader entry.
 *
 * The plugin ships a built entry, so the resolver must classify it by the
 * nearest `package.json` rather than by a package specifier.
 * @param ClientModuleRegistry - Host registry class.
 * @returns the resolved row, or undefined when the Host would treat the entry as
 * a non-client plugin.
 */
async function resolveRow(ClientModuleRegistry: { prototype: object }) {
  const registry = Object.create(ClientModuleRegistry.prototype)
  // The resolver only reaches for loader internals when resolving package
  // specifiers; a path entry falls back to URL resolution plus manifest walk-up.
  registry.ctx = { loader: { internal: undefined } }
  const entry = path.join(workdir, 'lib/index.js')
  return registry.resolveMeta(entry, `${pathToFileURL(workdir).href}/`)
}

describe('host client-row resolution', () => {
  it('classifies this plugin as a client row pointing at the built bundle', async (context) => {
    const module = await loadRegistry()
    if (module === undefined) {
      context.skip(`${REGISTRY_SPECIFIER} is not installed`)
      return
    }

    const manifest = JSON.parse(await readFile(path.join(workdir, 'package.json'), 'utf8'))
    const row = await resolveRow(module.ClientModuleRegistry)

    assert.ok(row !== undefined, 'the loader entry must resolve to a package declaring dsh.client')
    assert.equal(row.packageName, manifest.name)
    assert.equal(row.meta.manifestPath, path.join(workdir, 'package.json'))
    assert.equal(row.meta.clientPath, path.join(workdir, manifest.exports['./client']))
    assert.deepEqual(row.meta.external, [])
    assert.equal(row.meta.immediately, false)
    await access(row.meta.clientPath)
  })
})
