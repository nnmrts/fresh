import type { Plugin, Rollup, ViteDevServer } from "vite";
import { parseAst } from "vite";
import { rolldown } from "rolldown";
import { type Loader, Workspace } from "@deno/loader";
import { readFile } from "node:fs/promises";
import { isDenoSpecifier, parseDenoSpecifier } from "./deno.ts";

interface Target {
  id: string;
  name: string;
}

interface Barrel {
  sources: string[];
  targets: Map<string, Target>;
}

interface Probe {
  importedBy: Map<string, Set<string>>;
  pure: Set<string>;
}

interface Pending {
  source: string;
  settle: (isPure: boolean) => void;
}

const SCRIPT = /\.[cm]?[jt]sx?$/;
const BATCH_WAIT = 100;
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

function readName(node: { type: string; name?: string; value?: unknown }) {
  return node.type === "Identifier" ? node.name : String(node.value);
}

async function readBarrel(
  context: Rollup.TransformPluginContext,
  id: string,
): Promise<Barrel | null> {
  const code = await readFile(id, "utf8").catch(() => null);
  if (code === null || !code.includes("export")) return null;

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
    const resolved = await context.resolve(node.source.value, id);
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
 * Bundles one probe per source, each only `import "<source>"`, with the same
 * resolver and tree-shaking as a production build. A probe comes out empty
 * exactly when nothing in that source's module graph has a side effect.
 * Returns null when the graph cannot be bundled.
 */
async function probeSources(
  context: Rollup.TransformPluginContext,
  loader: Loader,
  sources: string[],
): Promise<Probe | null> {
  const importedBy = new Map<string, Set<string>>();
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
          const resolved = await context.resolve(
            source,
            importer?.startsWith(PROBE) ? undefined : importer,
          );
          if (resolved === null) {
            throw new Error(`cannot resolve ${source} from ${importer}`);
          }
          return {
            id: resolved.id,
            external: resolved.external,
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
            const result = await loader.load(specifier, type);
            if (result.kind === "external") {
              throw new Error(`cannot load ${specifier}`);
            }
            const extension = specifier.split(/[?#]/)[0].split(".").pop() ??
              "";
            return {
              code: new TextDecoder().decode(result.code),
              moduleType: MODULE_TYPES[extension] ?? "js",
            };
          }
          if (id.startsWith("\0") || id.includes("?")) {
            throw new Error(`cannot load ${id}`);
          }
          return null;
        },
        buildEnd() {
          for (const id of this.getModuleIds()) {
            const info = this.getModuleInfo(id);
            for (
              const imported of [
                ...(info?.importedIds ?? []),
                ...(info?.dynamicallyImportedIds ?? []),
              ]
            ) {
              importedBy.set(
                imported,
                (importedBy.get(imported) ?? new Set()).add(id),
              );
            }
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

    return { importedBy, pure };
  } catch {
    return null;
  }
}

/**
 * In development, Vite serves every module as its own request and does not
 * tree-shake, so `import { a } from "./barrel.js"` loads every module the
 * barrel re-exports. This rewrites such imports to point straight at the
 * module that defines each name, but only when every module the rewrite
 * would no longer load has no side effects, as decided by the same
 * tree-shaking a production build uses.
 */
export function barrelImports(): Plugin {
  const barrels = new Map<string, Promise<Barrel | null>>();
  const purity = new Map<string, Promise<boolean>>();
  const graphs: Probe["importedBy"][] = [];
  const droppedBy = new Map<string, Set<string>>();
  const importers = new Map<string, Set<string>>();
  let pending: Pending[] = [];
  let isScheduled = false;
  let loader: Promise<Loader> | undefined;
  let server: ViteDevServer | undefined;

  function loadBarrel(context: Rollup.TransformPluginContext, id: string) {
    let barrel = barrels.get(id);
    if (barrel === undefined) {
      barrel = readBarrel(context, id);
      barrels.set(id, barrel);
    }
    return barrel;
  }

  async function settle(
    context: Rollup.TransformPluginContext,
    taken: Pending[],
  ): Promise<void> {
    loader ??= new Workspace({
      platform: "browser",
      preserveJsx: true,
      cachedOnly: true,
    }).createLoader();
    const probe = await probeSources(
      context,
      await loader,
      taken.map(({ source }) => source),
    );
    if (probe !== null) {
      graphs.push(probe.importedBy);
      for (const { settle, source } of taken) settle(probe.pure.has(source));
      return;
    }
    if (taken.length === 1) {
      taken[0].settle(false);
      return;
    }
    const half = Math.ceil(taken.length / 2);
    await Promise.all([
      settle(context, taken.slice(0, half)),
      settle(context, taken.slice(half)),
    ]);
  }

  /**
   * Answers whether a source's whole module graph is free of side effects.
   * Questions asked close together go into one build, so modules they share
   * are bundled once.
   */
  function isPure(context: Rollup.TransformPluginContext, source: string) {
    let known = purity.get(source);
    if (known === undefined) {
      known = new Promise((resolve) =>
        pending.push({ source, settle: resolve })
      );
      purity.set(source, known);
      if (!isScheduled) {
        isScheduled = true;
        setTimeout(() => {
          isScheduled = false;
          const taken = pending;
          pending = [];
          void settle(context, taken);
        }, BATCH_WAIT);
      }
    }
    return known;
  }

  /**
   * Follows each name through nested barrels to the module that defines it,
   * and checks that every source a passed barrel would no longer load is
   * free of side effects.
   */
  async function pickTargets(
    context: Rollup.TransformPluginContext,
    id: string,
    names: string[],
  ): Promise<{ barrels: string[]; targets: Target[] } | null> {
    const used = new Map<string, Set<string>>();
    const targets: Target[] = [];

    for (const name of names) {
      let current: Target = { id, name };
      for (let depth = 0; depth < 16; depth += 1) {
        const barrel = await loadBarrel(context, current.id);
        const next = barrel?.targets.get(current.name);
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

    const asked: Promise<boolean>[] = [];
    for (const [barrelId, kept] of used) {
      const barrel = await loadBarrel(context, barrelId);
      if (barrel === null) return null;
      for (const source of barrel.sources) {
        if (kept.has(source)) continue;
        droppedBy.set(
          source,
          (droppedBy.get(source) ?? new Set()).add(barrelId),
        );
        asked.push(isPure(context, source));
      }
    }
    if ((await Promise.all(asked)).includes(false)) return null;

    return { barrels: [...used.keys()], targets };
  }

  function invalidateImporters(barrelId: string) {
    const graph = server?.environments.client?.moduleGraph;
    for (const importer of importers.get(barrelId) ?? []) {
      for (const module of graph?.getModulesByFile(importer) ?? []) {
        graph?.invalidateModule(module);
      }
    }
    importers.delete(barrelId);
  }

  return {
    name: "fresh:barrel-imports",
    apply: "serve",
    enforce: "post",
    configureServer(devServer) {
      server = devServer;
    },
    applyToEnvironment(env) {
      return env.name === "client";
    },
    watchChange(id) {
      const stale = new Set<string>([id]);
      const queue = [id];
      while (queue.length > 0) {
        const current = queue.pop() as string;
        for (const graph of graphs) {
          for (const parent of graph.get(current) ?? []) {
            if (stale.has(parent)) continue;
            stale.add(parent);
            queue.push(parent);
          }
        }
      }
      const touched = new Set<string>();
      if (barrels.has(id)) touched.add(id);
      for (const source of stale) {
        if (!purity.has(source)) continue;
        purity.delete(source);
        for (const barrelId of droppedBy.get(source) ?? []) {
          touched.add(barrelId);
        }
      }
      for (const barrelId of touched) {
        barrels.delete(barrelId);
        invalidateImporters(barrelId);
      }
    },
    async transform(code, id) {
      if (id.includes("\0") || id.includes("?") || !SCRIPT.test(id)) return;
      if (!code.includes("import")) return;

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

        const resolved = await this.resolve(node.source.value, id);
        if (
          resolved === null || resolved.external ||
          resolved.id.includes("\0") || resolved.id.includes("?") ||
          !SCRIPT.test(resolved.id)
        ) {
          continue;
        }

        const picked = await pickTargets(
          this,
          resolved.id,
          // deno-lint-ignore no-explicit-any
          node.specifiers.map((specifier: any) =>
            readName(specifier.imported) as string
          ),
        );
        if (picked === null) continue;

        for (const barrelId of picked.barrels) {
          this.addWatchFile(barrelId);
          importers.set(
            barrelId,
            (importers.get(barrelId) ?? new Set()).add(id),
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
