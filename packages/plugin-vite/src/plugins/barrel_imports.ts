import type { Plugin, ViteDevServer } from "vite";
import { parseAst } from "vite";
import { rolldown, VERSION } from "rolldown";
import { type Loader, Workspace } from "@deno/loader";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isDenoSpecifier, parseDenoSpecifier } from "./deno.ts";

interface Target {
  id: string;
  name: string;
}

interface Barrel {
  sources: string[];
  targets: Map<string, Target>;
}

/**
 * How a module's contents are pinned: `[size, mtime, hash]` for a file
 * (`size` -1 for a virtual module, whose hash is checked by loading it
 * again), or 0 for a module that only the cache key can change, such as an
 * external or a remote module pinned by the lockfile.
 */
type Stamp = [size: number, mtime: number, hash: string] | 0;

type Resolve = (
  source: string,
  importer: string,
) => Promise<{ id: string; external?: unknown } | null>;

interface Probe {
  imports: Map<string, string[]>;
  stamps: Map<string, Stamp>;
  pure: Set<string>;
}

interface Store {
  name: string;
  file: string;
  /** Contents of every module a probe saw. */
  stamps: Map<string, Stamp>;
  /** The import graph the probes saw. */
  imports: Map<string, string[]>;
  importedBy: Map<string, Set<string>>;
  /** Whether a source's whole module graph is free of side effects. */
  known: Map<string, boolean>;
  /** Whether a module is a barrel, read from the contents it was stamped with. */
  shapes: Map<string, { stamp: Stamp; barrel: Barrel | null }>;
  /** `importer\0specifier` to the module it resolves to, or null when it is no candidate. */
  resolutions: Map<string, string | null>;
  queued: Set<string>;
  /** Sources whose probe failed, taken as impure until the next start. */
  failed: Set<string>;
  unread: Set<string>;
  unresolved: Map<string, { importer: string; specifier: string }>;
  droppedBy: Map<string, Set<string>>;
  importers: Map<string, Set<string>>;
  ready: Promise<void>;
  loader?: Promise<Loader>;
  writing?: Promise<void>;
  isDirty: boolean;
}

interface Saved {
  key: string;
  ids: string[];
  /** null for a module no probe saw, false for one that changed since. */
  stamps: (Stamp | null | false)[];
  imports: number[][];
  sources: [id: number, isPure: 0 | 1][];
  shapes: [
    id: number,
    stamp: Stamp,
    sources: number[] | null,
    targets: [exported: string, id: number, local: string][],
  ][];
  resolutions: [importer: number, specifier: string, id: number][];
}

const ENVIRONMENTS = ["client", "ssr"];
const SCRIPT = /\.[cm]?[jt]sx?$/;
const IDLE_WAIT = 1000;
const BUSY_WAIT = 10000;
const MAX_SPLITS = 3;
const CACHE_VERSION = 2;
const PROBE = "\0barrel-probe:";
const MODULE_TYPES: Record<string, "js" | "jsx" | "ts" | "tsx" | "json"> = {
  cjs: "js",
  cts: "ts",
  js: "js",
  json: "json",
  jsx: "jsx",
  mjs: "js",
  mts: "ts",
  ts: "ts",
  tsx: "tsx",
};
const DEBUG = (process.env.DEBUG ?? "").includes("fresh:barrel-imports");

function debug(message: string) {
  if (DEBUG) console.log(`[fresh:barrel-imports] ${message}`);
}

function hash(data: string | Uint8Array) {
  return createHash("sha1").update(data).digest("base64");
}

function readName(node: { type: string; name?: string; value?: unknown }) {
  return node.type === "Identifier" ? node.name : String(node.value);
}

function readExtension(id: string) {
  return id.split(/[?#]/)[0].split(".").pop() ?? "";
}

function isCandidate(id: string) {
  return !id.includes("\0") && !id.includes("?") && SCRIPT.test(id);
}

/** The file behind a module id, or null when it has none. */
function readPath(id: string): string | null {
  if (isDenoSpecifier(id)) {
    const { specifier } = parseDenoSpecifier(id);
    return specifier.startsWith("file:") ? fileURLToPath(specifier) : null;
  }
  if (id.startsWith("\0") || id.includes("?")) return null;
  return id;
}

/**
 * Stats before reading, so a change after the stat moves the mtime away from
 * the stamp and is caught by the hash on the next start.
 */
async function stampFile(file: string) {
  const { size, mtimeMs } = await stat(file);
  const bytes = await readFile(file);
  return { stamp: [size, mtimeMs, hash(bytes)] as Stamp, bytes };
}

async function readBarrel(
  resolve: Resolve,
  id: string,
  code: string,
): Promise<Barrel | null> {
  if (!code.includes("export")) return null;

  // deno-lint-ignore no-explicit-any
  let body: any[];
  try {
    body = parseAst(code, { lang: "js" }).body;
  } catch {
    return null;
  }

  const isBarrel = body.length > 0 &&
    body.every((node) =>
      node.type === "ImportDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      (node.type === "ExportNamedDeclaration" && !node.declaration)
    );
  if (!isBarrel) return null;

  const sources = new Set<string>();
  const targets = new Map<string, Target>();
  for (const node of body) {
    if (!node.source) continue;
    const resolved = await resolve(node.source.value, id);
    if (resolved === null || resolved.external) return null;
    sources.add(resolved.id);
    if (node.type !== "ExportNamedDeclaration") continue;
    for (const specifier of node.specifiers) {
      targets.set(readName(specifier.exported), {
        id: resolved.id,
        name: readName(specifier.local),
      });
    }
  }

  return { sources: [...sources], targets };
}

/**
 * In development, Vite serves every module as its own request and does not
 * tree-shake, so `import { a } from "./barrel.js"` loads every module the
 * barrel re-exports. This rewrites such imports to point straight at the
 * module that defines each name, but only when every module the rewrite
 * would no longer load has no side effects, as decided by the same
 * tree-shaking a production build uses.
 *
 * A transform only uses what is already known. Resolving imports, reading
 * barrels and the probe builds that decide purity all run in the background
 * while the server is idle, so a transform never waits for them, and an
 * import learned about late is rewritten from the next transform or restart
 * on. Everything learned is saved with a stamp of every file it was read
 * from, and is used again after a restart only while those stamps match.
 */
export function barrelImports(): Plugin {
  const stores = new Map<string, Store>();
  const changedAt = new Map<string, number>();
  let tick = 0;
  let lastActive = 0;
  let requests = 0;
  let isWorking = false;
  let isClosed = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let key: Promise<string> | undefined;
  let server: ViteDevServer | undefined;

  async function readKey(devServer: ViteDevServer) {
    const { root, configFile } = devServer.config;
    const files = [
      configFile,
      ...["deno.json", "deno.jsonc", "deno.lock", "package.json"].map((
        name,
      ) => path.join(root, name)),
    ];
    const contents = await Promise.all(
      files.map((file) =>
        file === undefined ? "" : readFile(file, "utf8").catch(() => "")
      ),
    );
    return hash(
      JSON.stringify([CACHE_VERSION, VERSION, files, contents]),
    );
  }

  function link(store: Store, id: string, imports: string[]) {
    for (const imported of store.imports.get(id) ?? []) {
      store.importedBy.get(imported)?.delete(id);
    }
    store.imports.set(id, imports);
    for (const imported of imports) {
      store.importedBy.set(
        imported,
        (store.importedBy.get(imported) ?? new Set()).add(id),
      );
    }
  }

  /** Every module whose import graph reaches one of the given modules. */
  function collectImporters(store: Store, ids: Iterable<string>) {
    const found = new Set<string>(ids);
    const queue = [...found];
    while (queue.length > 0) {
      const current = queue.pop() as string;
      for (const parent of store.importedBy.get(current) ?? []) {
        if (found.has(parent)) continue;
        found.add(parent);
        queue.push(parent);
      }
    }
    return found;
  }

  async function loadVirtual(store: Store, id: string) {
    const result = await server?.environments[store.name]?.pluginContainer
      .load(id);
    if (result === null || result === undefined) return null;
    return typeof result === "string" ? result : result.code;
  }

  /**
   * Returns the stamp, refreshed when only the mtime moved, or null when the
   * module changed.
   */
  async function checkStamp(
    store: Store,
    id: string,
    stamp: Stamp,
  ): Promise<Stamp | null> {
    if (stamp === 0) return stamp;
    const [size, mtime, saved] = stamp;
    if (size === -1) {
      const code = await loadVirtual(store, id).catch(() => null);
      return code !== null && hash(code) === saved ? stamp : null;
    }
    const file = readPath(id);
    if (file === null) return null;
    try {
      const current = await stat(file);
      if (current.size === size && current.mtimeMs === mtime) return stamp;
      const fresh = await stampFile(file);
      return fresh.stamp !== 0 && fresh.stamp[2] === saved ? fresh.stamp : null;
    } catch {
      return null;
    }
  }

  async function restore(store: Store) {
    const started = performance.now();
    let saved: Saved;
    try {
      saved = JSON.parse(await readFile(store.file, "utf8")) as Saved;
    } catch {
      debug(`${store.name}: nothing saved yet`);
      return;
    }
    if (saved.key !== await key) {
      debug(`${store.name}: cache key changed, starting empty`);
      return;
    }

    await Promise.all(
      saved.shapes.map(async ([index, stamp, sources, targets]) => {
        const id = saved.ids[index];
        const checked = await checkStamp(store, id, stamp);
        if (checked === null) return;
        const barrel = sources === null ? null : {
          sources: sources.map((source) => saved.ids[source]),
          targets: new Map(
            targets.map(([exported, target, local]) => [
              exported,
              { id: saved.ids[target], name: local },
            ]),
          ),
        };
        store.shapes.set(id, { stamp: checked, barrel });
      }),
    );
    for (const [importer, specifier, index] of saved.resolutions) {
      const id = index === -1 ? null : saved.ids[index];
      if (id !== null && !store.shapes.has(id)) continue;
      store.resolutions.set(`${saved.ids[importer]}\0${specifier}`, id);
    }

    const valid = await Promise.all(
      saved.ids.map(async (id, index) => {
        const stamp = saved.stamps[index];
        if (stamp === null || stamp === false) return false;
        const checked = await checkStamp(store, id, stamp);
        if (checked === null) return false;
        store.stamps.set(id, checked);
        return true;
      }),
    );
    const stale: string[] = [];
    saved.ids.forEach((id, index) => {
      if (saved.stamps[index] === null) return;
      if (!valid[index]) {
        stale.push(id);
        return;
      }
      link(
        store,
        id,
        saved.imports[index].map((imported) => saved.ids[imported]),
      );
    });
    const tainted = collectImporters(store, stale);

    for (const [index, isPure] of saved.sources) {
      const source = saved.ids[index];
      if (tainted.has(source) || !valid[index]) continue;
      store.known.set(source, isPure === 1);
    }
    debug(
      `${store.name}: restored ${store.known.size}/${saved.sources.length} answers, ${store.shapes.size}/${saved.shapes.length} barrel checks, ${store.resolutions.size}/${saved.resolutions.length} resolutions, ${stale.length} probed modules changed, ${
        Math.round(performance.now() - started)
      } ms`,
    );
  }

  async function persist(store: Store) {
    const index = new Map<string, number>();
    const ids: string[] = [];
    function add(id: string) {
      let found = index.get(id);
      if (found === undefined) {
        found = ids.length;
        index.set(id, found);
        ids.push(id);
      }
      return found;
    }
    for (const id of store.stamps.keys()) add(id);
    const shapes: Saved["shapes"] = [];
    for (const [id, { stamp, barrel }] of store.shapes) {
      shapes.push([
        add(id),
        stamp,
        barrel === null ? null : barrel.sources.map(add),
        barrel === null ? [] : [...barrel.targets].map((
          [exported, target],
        ) => [exported, add(target.id), target.name]),
      ]);
    }
    const resolutions: Saved["resolutions"] = [];
    for (const [pair, id] of store.resolutions) {
      const at = pair.indexOf("\0");
      resolutions.push([
        add(pair.slice(0, at)),
        pair.slice(at + 1),
        id === null ? -1 : add(id),
      ]);
    }
    const imports: number[][] = [];
    for (let at = 0; at < ids.length; at += 1) {
      imports.push((store.imports.get(ids[at]) ?? []).map(add));
    }
    const stamps = ids.map((id) =>
      store.stamps.get(id) ?? (store.imports.has(id) ? false : null)
    );
    const sources: Saved["sources"] = [];
    for (const [source, isPure] of store.known) {
      const found = index.get(source);
      if (found !== undefined) sources.push([found, isPure ? 1 : 0]);
    }
    const saved: Saved = {
      key: await key as string,
      ids,
      stamps,
      imports,
      sources,
      shapes,
      resolutions,
    };
    await mkdir(path.dirname(store.file), { recursive: true });
    const temporary = `${store.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(saved));
    await rename(temporary, store.file);
  }

  function persistLater(store: Store) {
    store.writing = (store.writing ?? Promise.resolve())
      .then(() => persist(store))
      .catch((error) => debug(`${store.name}: cannot save: ${error}`));
  }

  function openStore(name: string): Store {
    let store = stores.get(name);
    if (store !== undefined) return store;
    const config = server?.config;
    const directory = config?.cacheDir ?? path.join("node_modules", ".vite");
    store = {
      name,
      file: path.join(directory, "fresh-barrel-imports", `${name}.json`),
      stamps: new Map(),
      imports: new Map(),
      importedBy: new Map(),
      known: new Map(),
      shapes: new Map(),
      resolutions: new Map(),
      queued: new Set(),
      failed: new Set(),
      unread: new Set(),
      unresolved: new Map(),
      droppedBy: new Map(),
      importers: new Map(),
      ready: Promise.resolve(),
      isDirty: false,
    };
    stores.set(name, store);
    store.ready = restore(store).catch((error) =>
      debug(`${name}: cannot restore: ${error}`)
    );
    return store;
  }

  function openResolve(store: Store): Resolve | null {
    const container = server?.environments[store.name]?.pluginContainer;
    if (container === undefined) return null;
    return (source, importer) => container.resolveId(source, importer);
  }

  /**
   * Bundles one probe per source, each only `import "<source>"`, with the
   * same resolver and tree-shaking as a production build. A probe comes out
   * empty exactly when nothing in that source's module graph has a side
   * effect. Returns null when the graph cannot be bundled.
   */
  async function probeSources(
    store: Store,
    sources: string[],
  ): Promise<Probe | null> {
    store.loader ??= new Workspace({
      platform: store.name === "client" ? "browser" : "node",
      preserveJsx: true,
      cachedOnly: true,
    }).createLoader();
    const loader = await store.loader;
    const container = server?.environments[store.name]?.pluginContainer;
    if (container === undefined) return null;

    const imports = new Map<string, string[]>();
    const stamps = new Map<string, Stamp>();
    try {
      const bundle = await rolldown({
        input: Object.fromEntries(
          sources.map((_, index) => [`probe${index}`, `${PROBE}${index}`]),
        ),
        logLevel: "silent",
        transform: { jsx: { runtime: "automatic", importSource: "preact" } },
        plugins: [{
          name: "fresh:barrel-probe",
          async resolveId(source, importer) {
            if (source.startsWith(PROBE)) return source;
            const resolved = await container.resolveId(
              source,
              importer?.startsWith(PROBE) ? undefined : importer,
            );
            if (resolved === null) {
              throw new Error(`cannot resolve ${source} from ${importer}`);
            }
            return {
              id: resolved.id,
              external: Boolean(resolved.external),
              moduleSideEffects: resolved.moduleSideEffects ?? undefined,
            };
          },
          async load(id) {
            if (id.startsWith(PROBE)) {
              return `import ${
                JSON.stringify(sources[Number(id.slice(PROBE.length))])
              };`;
            }
            if (isDenoSpecifier(id)) {
              const { type, specifier } = parseDenoSpecifier(id);
              const file = readPath(id);
              stamps.set(id, file === null ? 0 : (await stampFile(file)).stamp);
              const result = await loader.load(specifier, type);
              if (result.kind === "external") {
                throw new Error(`cannot load ${specifier}`);
              }
              return {
                code: new TextDecoder().decode(result.code),
                moduleType: MODULE_TYPES[readExtension(specifier)] ?? "js",
              };
            }
            if (id.includes("?")) throw new Error(`cannot load ${id}`);
            if (id.startsWith("\0")) {
              const code = await loadVirtual(store, id);
              if (code === null) throw new Error(`cannot load ${id}`);
              stamps.set(id, [-1, -1, hash(code)]);
              return code;
            }
            const { stamp, bytes } = await stampFile(id);
            stamps.set(id, stamp);
            const moduleType = MODULE_TYPES[readExtension(id)];
            if (moduleType === undefined) return null;
            return { code: new TextDecoder().decode(bytes), moduleType };
          },
          buildEnd() {
            for (const id of this.getModuleIds()) {
              if (id.startsWith(PROBE)) continue;
              const info = this.getModuleInfo(id);
              if (info?.isExternal) stamps.set(id, 0);
              imports.set(id, [
                ...(info?.importedIds ?? []),
                ...(info?.dynamicallyImportedIds ?? []),
              ]);
            }
          },
        }],
      });
      const { output } = await bundle.generate({ format: "esm" });
      await bundle.close();

      const pure = new Set<string>();
      for (const chunk of output) {
        if (
          chunk.type === "chunk" &&
          chunk.isEntry && chunk.facadeModuleId !== null &&
          chunk.imports.length === 0 && chunk.dynamicImports.length === 0 &&
          chunk.code.trim() === ""
        ) {
          pure.add(sources[Number(chunk.facadeModuleId.slice(PROBE.length))]);
        }
      }

      return { imports, stamps, pure };
    } catch (error) {
      debug(`${store.name}: probe of ${sources.length} failed: ${error}`);
      return null;
    }
  }

  async function settle(
    store: Store,
    sources: string[],
    splits: number,
  ): Promise<void> {
    const started = tick;
    const time = performance.now();
    const probe = await probeSources(store, sources);
    debug(
      `${store.name}: probed ${sources.length} sources in ${
        Math.round(performance.now() - time)
      } ms, ${probe === null ? "failed" : `${probe.pure.size} pure`}`,
    );
    if (probe !== null) {
      for (const [id, imported] of probe.imports) {
        const stamp = probe.stamps.get(id);
        if (stamp === undefined) continue;
        store.stamps.set(id, stamp);
        link(store, id, imported);
      }
      const changed = [...probe.imports.keys()].filter((id) =>
        (changedAt.get(id) ?? -1) > started
      );
      for (const id of changed) store.stamps.delete(id);
      const tainted = collectImporters(store, changed);
      for (const source of sources) {
        if (tainted.has(source)) store.queued.add(source);
        else store.known.set(source, probe.pure.has(source));
      }
      return;
    }
    if (isClosed) return;
    if (sources.length === 1 || splits >= MAX_SPLITS) {
      for (const source of sources) store.failed.add(source);
      return;
    }
    const half = Math.ceil(sources.length / 2);
    await settle(store, sources.slice(0, half), splits + 1);
    await settle(store, sources.slice(half), splits + 1);
  }

  /** Resolves the imports transforms could not rewrite for lack of it. */
  async function resolvePending(store: Store, resolve: Resolve) {
    const pending = [...store.unresolved];
    store.unresolved.clear();
    await Promise.all(pending.map(async ([pair, { importer, specifier }]) => {
      const resolved = await resolve(specifier, importer).catch(() => null);
      if (resolved === null) return;
      if (resolved.external || !isCandidate(resolved.id)) {
        store.resolutions.set(pair, null);
        return;
      }
      store.resolutions.set(pair, resolved.id);
      if (!store.shapes.has(resolved.id)) store.unread.add(resolved.id);
    }));
  }

  /**
   * Reads every module waiting to be told barrel or not, then the modules
   * their names lead to, and queues every source of a barrel for a probe.
   */
  async function readPending(store: Store, resolve: Resolve) {
    while (store.unread.size > 0) {
      const ids = [...store.unread];
      store.unread.clear();
      await Promise.all(ids.map(async (id) => {
        if (store.shapes.has(id)) return;
        const started = tick;
        const read = await stampFile(id).catch(() => null);
        if (read === null) return;
        const barrel = await readBarrel(
          resolve,
          id,
          new TextDecoder().decode(read.bytes),
        ).catch(() => undefined);
        if (barrel === undefined) return;
        if ((changedAt.get(id) ?? -1) > started) return;
        store.shapes.set(id, { stamp: read.stamp, barrel });
        for (const target of barrel?.targets.values() ?? []) {
          if (!store.shapes.has(target.id)) store.unread.add(target.id);
        }
        for (const source of barrel?.sources ?? []) {
          if (!store.known.has(source)) store.queued.add(source);
        }
      }));
    }
  }

  function wake() {
    if (idleTimer !== undefined || isWorking || isClosed) return;
    idleTimer = setTimeout(drain, IDLE_WAIT);
  }

  /**
   * Does the queued work once no module has been transformed for a while,
   * and for longer while a request is open (a long-lived one must not hold
   * the work off for good), so it does not compete with a page load.
   */
  async function drain() {
    idleTimer = undefined;
    if (isClosed) return;
    const idle = performance.now() - lastActive;
    if (idle < (requests > 0 ? BUSY_WAIT : IDLE_WAIT)) {
      idleTimer = setTimeout(drain, Math.max(IDLE_WAIT - idle, 100));
      return;
    }
    const store = [...stores.values()].find((store) =>
      store.unresolved.size > 0 || store.unread.size > 0 ||
      store.queued.size > 0
    );
    if (store === undefined) {
      for (const store of stores.values()) {
        if (!store.isDirty) continue;
        store.isDirty = false;
        persistLater(store);
      }
      return;
    }
    isWorking = true;
    try {
      await store.ready;
      const resolve = openResolve(store);
      if (resolve === null) {
        store.unresolved.clear();
        store.unread.clear();
        store.queued.clear();
        return;
      }
      const time = performance.now();
      const pairs = store.unresolved.size;
      const read = store.shapes.size;
      await resolvePending(store, resolve);
      await readPending(store, resolve);
      debug(
        `${store.name}: resolved ${pairs} imports and read ${
          store.shapes.size - read
        } modules in ${Math.round(performance.now() - time)} ms`,
      );
      const sources = [...store.queued].filter((source) =>
        !store.known.has(source)
      );
      store.queued.clear();
      if (sources.length > 0) await settle(store, sources, 0);
      store.isDirty = true;
    } catch (error) {
      debug(`${store.name}: background work failed: ${error}`);
    } finally {
      isWorking = false;
      wake();
    }
  }

  /**
   * Follows each name through nested barrels to the module that defines it,
   * and checks that every source a passed barrel would no longer load is
   * known to be free of side effects. Anything not known yet is queued for
   * the background and keeps this import as it is for now.
   */
  function pickTargets(
    store: Store,
    id: string,
    names: string[],
  ): { barrels: string[]; targets: Target[] } | null {
    const used = new Map<string, Set<string>>();
    const targets: Target[] = [];

    for (const name of names) {
      let current: Target = { id, name };
      for (let depth = 0; depth < 16; depth += 1) {
        const shape = store.shapes.get(current.id);
        if (shape === undefined) {
          store.unread.add(current.id);
          wake();
          return null;
        }
        const next = shape.barrel?.targets.get(current.name);
        if (next === undefined) {
          if (depth === 0) return null;
          break;
        }
        used.set(
          current.id,
          (used.get(current.id) ?? new Set()).add(next.id),
        );
        current = next;
      }
      targets.push(current);
    }

    let isSafe = true;
    for (const [barrelId, kept] of used) {
      const barrel = store.shapes.get(barrelId)?.barrel;
      if (barrel === null || barrel === undefined) return null;
      for (const source of barrel.sources) {
        if (kept.has(source)) continue;
        store.droppedBy.set(
          source,
          (store.droppedBy.get(source) ?? new Set()).add(barrelId),
        );
        const isPure = store.known.get(source);
        if (isPure === undefined && !store.failed.has(source)) {
          store.queued.add(source);
          wake();
        }
        if (isPure !== true) isSafe = false;
      }
    }
    if (!isSafe) return null;

    return { barrels: [...used.keys()], targets };
  }

  function invalidateImporters(store: Store, barrelId: string) {
    const graph = server?.environments[store.name]?.moduleGraph;
    for (const importer of store.importers.get(barrelId) ?? []) {
      for (const module of graph?.getModulesByFile(importer) ?? []) {
        graph?.invalidateModule(module);
      }
    }
    store.importers.delete(barrelId);
  }

  return {
    name: "fresh:barrel-imports",
    apply: "serve",
    enforce: "post",
    configureServer(devServer) {
      server = devServer;
      key = readKey(devServer);
      devServer.middlewares.use((_req, res, next) => {
        requests += 1;
        res.once("close", () => {
          requests -= 1;
          lastActive = performance.now();
        });
        next();
      });
      for (const name of ENVIRONMENTS) {
        if (devServer.environments[name] !== undefined) openStore(name);
      }
    },
    async buildEnd() {
      isClosed = true;
      clearTimeout(idleTimer);
      idleTimer = undefined;
      for (const store of stores.values()) {
        if (!store.isDirty) continue;
        store.isDirty = false;
        persistLater(store);
      }
      await Promise.all([...stores.values()].map((store) => store.writing));
    },
    applyToEnvironment(env) {
      return ENVIRONMENTS.includes(env.name);
    },
    watchChange(id) {
      tick += 1;
      changedAt.set(id, tick);
      for (const store of stores.values()) {
        store.stamps.delete(id);
        const touched = new Set<string>();
        if (store.shapes.delete(id)) touched.add(id);
        for (const source of collectImporters(store, [id])) {
          if (!store.known.delete(source)) continue;
          for (const barrelId of store.droppedBy.get(source) ?? []) {
            touched.add(barrelId);
          }
        }
        for (const barrelId of touched) invalidateImporters(store, barrelId);
      }
    },
    async transform(code, id) {
      lastActive = performance.now();
      if (!isCandidate(id) || !code.includes("import")) return;

      const store = openStore(this.environment.name);
      await store.ready;

      // deno-lint-ignore no-explicit-any
      let body: any[];
      try {
        body = parseAst(code, { lang: "js" }).body;
      } catch {
        return;
      }

      const edits: { start: number; end: number; text: string }[] = [];
      for (const node of body) {
        if (
          node.type !== "ImportDeclaration" ||
          node.importKind === "type" ||
          node.specifiers.length === 0 ||
          // deno-lint-ignore no-explicit-any
          node.specifiers.some((specifier: any) =>
            specifier.type !== "ImportSpecifier"
          )
        ) {
          continue;
        }

        const specifier = node.source.value as string;
        const pair = `${id}\0${specifier}`;
        const resolved = store.resolutions.get(pair);
        if (resolved === undefined) {
          store.unresolved.set(pair, { importer: id, specifier });
          wake();
          continue;
        }
        if (resolved === null) continue;

        const picked = pickTargets(
          store,
          resolved,
          // deno-lint-ignore no-explicit-any
          node.specifiers.map((specifier: any) =>
            readName(specifier.imported) as string
          ),
        );
        if (picked === null) continue;

        for (const barrelId of picked.barrels) {
          this.addWatchFile(barrelId);
          store.importers.set(
            barrelId,
            (store.importers.get(barrelId) ?? new Set()).add(id),
          );
        }
        const original = code.slice(node.start, node.end);
        const lines = original.split("\n").length - 1;
        const text = node.specifiers
          // deno-lint-ignore no-explicit-any
          .map((specifier: any, index: number) =>
            `import { ${
              picked.targets[index].name
            } as ${specifier.local.name} } from ${
              JSON.stringify(picked.targets[index].id)
            };`
          )
          .join(" ");
        edits.push({
          start: node.start,
          end: node.end,
          text: text + "\n".repeat(lines),
        });
      }

      if (edits.length === 0) return;

      const rewritten = edits.reduceRight(
        (result, { start, end, text }) =>
          result.slice(0, start) + text + result.slice(end),
        code,
      );

      return { code: rewritten, map: null };
    },
  };
}
