import type { Plugin } from "vite";
import * as babel from "@babel/core";
import { cjsPlugin } from "./patches/commonjs.ts";
import { jsxComments } from "./patches/jsx_comment.ts";
import { inlineEnvVarsPlugin } from "./patches/inline_env_vars.ts";
import { removePolyfills } from "./patches/remove_polyfills.ts";
import { JS_REG, JSX_REG } from "../utils.ts";
import { codeEvalPlugin } from "./patches/code_eval.ts";

// @ts-ignore Workaround for https://github.com/denoland/deno/issues/30850
const { default: babelReact } = await import("@babel/preset-react");

export function patches(): Plugin {
  let isDev = false;

  return {
    name: "fresh:patches",
    sharedDuringBuild: true,
    config(_, env) {
      isDev = env.command === "serve";
    },
    applyToEnvironment() {
      return true;
    },
    transform: {
      filter: {
        id: JS_REG,
      },
      handler(code, id) {
        const isJsx = this.environment.config.consumer === "client" &&
          JSX_REG.test(id);

        // The patches below only touch CommonJS, `process`, `Deno.env`,
        // `import.meta.env`, `@jsx` comments and a few polyfill checks, so a
        // plain ES module without any of them would come back the same after
        // a full parse, print and source map.
        if (
          !isJsx &&
          /^\s*(?:import|export)\b/m.test(code) &&
          !/\brequire\s*\(|\bexports\b|__esModule|__dirname|__filename|\bprocess\b|\bDeno\b|import\.meta\.env|@jsx|typeof\s*\(?\s*(?:String\.fromCodePoint|Object\.(?:keys|create))/
            .test(code)
        ) {
          return;
        }

        const presets = [];
        if (isJsx) {
          presets.push([babelReact, {
            runtime: "automatic",
            importSource: "preact",
            development: isDev,
            throwIfNamespace: false,
          }]);
        }

        const env = isDev ? "development" : "production";

        const plugins: babel.PluginItem[] = [
          codeEvalPlugin(this.environment.config.consumer, env),
          cjsPlugin,
          removePolyfills,
          jsxComments,
          inlineEnvVarsPlugin(env, Deno.env.toObject()),
        ];

        const res = babel.transformSync(code, {
          filename: id,
          babelrc: false,
          compact: false,
          plugins,
          presets,
          sourceMaps: "both",
        });

        if (res?.code) {
          return {
            code: res.code,
            map: res.map,
          };
        }
      },
    },
  };
}
