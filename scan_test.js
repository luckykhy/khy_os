const { collectTraeOfficialArtifacts, resolveTraeOfficialCredential } = require('./backend/src/services/gateway/adapters/traeOfficialArtifacts');
const cred = resolveTraeOfficialCredential();
console.log(JSON.stringify(cred, null, 2));
