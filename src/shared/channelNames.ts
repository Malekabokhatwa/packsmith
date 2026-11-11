// Plain list of IPC channel names, with no imports, so the sandboxed preload can bundle it
// without pulling in any npm package. ipc.ts checks it matches the contracts exactly.
export const CHANNEL_NAMES = [
  "settings:get", "settings:setLauncher", "settings:acceptEula", "settings:setBudgets", "tests:last", "tests:run", "tests:progress", "crash:pick", "packs:export", "packs:graph", "modrinth:cards", "packs:openInPrism", "client:status", "launcher:status", "mc:versions",
  "packs:list", "packs:create", "packs:scan", "packs:install", "packs:openFolder", "modrinth:search",
  "search:status", "search:set", "search:setKey",
  "adoption:discover", "adoption:adopt", "adoption:revoke",
  "packs:setEnabled", "packs:remove", "packs:update", "journal:list", "journal:undo",
  "quests:get", "quests:engines", "quests:installEngine", "quests:removeChapter", "quests:icons",
  "provider:status", "provider:setKey", "provider:clearKey", "provider:setModel", "provider:setProvider", "provider:setLocalEndpoint",
  "chat:list", "chat:rename", "chat:delete", "chat:deleteAll", "chat:get", "chat:send", "run:stop", "run:pause",
] as const;

// Main -> renderer push channel for live run events (not an invoke channel).
export const RUN_EVENT_CHANNEL = "run:event";
