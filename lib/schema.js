// The schema builder behind `Config`, resolved through one interop hop.
//
// `@deepseek-ai/schemastery` exports the builder as its DEFAULT export: the module
// namespace of `import('@deepseek-ai/schemastery')` is `{ default: Schema }`, with
// no named `Schema`. Code that destructures `{ Schema }` from it gets `undefined`
// without any error, and `Schema?.object({...})` then yields `undefined` — so the
// plugin declares no `Config`, the platform has no schema to project, its settings
// namespace never appears, and the sidebar panel renders without switches. That is
// a quiet failure two layers away from its cause (measured: the Loader entry's
// config status stayed `absent` while the tools themselves worked), so the shape is
// pinned here, in one place, with a unit test.
//
// A named `Schema` export and a `Schema` property on the default are accepted too:
// other DSH packages re-export the builder in those shapes, and the check below is
// about what can actually build a schema, not about this one package.

/**
 * Pick the schema builder out of a module namespace.
 *
 * @param namespace - a module namespace (`await import(...)`), or anything else.
 * @returns the builder, or null when the namespace carries none.
 */
export function pickSchemaBuilder(namespace) {
  if (namespace === null || typeof namespace !== 'object') return null
  const candidates = [namespace.Schema, namespace.default?.Schema, namespace.default]
  for (const candidate of candidates) {
    // `object` is the entry point every Config needs; requiring it here is what
    // makes a wrong export shape look like a missing builder instead of a schema
    // that throws later, while the composition is already being built.
    if (candidate !== null && candidate !== undefined && typeof candidate.object === 'function') {
      return candidate
    }
  }
  return null
}
