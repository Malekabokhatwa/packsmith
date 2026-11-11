// A stand-in for a Minecraft server in process tests: behaviour chosen by argv[2].
// ok: boots, loads a world, exits on "stop". crash: dies before booting. hang: boots, never loads.
// stubborn: loads a world, ignores "stop". child: like hang, plus a grandchild in the same group.
const mode = process.argv[2];
const say = (s) => process.stdout.write(`[12:00:00] [Server thread/INFO]: ${s}\n`);
if (mode === "crash") {
  process.stderr.write("[12:00:00] [main/ERROR]: Incompatible mods found!\n");
  process.exit(1);
}
say("Starting minecraft server version 1.21.1");
if (mode === "hang" || mode === "child") {
  if (mode === "child") {
    const { spawn } = require("node:child_process");
    const g = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    process.stdout.write(`GRANDCHILD ${g.pid}\n`);
  }
  setInterval(() => {}, 1000);
} else {
  setTimeout(() => {
    say('Done (0.5s)! For help, type "help"');
    if (mode === "stubborn") return setInterval(() => {}, 1000);
    process.stdin.on("data", (d) => { if (String(d).includes("stop")) { say("Stopping server"); process.exit(0); } });
  }, 50);
}
