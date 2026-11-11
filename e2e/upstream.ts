// Files the resolver picks as "the newest fitting version" change whenever Modrinth ships a
// release, so tests match them by pattern, never by version (CLAUDE.md 7).
export const FABRIC_API_JAR = /^fabric-api-\d+\.\d+\.\d+\+1\.21\.1\.jar$/;
export const FABRIC_API_JAR_OFF = /^fabric-api-\d+\.\d+\.\d+\+1\.21\.1\.jar\.disabled$/;
