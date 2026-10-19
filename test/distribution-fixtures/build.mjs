import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
export async function buildFixture(output) {
  const root = resolve(output);
  for (const p of ["generated", "apps/a", "apps/b", "resources", "updates", "authored"]) await mkdir(join(root,p),{recursive:true});
  for (const name of ["bootstrap.sh","diagnose.ps1"]) await copyFile(fileURLToPath(new URL(`authored/${name}`,import.meta.url)),join(root,"authored",name));
  await writeFile(join(root,"generated/bootstrap.mjs"),'console.log("generated:" + (process.argv[2] ?? "1.0.0"));\n');
  for (const app of ["a","b"]) await writeFile(join(root,`apps/${app}/run.mjs`),`console.log(${JSON.stringify(app)});\n`);
  await writeFile(join(root,"resources/payload.bin"),Buffer.from([0,255,13,10,128,7]));
  const json=Buffer.from('\ufeff{"version":"1.0.0","package":"https://example.invalid/releases/fixture.zip"}\r\n');
  const key=createPrivateKey({key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),Buffer.alloc(32,7)]),format:"der",type:"pkcs8"});
  await writeFile(join(root,"updates/latest.json"),json);
  await writeFile(join(root,"updates/latest.json.sig"),sign(null,json,key));
  await writeFile(join(root,"updates/public.pem"),createPublicKey(key).export({format:"pem",type:"spki"}));
  return root;
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) await buildFixture(process.argv[2]??"distribution-smoke");
