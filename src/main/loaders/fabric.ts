// Fabric loader lookup (part of M-4). In Prism mode the loader is a component in mmc-pack.json and
// Prism downloads it on first launch (LDR-2), so all we need is the version number.
import { z } from "zod";
import type { Http } from "../net/http";
import { AppError } from "../errors";

const LoaderList = z.array(z.object({ loader: z.object({ version: z.string(), stable: z.boolean() }) }));

export async function latestStableFabricLoader(http: Http, mcVersion: string): Promise<string> {
  const data = await http.json(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`, {
    allowHosts: ["meta.fabricmc.net"],
  });
  const list = LoaderList.safeParse(data);
  if (!list.success) throw new AppError("fabric-format", "Fabric's version service sent something packsmith doesn't understand.");
  const stable = list.data.find((e) => e.loader.stable) ?? list.data[0];
  if (!stable) throw new AppError("no-loader", `Fabric has no loader for Minecraft ${mcVersion}.`);
  return stable.loader.version;
}
