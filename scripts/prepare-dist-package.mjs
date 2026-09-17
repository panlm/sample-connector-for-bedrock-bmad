// build-only：往 dist/ 写一份「裁剪过」的 package.json，只保留运行时需要的字段。
//
// 背景：Dockerfile / lambda.Dockerfile 都是 COPY ./dist + `npm install --omit=dev`。
// `--omit=dev` 只跳过 dev 依赖的「安装」，不跳过「解析」——npm 仍要解整棵含 dev 的依赖图，
// 于是撞上 dev 依赖间的 peer 冲突（vue-router 要 vite ^7/^8，项目锁 vite ^6）导致 ERESOLVE。
// 镜像里根本不需要 devDependencies，从源头把它裁掉，冲突自然消失。
//
// 运行时唯一读取的 package.json 字段是 version（dist/server/index.js:19
// require("../package.json").version），故 version 必须保留在白名单内。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

// 运行时白名单：将来运行时若需新字段，只在这里追加。
const KEEP = ["name", "version", "main", "license", "dependencies"];

export function makeRuntimePackage(pkg) {
  const out = {};
  for (const k of KEEP) {
    if (pkg[k] !== undefined) out[k] = pkg[k];
  }
  return out;
}

// 仅在被直接执行时写盘；被 test import 时不产生副作用。
const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const src = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const runtime = makeRuntimePackage(src);
  const distDir = resolve(root, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    resolve(distDir, "package.json"),
    JSON.stringify(runtime, null, 2) + "\n",
    "utf8"
  );
  console.log(
    `wrote dist/package.json (kept: ${Object.keys(runtime).join(", ")}; devDependencies dropped)`
  );
}
