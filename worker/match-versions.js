// The rules versions of a Worker build (tools/build-worker.mjs generates this module for a release build):
//   retainedMatchVersions   id → restore(checkpoint, deps) of the older versions whose recovery engine the build keeps
//   prepareMatchVersion(id) initializes that engine before a room restores a match of it (lazy: startup CPU budget)
//   publishedRulesVersions  every version whose browser replay engine the deployment publishes
// Development and test builds keep none.
export const retainedMatchVersions = {};
export async function prepareMatchVersion() {}
export const publishedRulesVersions = [];
