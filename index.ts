#!/usr/bin/env -S deno --allow-net
// Copyright 2018-2020 the Deno authors. All rights reserved. MIT license.
// This program serves files in the current directory over HTTP.
// TODO Stream responses instead of reading them into memory.
// TODO Add tests like these:
// https://github.com/indexzero/http-server/blob/master/test/http-server-test.js
const { args, stat, readDir, open, exit } = Deno;
import { posix, extname } from "https://deno.land/std/path/mod.ts";
import { listenAndServe, ServerRequest, Response } from "https://deno.land/std/http/server.ts";
import { parse } from "https://deno.land/std/flags/mod.ts";
import { assert } from "https://deno.land/std/testing/asserts.ts";
interface EntryInfo {
  mode: string;
  size: string;
  url: string;
  name: string;
}
interface FileServerArgs {
  _: string[];
  // -p --port
  p: number;
  port: number;
  // --cors
  cors: boolean;
  // -h --help
  h: boolean;
  help: boolean;
}
const encoder = new TextEncoder();
const serverArgs = parse(args) as FileServerArgs;
const CORSEnabled = serverArgs.cors ? true : false;
const target = posix.resolve(serverArgs._[1] ?? "");
const addr = `0.0.0.0:${serverArgs.port ?? serverArgs.p ?? 4507}`;
const MEDIA_TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".map": "application/json",
  ".txt": "text/plain",
  ".ts": "text/typescript",
  ".tsx": "text/tsx",
  ".js": "application/javascript",
  ".jsx": "text/jsx",
  ".gz": "application/gzip",
  ".css": "text/css",
};
/** Returns the content-type based on the extension of a path. */
function contentType(path: string): string | undefined {
  return MEDIA_TYPES[extname(path)];
}
if (serverArgs.h ?? serverArgs.help) {
  console.log(`Deno File Server
  Serves a local directory in HTTP.
INSTALL:
  deno install --allow-net --allow-read https://deno.land/std/http/file_server.ts
USAGE:
  file_server [path] [options]
OPTIONS:
  -h, --help          Prints help information
  -p, --port <PORT>   Set port
  --cors              Enable CORS via the "Access-Control-Allow-Origin" header`);
  exit();
}
function modeToString(isDir: boolean, maybeMode: number | null): string {
  const modeMap = ["---", "--x", "-w-", "-wx", "r--", "r-x", "rw-", "rwx"];
  if (maybeMode === null) {
    return "(unknown mode)";
  }
  const mode = maybeMode.toString(8);
  if (mode.length < 3) {
    return "(unknown mode)";
  }
  let output = "";
  mode
    .split("")
    .reverse()
    .slice(0, 3)
    .forEach((v): void => {
      output = modeMap[+v] + output;
    });
  output = `(${isDir ? "d" : "-"}${output})`;
  return output;
}
function fileLenToString(len: number): string {
  const multiplier = 1024;
  let base = 1;
  const suffix = ["B", "K", "M", "G", "T"];
  let suffixIndex = 0;
  while (base * multiplier < len) {
    if (suffixIndex >= suffix.length - 1) {
      break;
    }
    base *= multiplier;
    suffixIndex++;
  }
  return `${(len / base).toFixed(2)}${suffix[suffixIndex]}`;
}
export async function serveFile(
  req: ServerRequest,
  filePath: string
): Promise<Response> {
  const [file, fileInfo] = await Promise.all([open(filePath), stat(filePath)]);
  const headers = new Headers();
  headers.set("content-length", fileInfo.size.toString());
  const contentTypeValue = contentType(filePath);
  if (contentTypeValue) {
    headers.set("content-type", contentTypeValue);
  }
  return {
    status: 200,
    body: file,
    headers,
  };
}
// TODO: simplify this after deno.stat and deno.readDir are fixed
async function serveDir(
  req: ServerRequest,
  dirPath: string
): Promise<Response> {
  const dirUrl = `/${posix.relative(target, dirPath)}`;
  const listEntry: EntryInfo[] = [];
  for await (const entry of readDir(dirPath)) {
    const filePath = posix.join(dirPath, entry.name);
    const fileUrl = posix.join(dirUrl, entry.name);
    if (entry.name === "index.html" && entry.isFile) {
      // in case index.html as dir...
      return serveFile(req, filePath);
    }
    // Yuck!
    let fileInfo = null;
    try {
      fileInfo = await stat(filePath);
    } catch (e) {}
    listEntry.push({
      mode: modeToString(entry.isDirectory, fileInfo?.mode ?? null),
      size: entry.isFile ? fileLenToString(fileInfo?.size ?? 0) : "",
      name: entry.name,
      url: fileUrl,
    });
  }
  listEntry.sort((a, b) =>
    a.name.toLowerCase() > b.name.toLowerCase() ? 1 : -1
  );
  const formattedDirUrl = `${dirUrl.replace(/\/$/, "")}/`;
  const page = encoder.encode(dirViewerTemplate(formattedDirUrl, listEntry));
  const headers = new Headers();
  headers.set("content-type", "text/html");
  const res = {
    status: 200,
    body: page,
    headers,
  };
  return res;
}
function serveFallback(req: ServerRequest, e: Error): Promise<Response> {
  if (e instanceof Deno.errors.NotFound) {
    return Promise.resolve({
      status: 404,
      body: encoder.encode("Not found"),
    });
  } else {
    return Promise.resolve({
      status: 500,
      body: encoder.encode("Internal server error"),
    });
  }
}
function serverLog(req: ServerRequest, res: Response): void {
  const d = new Date().toISOString();
  const dateFmt = `[${d.slice(0, 10)} ${d.slice(11, 19)}]`;
  const s = `${dateFmt} "${req.method} ${req.url} ${req.proto}" ${res.status}`;
  console.log(s);
}
function setCORS(res: Response): void {
  if (!res.headers) {
    res.headers = new Headers();
  }
  res.headers.append("access-control-allow-origin", "*");
  res.headers.append(
    "access-control-allow-headers",
    "Origin, X-Requested-With, Content-Type, Accept, Range"
  );
}
function dirViewerTemplate(dirname: string, entries: EntryInfo[]): string {
  return html`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta http-equiv="X-UA-Compatible" content="ie=edge" />
        <title>Deno File Server</title>
        <style>
          :root {
            --background-color: #fafafa;
            --color: rgba(0, 0, 0, 0.87);
          }
          @media (prefers-color-scheme: dark) {
            :root {
              --background-color: #303030;
              --color: #fff;
            }
          }
          @media (min-width: 960px) {
            main {
              max-width: 960px;
            }
            body {
              padding-left: 32px;
              padding-right: 32px;
            }
          }
          @media (min-width: 600px) {
            main {
              padding-left: 24px;
              padding-right: 24px;
            }
          }
          body {
            background: var(--background-color);
            color: var(--color);
            font-family: "Roboto", "Helvetica", "Arial", sans-serif;
            font-weight: 400;
            line-height: 1.43;
            font-size: 0.875rem;
          }
          a {
            color: #2196f3;
            text-decoration: none;
          }
          a:hover {
            text-decoration: underline;
          }
          table th {
            text-align: left;
          }
          table td {
            padding: 12px 24px 0 0;
          }
        </style>
      </head>
      <body>
        <main>
          <h1>Brr brr deng</h1>
        </main>
      </body>
    </html>
  `;
}
function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  const l = strings.length - 1;
  let html = "";
  for (let i = 0; i < l; i++) {
    let v = values[i];
    if (v instanceof Array) {
      v = v.join("");
    }
    const s = strings[i] + v;
    html += s;
  }
  html += strings[l];
  return html;
}
function main(): void {
  listenAndServe(
    addr,
    async (req): Promise<void> => {
      let normalizedUrl = posix.normalize(req.url);
      try {
        normalizedUrl = decodeURIComponent(normalizedUrl);
      } catch (e) {
        if (!(e instanceof URIError)) {
          throw e;
        }
      }
      const fsPath = posix.join(target, normalizedUrl);
      let response: Response | undefined;
      try {
        const fileInfo = await stat(fsPath);
        if (fileInfo.isDirectory) {
          response = await serveDir(req, fsPath);
        } else {
          response = await serveFile(req, fsPath);
        }
      } catch (e) {
        console.error(e.message);
        response = await serveFallback(req, e);
      } finally {
        if (CORSEnabled) {
          assert(response);
          setCORS(response);
        }
        serverLog(req, response!);
        req.respond(response!);
      }
    }
  );
  console.log(`HTTP server listening on http://${addr}/`);
}
if (import.meta.main) {
  main();
}