import { resolvePilotHome } from "../../pilot/index.js";
import { maintainSessionStorage } from "../../session/storage/SessionStorageMaintenance.js";

export async function runSessionStorageCli(argv: string[]): Promise<void> {
  if (argv[0] !== "compact") {
    throw new Error("Usage: pilotdeck session compact [--idle-days 30] [--dry-run] [--allow-format-upgrade] [--pilot-home <path>]");
  }
  let pilotHome = resolvePilotHome(process.env);
  let idleDays = 30;
  let dryRun = false;
  let allowFormatUpgrade = false;
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--dry-run") dryRun = true;
    else if (flag === "--allow-format-upgrade") allowFormatUpgrade = true;
    else if (flag === "--idle-days" && argv[index + 1]) idleDays = Number(argv[++index]);
    else if (flag === "--pilot-home" && argv[index + 1]) pilotHome = argv[++index];
    else throw new Error(`Unknown or incomplete option: ${flag}`);
  }
  if (!dryRun && !allowFormatUpgrade) {
    throw new Error("Compression changes the transcript format. Back up the PilotDeck home and upgrade all readers, then pass --allow-format-upgrade; use --dry-run to preview without changes.");
  }
  const result = await maintainSessionStorage({ pilotHome, idleDays, dryRun, maxFiles: Number.POSITIVE_INFINITY });
  console.log(JSON.stringify({ dryRun, ...result }, null, 2));
  if (result.failures.length) process.exitCode = 1;
}
